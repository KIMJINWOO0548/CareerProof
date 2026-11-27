import test from "node:test";
import assert from "node:assert/strict";
import {eventMetadata, readBatch} from "../frontend/journal.js";

test("journal emits only enumerated metadata, including microdollar spend", () => {
  const state = {phase:"paused", iteration:2, spentUsd:0.003451, best:{text:"private"}};
  const event = {seq:9, type:"run_state", reason:"private", text:"private"};
  assert.deepEqual(eventMetadata(event, state), {seq:9,type:"run_state",reason:"none",phase:"paused",iteration:2,spentMicros:3451});
});

test("SSE replay skips heartbeat and duplicate deliveries and rejects a missing event", () => {
  const frame = n => "id: " + n + "\nevent: run_event\ndata: " + JSON.stringify({seq:n}) + "\n\n";
  assert.deepEqual(readBatch(": heartbeat\n\n" + frame(2) + frame(3), 2), [{seq:3}]);
  assert.throws(() => readBatch(frame(4), 2));
  assert.throws(() => readBatch(frame(3).replace("id: 3", "id: 4"), 2));
});
