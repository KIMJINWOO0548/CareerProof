// Only the whitelisted fields below can leave the editor through the journal.
const phaseNames = {idle:"대기", running:"진행 중", pausing:"일시 정지 요청", paused:"일시 정지", completed:"종료", cancelled:"취소"};
const eventNames = {run_state:"실행 상태", iteration_start:"생성 요청", best_updated:"추천본 갱신",
  gate_rejected:"후보 보류", budget_update:"사용액 확인", needs_user_input:"근거 보강 요청"};
const reasonNames = {none:"", user:"사용자 요청", target_reached:"목표 도달", max_iter:"횟수 한도",
  stagnated:"개선 정체", needs_user_input:"근거 보강 필요", user_stop:"사용자가 종료", cancelled:"사용자가 취소",
  key_required:"키 확인 필요", budget_limit:"예산 한도", invalid_request:"입력 확인 필요", provider_error:"제공자 오류",
  cost_unknown:"과금 미확인", length:"분량 제한", evidence:"근거 불일치", preservation:"필수 근거 누락",
  no_improvement:"개선 없음", invalid_candidate:"후보 형식 오류", settled:"사용량 정산", input_required:"서버 재시작 · 작업 JSON 복원 필요"};
const root = "/api/history";
let session;
const writers = new Set();

async function request(url, options = {}) {
  const response = await fetch(url, {cache:"no-store", ...options});
  if (!response.ok) {
    const error = new Error("실행 기록을 불러오지 못했습니다.");
    error.status = response.status;
    throw error;
  }
  return response;
}

function post(path, data = {}, signal) {
  return request(root + path, {
    method:"POST", headers:{"Content-Type":"application/json", "X-CareerProof-Request":"1"},
    body:JSON.stringify(data), signal,
  });
}

export function ensureSession() {
  if (!session) {
    const initialize = () => post("/session");
    const opening = navigator.locks ? navigator.locks.request("careerproof-history-session", initialize) : initialize();
    session = opening.catch(error => { session = null; throw error; });
  }
  return session;
}

export function eventMetadata(event, state) {
  return {
    seq:event.seq, type:event.type, phase:event.phase ?? state.phase,
    reason:Object.hasOwn(reasonNames, event.reason) ? event.reason : "none",
    iteration:event.iteration ?? state.iteration, spentMicros:Math.round(state.spentUsd * 1_000_000),
  };
}

export async function flushRunJournals() {
  await Promise.all([...writers].map(flush => flush()));
  if (writers.size) throw new Error("실행 기록 저장을 기다리고 있습니다. 잠시 후 다시 삭제하세요.");
}

export function createRunJournal() {
  const run = crypto.randomUUID();
  const pending = [];
  let observed = 0, opened = false, syncing = false, forgotten = false, failures = 0, timer;
  async function flush() {
    if (syncing || forgotten || !pending.length) return;
    clearTimeout(timer);
    syncing = true;
    try {
      await ensureSession();
      if (!opened) {
        await post("/" + run + "/open");
        opened = true;
      }
      while (pending.length) {
        const batch = pending.slice(0, 128);
        await post("/" + run + "/append", batch);
        pending.splice(0, batch.length);
      }
      writers.delete(flush);
      failures = 0;
    } catch (error) {
      if (opened && error.status === 404) {
        forgotten = true;
        writers.delete(flush);
      } else {
        if (error.status === 401) session = null;
        failures++;
        if (failures <= 3) timer = setTimeout(flush, 1000 * failures);
        document.querySelector("#history-status").textContent = "일부 기록의 저장을 기다리고 있습니다. 목록 새로고침으로 다시 시도할 수 있습니다.";
      }
    } finally {
      syncing = false;
    }
  }
  return {record(state) {
    if (forgotten) return;
    for (const event of state.events.slice(observed)) pending.push(eventMetadata(event, state));
    observed = state.events.length;
    if (pending.length) { writers.add(flush); void flush(); }
  }};
}

