import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNetwork, demandFactor, EVENT, hourOfIndex } from "../js/network.js";
import { contextCheck, evaluate, fitBaseline, METHOD, trainDetector, withPrevious } from "../js/detect.js";
import { alertStream, averagePrecision, summarize } from "../js/metrics.js";
import {
  acknowledgeAlert,
  autoClearIncident,
  closeAsFalseAlarm,
  closeAsLeak,
  createIncident,
  createTicket,
  dispatchCrew,
  isWorkflowClosed,
  WORKFLOW_STATUS,
} from "../js/workflow.js";

/* ---------- simulator ---------- */

test("same seed gives the same readings, schedule and weather", () => {
  const a = createNetwork({ seed: 7 }).run(24 * 5);
  const b = createNetwork({ seed: 7 }).run(24 * 5);
  assert.deepEqual(a.map((r) => [r.flowLps, r.pressurePsi, r.truth.events.join()]), b.map((r) => [r.flowLps, r.pressurePsi, r.truth.events.join()]));
  const c = createNetwork({ seed: 8 }).run(24 * 5);
  assert.notDeepEqual(a.map((r) => r.flowLps), c.map((r) => r.flowLps));
});

test("demand has a morning and an evening peak and a night minimum", () => {
  const f = Array.from({ length: 24 }, (_, h) => demandFactor(h));
  const min = f.indexOf(Math.min(...f));
  assert.ok(min >= 1 && min <= 4, `night minimum at ${min}`);
  assert.ok(f[7] > f[13] && f[19] > f[13], "peaks above midday");
  assert.ok(Math.abs(f.reduce((s, v) => s + v, 0) / 24 - 1) < 1e-9, "mean 1");
});

test("timestamps are hourly in network time (UTC), independent of the machine's time zone", () => {
  const rows = createNetwork({ seed: 1 }).run(30);
  assert.equal(rows[0].timestamp.toISOString(), "2026-01-05T00:00:00.000Z");
  assert.equal(hourOfIndex(25), 1);
  assert.equal(rows.filter((r) => r.zoneId === "Zone-01")[25].hour, 1);
});

test("scheduled work is published and appears in the readings while active", () => {
  const net = createNetwork({ seed: 3 });
  const rows = net.run(24 * 20);
  const items = net.scheduleFor(Array.from({ length: 20 }, (_, d) => d));
  assert.ok(items.length > 0, "some work scheduled in 20 days");
  for (const s of items) {
    const during = rows.filter((r) => r.zoneId === s.zoneId && r.index >= s.start && r.index < s.end);
    assert.ok(during.every((r) => r.truth.events.includes(s.type)), `${s.id} active in readings`);
  }
});

test("a leak persists until it is repaired", () => {
  const net = createNetwork({ seed: 5 });
  net.run(10);
  net.inject("Zone-02", EVENT.LEAK);
  const z = () => net.step().find((r) => r.zoneId === "Zone-02");
  assert.equal(z().isLeak, 1);
  assert.equal(z().isLeak, 1);
  assert.equal(net.repairLeak("Zone-02"), true);
  assert.equal(z().isLeak, 0);
});

test("the leaks-only network has no confounding events", () => {
  const rows = createNetwork({ seed: 11, confounders: false }).run(24 * 30);
  const types = new Set(rows.flatMap((r) => r.truth.events));
  assert.ok([...types].every((t) => t === EVENT.LEAK));
});

/* ---------- detection ---------- */

const NET = createNetwork({ seed: 21 });
const ROWS = NET.run(24 * 35);
const TRAIN = ROWS.filter((r) => r.day < 28);
const TEST = ROWS.filter((r) => r.day >= 28);
const MODEL = trainDetector(TRAIN);

test("baseline follows the daily pattern", () => {
  const b = fitBaseline(TRAIN).get("Zone-01");
  assert.ok(b.flowMed[7] > b.flowMed[3], "morning flow above night flow");
  assert.ok(b.presMed[7] < b.presMed[3], "pressure lower at peak demand");
  assert.ok(b.b < 0, "pressure falls as flow rises");
});

test("training is deterministic", () => {
  const again = trainDetector(TRAIN);
  assert.deepEqual(again.weights, MODEL.weights);
  assert.equal(again.threshold, MODEL.threshold);
  assert.ok(MODEL.threshold > 0.05 && MODEL.threshold < 0.95);
});

test("a clear leak reading triggers rules and model; a normal one does not", () => {
  const base = TRAIN.find((r) => r.zoneId === "Zone-04" && r.hour === 3 && !r.truth.events.length);
  const b = MODEL.baseline.get("Zone-04");
  const normal = { ...base, flowLps: b.flowMed[3], pressurePsi: b.presMed[3] };
  const leak = { ...base, flowLps: b.flowMed[3] + 35, pressurePsi: b.presMed[3] - 11 };
  assert.equal(evaluate(normal, normal, MODEL, METHOD.RULES).alarm, false);
  assert.equal(evaluate(leak, leak, MODEL, METHOD.RULES).alarm, true);
  assert.equal(evaluate(normal, normal, MODEL, METHOD.ML).alarm, false);
  assert.equal(evaluate(leak, leak, MODEL, METHOD.ML).alarm, true);
});

