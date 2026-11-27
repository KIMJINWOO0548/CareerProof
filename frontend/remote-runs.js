import { ensureSession } from "./journal.js";

const base = "/api/runs";

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "서버 실행을 확인하지 못했습니다."), {
    status: response.status, code: data.code,
  });
  return data;
}

function get(path, signal) {
  return fetch(base + path, {cache: "no-store", signal}).then(readResponse);
}

// Retry only the same command against a run still present in process memory.
// A restart removes it, so a connection loss cannot start a new paid run.
async function send(path, body, id, key) {
  const headers = {"Content-Type": "application/json", "X-CareerProof-Request": "1"};
  if (key) headers["X-LLM-API-Key"] = key;
  const options = {method: "POST", headers, body: JSON.stringify(body), cache: "no-store"};
  try {
    try { return await readResponse(await fetch(base + path, options)); }
    catch (error) {
      if (error.status) throw error;
      try { await get("/" + id + "?state=1"); }
      catch { throw new Error("서버 응답을 확인하지 못했습니다. 서버 작성 목록을 열어 실행 상태를 확인하세요."); }
      return await readResponse(await fetch(base + path, options));
    }
  } finally { delete headers["X-LLM-API-Key"]; }
}

export async function listRemoteRuns() {
  await ensureSession();
  return get("");
}

export async function openRemoteRun(id) {
  await ensureSession();
  return get("/" + encodeURIComponent(id));
}

export async function startRemoteRun(payload, key) {
  const id = crypto.randomUUID();
  await ensureSession();
  return send("", {...payload, runId: id, commandId: crypto.randomUUID(), confirmed: true}, id, key);
}

export function deleteRemoteRun(id, version) {
  return send("/" + id + "/delete", {commandId: crypto.randomUUID(), baseVersion: version}, id);
}

/** Local edits retain their published base version until an explicit reconciliation. */
export class RemoteRun {
  constructor(snapshot, changed) {
    this.id = snapshot.id;
    this.version = snapshot.version;
    this.observedVersion = snapshot.version;
    this.state = snapshot.state;
    this.changed = changed;
    this.busy = false;
    this.conflict = false;
    this.disconnected = false;
    this.missing = false;
    this.disposed = false;
    this.epoch = 0;
  }

  observe(snapshot) {
    if (this.disposed || snapshot.version < this.observedVersion ||
        (snapshot.version === this.observedVersion && snapshot.state.events.length < this.state.events.length)) return;
    this.observedVersion = snapshot.version;
    const conflict = this.conflict || snapshot.version > this.version;
    if (this.conflict === conflict && !this.disconnected && this.state.events.length === snapshot.state.events.length
        && this.state.phase === snapshot.state.phase) return;
    this.state = snapshot.state;
    this.conflict = conflict;
    this.disconnected = false;
    this.changed();
  }

  watch() {
    clearTimeout(this.timer);
    if (this.disposed || this.missing) return;
    this.timer = setTimeout(async () => {
      const epoch = this.epoch;
      try {
        if (!this.busy && !document.hidden) {
          this.reader = new AbortController();
          const latest = await get("/" + this.id + "?state=1", this.reader.signal);
          if (epoch === this.epoch) this.observe(latest);
        }
      } catch (error) {
        if (!this.disposed && epoch === this.epoch && error.name !== "AbortError") {
          this.disconnected = true;
          this.missing = error.status === 404;
          this.changed();
        }
      } finally {
        this.reader = null;
        this.watch();
      }
    }, ["idle","running","pausing"].includes(this.state.phase) ? 600 : 2200);
  }

  async command(kind, fields = {}, key) {
    if (this.busy || this.disposed || this.conflict || this.missing) throw new Error("서버 실행의 현재 버전을 먼저 확인하세요.");
    this.epoch++;
    this.reader?.abort();
    this.busy = true;
    this.changed();
    try {
      const command = {kind, ...fields, commandId: crypto.randomUUID(), baseVersion: this.version};
      const latest = await send("/" + this.id + "/commands", command, this.id, key);
      this.version = latest.version;
      this.observedVersion = latest.version;
      this.state = latest.state;
      this.disconnected = false;
      return latest;
    } catch (error) {
      if (error.status === 409) this.conflict = true;
      if (error.status === 404) this.missing = true;
      if (!error.status) this.disconnected = true;
      throw error;
    } finally {
      this.busy = false;
      if (!this.disposed) this.changed();
    }
  }

  dispose() {
    this.disposed = true;
    this.epoch++;
    clearTimeout(this.timer);
    this.reader?.abort();
  }
}
