import test from "node:test";
import assert from "node:assert/strict";
import { RemoteRun } from "../frontend/remote-runs.js";

function sample(version = 1, phase = "paused", seq = 2) {
  return {id: "example", version, state: {phase, events: Array.from({length:seq}, (_,i) => ({seq:i+1}))}};
}

test("remote observations keep the editing base pinned after another tab writes", async () => {
  const run = new RemoteRun(sample(), () => {});
  run.observe(sample(3, "running"));
  assert.equal(run.version, 1);
  assert.equal(run.state.phase, "running");
  assert.equal(run.conflict, true);
  run.observe(sample(1));
  assert.equal(run.conflict, true);
  assert.equal(run.state.phase, "running");
  await assert.rejects(run.command("resume"), /현재 버전/);
});

test("a lost command response reuses the same command ID and credentials once", async t => {
  const run = new RemoteRun(sample(), () => {});
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({url, options: structuredClone(init)});
    if (requests.length === 1) throw new TypeError("lost");
    return Response.json(requests.length === 2 ? sample(1) : sample(2));
  });
  await run.command("resume", {confirmed:true}, "fake-key");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], requests[2]);
  assert.equal(requests[1].options.headers, undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body).baseVersion, 1);
  assert.equal(run.version, 2);
});

test("an absent process after a lost response never triggers a fresh dispatch", async t => {
  const run = new RemoteRun(sample(), () => {});
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (init.method === "POST") { attempts++; throw new TypeError("offline"); }
    return Response.json({error:"removed"}, {status:404});
  });
  await assert.rejects(run.command("resume"));
  assert.equal(attempts, 1);
  assert.equal(run.disconnected, true);
});

test("server CAS failure requires explicit reconciliation before another command", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({error:"버전 충돌", code:"stale_version"}, {status:409});
  });
  const run = new RemoteRun(sample(), () => {});
  await assert.rejects(run.command("edit"), {code:"stale_version"});
  await assert.rejects(run.command("edit"));
  assert.equal(calls, 1);
  assert.equal(run.conflict, true);
});