// The server returns complete UTF-8 SSE batches and a comment heartbeat on idle.
export function readBatch(body, after) {
  const rows = [];
  let cursor = after;
  for (const frame of body.replaceAll("\r\n", "\n").split("\n\n")) {
    const lines = frame.split("\n");
    const data = lines.find(line => line.startsWith("data: "));
    if (!data) continue;
    const row = JSON.parse(data.slice(6));
    if (!lines.includes("id: " + row.seq) || !Number.isSafeInteger(row.seq))
      throw new Error("잘못된 실행 기록 순번입니다.");
    if (row.seq <= cursor) continue;
    if (row.seq !== cursor + 1) throw new Error("실행 기록 순서가 일치하지 않습니다.");
    rows.push(row);
    cursor++;
  }
  return rows;
}

function mountHistory(panel) {
  const select = panel.querySelector("#history-select");
  const status = panel.querySelector("#history-status");
  const list = panel.querySelector("#history-events");
  const remove = panel.querySelector("#history-delete");
  let reading, listing;
  function stop() { reading?.abort(); listing?.abort(); }

  async function view() {
    reading?.abort();
    list.replaceChildren();
    if (!select.value) return;
    reading = new AbortController();
    const {signal} = reading;
    const path = "/" + select.value;
    let cursor = 0, ticket, retry = 0;
    while (!signal.aborted) {
      try {
        if (!ticket) ticket = (await (await post(path + "/ticket", {}, signal)).json()).token;
        const response = await request(root + path + "/events" + (cursor ? "?follow=1" : ""), {
          headers:{Authorization:"Bearer " + ticket, "Last-Event-ID":String(cursor)}, signal,
        });
        const rows = readBatch(await response.text(), cursor);
        if (signal.aborted) return;
        for (const row of rows) {
          const li = document.createElement("li");
          li.textContent = [row.iteration + "회차", eventNames[row.type], phaseNames[row.phase],
            reasonNames[row.reason], row.spentMicros ? "$" + (row.spentMicros / 1_000_000).toFixed(6) : ""].filter(Boolean).join(" · ");
          list.append(li);
          cursor = row.seq;
        }
        status.textContent = "마지막으로 기록한 이벤트 " + cursor + "개";
        retry = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error.status === 401 && ticket) { ticket = null; continue; }
        if ([403,404,409].includes(error.status) || ++retry > 3) {
          status.textContent = "기록 연결이 중단되었습니다. 목록을 새로고침하세요.";
          return;
        }
        status.textContent = "마지막 순번부터 다시 연결하고 있습니다.";
        await new Promise(resolve => setTimeout(resolve, retry * 500));
      }
    }
  }

  async function refresh() {
    stop();
    listing = new AbortController();
    const {signal} = listing;
    const previous = select.value;
    select.disabled = remove.disabled = true;
    list.replaceChildren();
    status.textContent = "기록을 읽고 있습니다.";
    try {
      await ensureSession();
      await Promise.all([...writers].map(flush => flush()));
      const {runs} = await (await request(root, {signal})).json();
      if (signal.aborted) return;
      select.replaceChildren(...runs.map(run => new Option(
        new Date(run.created * 1000).toLocaleString("ko-KR") + " · 마지막 상태 " + phaseNames[run.phase] + " · " + run.iteration + "회차",
        run.id)));
      if (runs.some(run => run.id === previous)) select.value = previous;
      select.disabled = remove.disabled = !runs.length;
      status.textContent = runs.length ? "" : "저장된 반복 작성 기록이 없습니다.";
      void view();
    } catch (error) {
      if (error.status === 401) session = null;
      if (!signal.aborted) status.textContent = "기록을 읽을 수 없습니다. 로컬 서버 연결을 확인하세요.";
    }
  }

  panel.addEventListener("toggle", () => { if (panel.open) void refresh(); else stop(); });
  panel.querySelector("#history-refresh").onclick = refresh;
  select.onchange = view;
  remove.onclick = async () => {
    const run = select.value;
    if (!run || !window.confirm("선택한 실행 기록을 이 기기에서 삭제할까요?")) return;
    stop();
    try { await post("/" + run + "/delete"); await refresh(); }
    catch { status.textContent = "기록을 삭제하지 못했습니다."; }
  };
}

if (typeof document !== "undefined") {
  const panel = document.querySelector("#run-history");
  if (panel) mountHistory(panel);
}