test("context check uses the published schedule, weather and the readings only", () => {
  const base = TRAIN.find((r) => r.zoneId === "Zone-04" && r.hour === 14);
  const b = MODEL.baseline.get("Zone-04");
  const row = { zoneId: "Zone-04", hour: 14, flowLps: b.flowMed[14] + 30, pressurePsi: b.presMed[14] - 10 }; // no truth field at all
  const item = { type: EVENT.VALVE_WORK, title: "Valve maintenance", note: "x" };
  assert.equal(contextCheck(row, MODEL.baseline, { scheduled: [item] }).reason, EVENT.VALVE_WORK);
  assert.equal(contextCheck(row, MODEL.baseline, { scheduled: [], weather: { id: "clear" } }), null);
  const sensor = { ...row, flowLps: b.flowMed[14], pressurePsi: b.presMed[14] - 10 };
  assert.equal(contextCheck(sensor, MODEL.baseline, {}).reason, "sensor");
  assert.ok(base);
});

test("detection and context code never read the simulator's truth", () => {
  for (const f of ["../js/detect.js", "../js/context.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/\.truth\b/.test(src), `${f} must not use .truth`);
  }
});

test("ML + context raises fewer false alerts than ML on held-out days", () => {
  const ctx = (r) => ({ scheduled: NET.scheduledAt(r.zoneId, r.index), weather: NET.weatherForDay(r.day) });
  const ml = summarize(alertStream(TEST, MODEL, METHOD.ML, { contextFor: ctx }), { zones: 8, hours: 7 * 24 });
  const mc = summarize(alertStream(TEST, MODEL, METHOD.ML_CONTEXT, { contextFor: ctx }), { zones: 8, hours: 7 * 24 });
  assert.ok(mc.falseAlerts <= ml.falseAlerts);
  assert.ok(mc.leaksDetected <= ml.leaksDetected);
});

/* ---------- metrics ---------- */

function fakeStream(zoneAlarms, leaks) {
  return zoneAlarms.map((raised, i) => ({ row: { zoneId: "Z", index: i, isLeak: leaks[i] ? 1 : 0, truth: { leakId: leaks[i] || null } }, score: raised ? 0.9 : 0.1, raised }));
}

test("alerts need consecutive alarm hours; false alerts are episodes without a leak", () => {
  const model = { baseline: new Map(), weights: null };
  assert.ok(model);
  // hours:        0 1 2 3 4 5 6 7 8 9
  const raised = [0, 1, 0, 1, 1, 1, 0, 1, 1, 0].map(Boolean);
  const leak = [0, 0, 0, 7, 7, 7, 7, 0, 0, 0];
  const run = { n: 0 };
  const stream = fakeStream(raised, leak).map((s) => {
    run.n = s.raised ? run.n + 1 : 0;
    return { ...s, alert: run.n >= 2 };
  });
  const s = summarize(stream, { zones: 1, hours: 10 });
  assert.equal(s.leaks, 1);
  assert.equal(s.leaksDetected, 1);
  assert.equal(s.medianHoursToDetect, 1); // leak from hour 3, alert at hour 4
  assert.equal(s.falseAlerts, 1); // hours 7–8 alert with no leak; hour 1 never became an alert
});

test("average precision is 1 for a perfect ranking", () => {
  assert.equal(averagePrecision([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);
  assert.ok(averagePrecision([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]) < 0.5);
});

test("withPrevious pairs readings per zone", () => {
  const rows = [{ zoneId: "A", i: 1 }, { zoneId: "B", i: 2 }, { zoneId: "A", i: 3 }];
  const p = withPrevious(rows);
  assert.equal(p[0].prev, null);
  assert.equal(p[2].prev.i, 1);
});

/* ---------- workflow ---------- */

test("workflow steps only advance in order", () => {
  const a = createIncident({ zoneId: "Zone-01", message: "m", risk: "critical", time: new Date(0), contextSummary: "" });
  createTicket(a);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.OPEN, "no ticket before acknowledgement");
  acknowledgeAlert(a);
  createTicket(a);
  dispatchCrew(a);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.DISPATCHED);
  closeAsLeak(a);
  assert.ok(isWorkflowClosed(a.workflowStatus));
  closeAsFalseAlarm(a);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.CLOSED_LEAK, "a closed case stays closed");
});

test("auto-clear only applies to untouched incidents", () => {
  const a = createIncident({ zoneId: "Zone-01", message: "m", risk: "critical", time: new Date(0), contextSummary: "" });
  const b = createIncident({ zoneId: "Zone-02", message: "m", risk: "critical", time: new Date(0), contextSummary: "" });
  acknowledgeAlert(b);
  autoClearIncident(a, 3);
  autoClearIncident(b, 3);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.CLOSED_AUTO);
  assert.equal(b.workflowStatus, WORKFLOW_STATUS.ACKNOWLEDGED);
});
