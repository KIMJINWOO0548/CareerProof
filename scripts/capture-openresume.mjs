// Run with an existing Playwright installation:
// node scripts/capture-openresume.mjs <fixture-dir> <new-capture-dir> <playwright-index.mjs>
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const parserUrl = 'https://www.open-resume.com/resume-parser';
const [fixtureDir, captureDir, playwrightEntry] = process.argv.slice(2);
if (!fixtureDir || !captureDir || !playwrightEntry) {
  throw new Error('Usage: node scripts/capture-openresume.mjs <fixture-dir> <new-capture-dir> <playwright-index.mjs>');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const manifestBytes = await readFile(join(fixtureDir, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.fictional !== true || manifest.fixture_source !== 'scripts/benchmark_pdf.py') {
  throw new Error('Use only the synthetic manifest from scripts/benchmark_pdf.py');
}

const fixtures = [];
for (const { id, filename, kind, sha256: expectedHash } of manifest.fixtures) {
  if (!/^\d{2}_[a-z_]+$/.test(id) || filename !== `${id}.pdf`) {
    throw new Error(`Invalid fixture name ${filename}`);
  }
  const bytes = await readFile(join(fixtureDir, filename));
  if (sha256(bytes) !== expectedHash) {
    throw new Error(`PDF hash mismatch for ${filename}`);
  }
  fixtures.push({ id, filename, kind, sha256: expectedHash, bytes });
}

// Fail if the output directory already exists so a prior transcript can't survive a failed capture.
await mkdir(captureDir);
const { chromium } = await import(pathToFileURL(resolve(playwrightEntry)));
const browser = await chromium.launch({ channel: 'chrome' });
const capture = {
  url: parserUrl,
  started_utc: new Date().toISOString(),
  browser: `Chrome ${browser.version()}`,
  manifest_sha256: sha256(manifestBytes),
  surface: 'Step 2. Group text items into lines, first exact Line Content column',
  network: 'Fresh browser context per PDF, default example warmed first, then HTTP(S) routes blocked and browser offline before choosing the local file',
  fixtures: [],
};
const lineCount = /At the end of step 2, the resume parser extracts (\d+) lines?\b/;

async function captureFixture({ id, filename, kind, sha256: expectedHash, bytes }) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const record = { id, filename, kind, sha256: expectedHash, started_utc: new Date().toISOString() };
  const parserAssets = new Set();
  const pageErrors = [];
  try {
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (response.ok() && url.origin === new URL(parserUrl).origin &&
          url.pathname.startsWith('/_next/static/chunks/app/resume-parser/') &&
          url.pathname.endsWith('.js')) {
        parserAssets.add(url.pathname);
      }
    });
    const response = await page.goto(parserUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (!response?.ok() || page.url() !== parserUrl) {
      throw new Error(`Parser navigation returned ${response?.status()} at ${page.url()}`);
    }
    const table = page.locator('table').filter({
      has: page.getByRole('columnheader', { name: 'Line Content', exact: true }),
    }).first();
    const demoCell = table.locator('td').first();
    await demoCell.waitFor({ timeout: 20_000 });
    const demoText = await table.innerText();

    await context.route(/^https?:\/\//, route => route.abort());
    await context.setOffline(true);
    if (await page.evaluate(() => navigator.onLine)) {
      throw new Error('Chrome did not report offline mode');
    }
    await page.locator('input[type=file]').setInputFiles({
      name: filename, mimeType: 'application/pdf', buffer: bytes,
    });
    await page.getByText(`${filename} -`, { exact: false }).waitFor({ timeout: 15_000 });
    await page.waitForFunction(({ demoText, countSource }) => {
      const stepTwo = [...document.querySelectorAll('table')].find(candidate =>
        [...candidate.querySelectorAll('th')].some(header => header.innerText.trim() === 'Line Content'));
      if (!stepTwo || stepTwo.innerText === demoText) return false;
      const countText = stepTwo.parentElement.previousElementSibling?.innerText;
      const count = countText?.match(new RegExp(countSource))?.[1];
      return count !== undefined && Number(count) === stepTwo.querySelectorAll('tbody tr').length;
    }, { demoText, countSource: lineCount.source }, { timeout: 15_000 });
    const lines = await table.locator('tbody tr').evaluateAll(rows => rows.map(row => row.cells[1].innerText));
    if (pageErrors.length) throw new Error('Uncaught browser error');

    const transcript = lines.length ? `${lines.join('\n')}\n` : '';
    await writeFile(join(captureDir, `${id}.txt`), transcript, { flag: 'wx' });
    record.status = !lines.length && kind === 'image_only' ? 'abstained' : 'observed';
    record.line_count = lines.length;
    record.transcript_sha256 = sha256(transcript);
  } catch (error) {
    record.status = 'unobserved';
    record.reason = error.message.split('\n')[0];
  } finally {
    record.parser_assets = [...parserAssets].sort();
    record.page_errors = pageErrors;
    await context.close();
  }
  return record;
}

try {
  for (const fixture of fixtures) {
    const record = await captureFixture(fixture);
    capture.fixtures.push(record);
    console.log(`${record.id}: ${record.status}${record.reason ? ` (${record.reason})` : ''}`);
  }
} finally {
  await browser.close();
  capture.finished_utc = new Date().toISOString();
  await writeFile(join(captureDir, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`);
}

if (capture.fixtures.some(fixture => fixture.status === 'unobserved')) process.exitCode = 1;
