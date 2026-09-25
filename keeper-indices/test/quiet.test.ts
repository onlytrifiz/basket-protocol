import assert from "node:assert/strict";
import { test } from "node:test";

// config.ts refuses to load without these; nothing here touches the network.
process.env.RPC_URL ||= "http://127.0.0.1:1";
process.env.KEEPER_PRIVATE_KEY ||= "0x0000000000000000000000000000000000000000000000000000000000000001";
process.env.INDEX_FACTORY ||= "0x0000000000000000000000000000000000000001";
process.env.ETHERSCAN_API_KEY ||= "test";
process.env.IDLE_RECHECK_SEC = "1000";
process.env.IDLE_RECHECKS_PER_PASS = "2";

const q = await import("../src/quiet.js");

const T = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const fps = (entries: [number, string | null][]) => new Map(entries.map(([n, fp]) => [T(n).toLowerCase(), fp]));

test("the default is busy: a run that never reached an idle exit is not idle", () => {
  const t = q.beginTrace();
  q.endTrace();
  assert.equal(q.wasIdle(t, false), false);
});

test("any busy mark vetoes an idle exit, and so does a throw", () => {
  const a = q.beginTrace();
  q.markIdleExit();
  q.markBusy("a slice over its buy floor");
  q.endTrace();
  assert.equal(q.wasIdle(a, false), false);

  const b = q.beginTrace();
  q.markIdleExit();
  q.endTrace();
  assert.equal(q.wasIdle(b, true), false);
  assert.equal(q.wasIdle(b, false), true);
});

test("marks outside a run are ignored", () => {
  q.endTrace();
  q.markBusy("stray");
  q.markIdleExit();
  q.traceReady(5);
});

test("the soonest readyAt of a run is kept", () => {
  const t = q.beginTrace();
  q.traceReady(500);
  q.traceReady(300);
  q.traceReady(900);
  q.endTrace();
  assert.equal(t.nextReadyAt, 300);
});

test("skipped only when last idle AND the fingerprint is unchanged", () => {
  q.remember(T(1), "a", true, null, 100);
  q.remember(T(2), "a", false, null, 100); // last run busy
  q.remember(T(3), "a", true, null, 100); // fingerprint will move
  q.remember(T(4), null, true, null, 100); // fingerprint was unreadable
  // T(5): never run in this process
  const { plans } = q.plan([T(1), T(2), T(3), T(4), T(5)], fps([[1, "a"], [2, "a"], [3, "b"], [4, "a"], [5, "a"]]), 200);
  assert.equal(plans.get(T(1).toLowerCase())!.skip, true);
  assert.equal(plans.get(T(2).toLowerCase())!.skip, false);
  assert.equal(plans.get(T(3).toLowerCase())!.skip, false);
  assert.equal(plans.get(T(4).toLowerCase())!.skip, false);
  assert.equal(plans.get(T(5).toLowerCase())!.skip, false);
});

test("an unreadable fingerprint now means run, whatever was remembered", () => {
  q.remember(T(6), "a", true, null, 100);
  const { plans } = q.plan([T(6)], fps([[6, null]]), 200);
  assert.equal(plans.get(T(6).toLowerCase())!.skip, false);
});

test("a round coming due ends the skip at its readyAt, not after", () => {
  q.remember(T(7), "a", true, 300, 100);
  assert.equal(q.plan([T(7)], fps([[7, "a"]]), 299).plans.get(T(7).toLowerCase())!.skip, true);
  assert.equal(q.plan([T(7)], fps([[7, "a"]]), 300).plans.get(T(7).toLowerCase())!.skip, false);
});

test("overdue re-checks run oldest first, a bounded number per pass", () => {
  q.remember(T(10), "a", true, null, 50);
  q.remember(T(11), "a", true, null, 10);
  q.remember(T(12), "a", true, null, 30);
  q.remember(T(13), "a", true, null, 900); // not overdue at 1200 (recheck is 1000s)
  const ts = [T(10), T(11), T(12), T(13)];
  const { plans, rechecked } = q.plan(ts, fps([[10, "a"], [11, "a"], [12, "a"], [13, "a"]]), 1200);
  assert.equal(rechecked, 2);
  assert.equal(plans.get(T(11).toLowerCase())!.skip, false); // ranAt 10, oldest
  assert.equal(plans.get(T(12).toLowerCase())!.skip, false); // ranAt 30
  assert.equal(plans.get(T(10).toLowerCase())!.skip, true); // next pass
  assert.equal(plans.get(T(13).toLowerCase())!.skip, true);
});

test("a run busy only because a price did not arrive is price noise, nothing else is", () => {
  const a = q.beginTrace();
  q.markBusy(q.UNPRICED_HARVEST);
  q.markIdleExit();
  q.endTrace();
  assert.equal(q.wasIdle(a, false), false); // still not idle: it runs again next pass
  assert.equal(q.onlyPriceNoise(a, false), true);
  assert.equal(q.onlyPriceNoise(a, true), false); // a throw is never noise

  const b = q.beginTrace();
  q.markBusy(q.UNPRICED_BUY);
  q.markBusy("sent a transaction");
  q.markIdleExit();
  q.endTrace();
  assert.equal(q.onlyPriceNoise(b, false), false);

  const c = q.beginTrace();
  q.markBusy(q.UNPRICED_HARVEST);
  q.endTrace(); // never reached an idle exit
  assert.equal(q.onlyPriceNoise(c, false), false);
});
