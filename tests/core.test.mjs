import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createNetwork, demandFactor, EVENT, hourOfIndex, isWeekend } from "../js/network.js";
import { calibrateThreshold, contextCheck, createScorer, fitBaseline, METHOD, trainDetector, usual, withPrevious } from "../js/detect.js";
import { alertStream, averagePrecision, summarize } from "../js/metrics.js";
import {
  acknowledgeAlert,
  autoClearIncident,
  closeNoAction,
  createIncident,
  dispatchCrew,
  isWorkflowClosed,
  recordCrewReport,
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

test("weekday demand has morning and evening peaks; weekends start later", () => {
  const wd = Array.from({ length: 24 }, (_, h) => demandFactor(h, false));
  const we = Array.from({ length: 24 }, (_, h) => demandFactor(h, true));
  const min = wd.indexOf(Math.min(...wd));
  assert.ok(min >= 1 && min <= 4, `night minimum at ${min}`);
  assert.ok(wd[7] > wd[13] && wd[19] > wd[13], "weekday peaks above midday");
  assert.ok(Math.abs(wd.reduce((s, v) => s + v, 0) / 24 - 1) < 1e-9, "weekday mean 1");
  assert.ok(we[7] < wd[7] && we[10] > wd[10], "weekend morning peak is later");
  assert.equal(isWeekend(5), true); // day 0 is a Monday
  assert.equal(isWeekend(4), false);
});

test("timestamps are hourly network time (UTC)", () => {
  const rows = createNetwork({ seed: 1 }).run(30);
  assert.equal(rows[0].timestamp.toISOString(), "2026-01-05T00:00:00.000Z");
  assert.equal(hourOfIndex(25), 1);
});

test("perfect schedule: announced work appears in the readings while active", () => {
  const net = createNetwork({ seed: 3, schedule: { announced: 1, cancelled: 0, maxDelay: 0 } });
  const rows = net.run(24 * 20);
  const items = net.scheduleFor(Array.from({ length: 20 }, (_, d) => d));
  assert.ok(items.length > 0);
  for (const s of items) {
    const during = rows.filter((r) => r.zoneId === s.zoneId && r.index >= s.start && r.index < s.end);
    assert.ok(during.every((r) => r.truth.events.includes(s.type)), `${s.id} active in readings`);
  }
});

test("realistic schedule: some work is unannounced, some announced work is cancelled", () => {
  const net = createNetwork({ seed: 4, schedule: { announced: 0.5, cancelled: 0.5, maxDelay: 2 } });
  const rows = net.run(24 * 60);
  const announced = net.scheduleFor(Array.from({ length: 60 }, (_, d) => d));
  const cancelledShown = announced.filter((s) => !rows.some((r) => r.zoneId === s.zoneId && r.index >= s.start && r.index < s.end + 2 && r.truth.events.includes(s.type)));
  assert.ok(cancelledShown.length > 0, "some announced jobs never happen");
  const workHours = rows.filter((r) => r.truth.events.some((e) => e === EVENT.VALVE_WORK || e === EVENT.HYDRANT_TEST));
  const unannounced = workHours.filter((r) => !net.scheduledAt(r.zoneId, r.index, 2).length);
  assert.ok(unannounced.length > 0, "some work happens without announcement");
});

test("a leak runs until repaired or reported; its size is recorded for water loss", () => {
  const net = createNetwork({ seed: 5 });
  net.run(10);
  net.inject("Zone-02", EVENT.LEAK);
  const z = () => net.step().find((r) => r.zoneId === "Zone-02");
  const first = z();
  assert.equal(first.isLeak, 1);
  assert.ok(first.truth.leakFlow > 0 && first.truth.leakReportedAt > first.index);
  assert.ok(net.repairLeak("Zone-02"));
  assert.equal(z().isLeak, 0);
  assert.equal(net.repairLeak("Zone-02"), null);
});

test("leaks nobody detects end when customers report them", () => {
  const net = createNetwork({ seed: 9 });
  const rows = net.run(24 * 30);
  const ended = net.drainEnded();
  assert.ok(ended.length > 0 && ended.every((e) => e.reason === "customer report"));
  const ids = new Set(rows.filter((r) => r.isLeak).map((r) => r.truth.leakId));
  assert.ok(ended.every((e) => ids.has(e.leakId)));
});

test("the leaks-only network has no confounding events", () => {
  const rows = createNetwork({ seed: 11, confounders: false }).run(24 * 30);
  assert.ok(rows.flatMap((r) => r.truth.events).every((t) => t === EVENT.LEAK));
});

/* ---------- detection ---------- */

const NET = createNetwork({ seed: 21 });
const ROWS = NET.run(24 * 42);
const TRAIN = ROWS.filter((r) => r.day < 28);
const TEST = ROWS.filter((r) => r.day >= 28);
const CTX = (r) => ({ scheduled: NET.scheduledAt(r.zoneId, r.index, 1), weather: NET.weatherForDay(r.day) });
const MODEL = trainDetector(TRAIN, { contextFor: CTX });

test("baseline distinguishes weekdays and weekends and follows the daily pattern", () => {
  const b = fitBaseline(TRAIN).get("Zone-01");
  assert.ok(b.flowMed[7] > b.flowMed[3], "weekday morning above night");
  assert.ok(b.flowMed[24 + 7] < b.flowMed[7], "weekend 07:00 below weekday 07:00");
  assert.ok(b.b < 0, "pressure falls as flow rises");
  const row = TRAIN.find((r) => r.zoneId === "Zone-01" && r.weekend && r.hour === 10);
  assert.equal(usual(row, MODEL.baseline).flow, b.flowMed[34]);
});

test("training and calibration are deterministic and respect the budget on training data", () => {
  const again = trainDetector(TRAIN, { contextFor: CTX });
  assert.deepEqual(again.weights, MODEL.weights);
  assert.deepEqual(again.thresholds, MODEL.thresholds);
  for (const m of Object.values(METHOD)) {
    const s = summarize(alertStream(TRAIN, MODEL, m, { contextFor: CTX }), { zones: 8, hours: 28 * 24 });
    assert.ok(s.falseAlertsPerZoneWeek <= 0.5 + 1e-9, `${m} within budget on training`);
  }
});

test("a lower budget never gives a lower threshold", () => {
  const y = TRAIN.map((r) => r.isLeak);
  const t1 = calibrateThreshold(TRAIN, y, MODEL, METHOD.EWMA, { budget: 1, hours: 28 * 24 });
  const t2 = calibrateThreshold(TRAIN, y, MODEL, METHOD.EWMA, { budget: 0.25, hours: 28 * 24 });
  assert.ok(t2 >= t1);
});

test("a clear leak raises every method's alarm; a normal reading does not", () => {
  const base = TRAIN.find((r) => r.zoneId === "Zone-04" && r.hour === 3 && !r.weekend && !r.truth.events.length);
  const u = usual(base, MODEL.baseline);
  const normal = { ...base, flowLps: u.flow, pressurePsi: u.pressure };
  const leak = { ...base, flowLps: u.flow + 35, pressurePsi: u.pressure - 11 };
  for (const m of [METHOD.RULES, METHOD.EWMA, METHOD.ML]) {
    const s = createScorer(MODEL, m);
    for (let i = 0; i < 3; i += 1) assert.equal(s.next(normal).alarm, false, `${m} quiet on normal`);
    let alarm = false;
    for (let i = 0; i < 4; i += 1) alarm = s.next(leak).alarm;
    assert.equal(alarm, true, `${m} alarms on a sustained leak`);
  }
});

test("EWMA forgets: after a leak is repaired the alarm clears within a few hours", () => {
  const base = TRAIN.find((r) => r.zoneId === "Zone-04" && r.hour === 3 && !r.weekend);
  const u = usual(base, MODEL.baseline);
  const s = createScorer(MODEL, METHOD.EWMA);
  for (let i = 0; i < 48; i += 1) s.next({ ...base, flowLps: u.flow + 40, pressurePsi: u.pressure - 12 });
  let hours = 0;
  while (s.next({ ...base, flowLps: u.flow, pressurePsi: u.pressure }).alarm) hours += 1;
  assert.ok(hours <= 12, `cleared after ${hours} h`);
});

test("context check uses the published schedule, weather and the readings only", () => {
  const base = TRAIN.find((r) => r.zoneId === "Zone-04" && r.hour === 14 && !r.weekend);
  const u = usual(base, MODEL.baseline);
  const row = { zoneId: "Zone-04", hour: 14, weekend: false, flowLps: u.flow + 30, pressurePsi: u.pressure - 10 }; // no truth at all
  const item = { type: EVENT.VALVE_WORK, title: "Valve maintenance", note: "x" };
  assert.equal(contextCheck(row, MODEL.baseline, { scheduled: [item] }).reason, EVENT.VALVE_WORK);
  assert.equal(contextCheck(row, MODEL.baseline, { scheduled: [], weather: { id: "clear" } }), null);
  assert.equal(contextCheck({ ...row, flowLps: u.flow }, MODEL.baseline, {}).reason, "sensor");
});

test("detection and context code never read the simulator's truth", () => {
  for (const f of ["../js/detect.js", "../js/context.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/\.truth\b/.test(src), `${f} must not use .truth`);
  }
});

/* ---------- metrics ---------- */

test("alerts need consecutive alarm hours; water lost counts until the first alert", () => {
  // hours:       0 1 2 3 4 5 6 7 8 9
  const raised = [0, 1, 0, 1, 1, 1, 0, 1, 1, 0].map(Boolean);
  const leak = [0, 0, 0, 7, 7, 7, 7, 0, 0, 0];
  let run = 0;
  const stream = raised.map((r, i) => {
    run = r ? run + 1 : 0;
    return { row: { zoneId: "Z", index: i, isLeak: leak[i] ? 1 : 0, truth: { leakId: leak[i] || null, leakFlow: leak[i] ? 10 : 0 } }, score: r ? 1 : 0, raised: r, alert: run >= 2 };
  });
  const s = summarize(stream, { zones: 1, hours: 10 });
  assert.equal(s.leaksDetected, 1);
  assert.equal(s.medianHoursToDetect, 1); // leak from hour 3, alert at hour 4
  assert.equal(s.falseAlerts, 1); // hours 7–8
  assert.equal(s.waterTotalM3, 4 * 10 * 3.6);
  assert.equal(s.waterLostM3, 2 * 10 * 3.6); // hours 3 and 4: water runs until and during the alert hour
});

test("average precision is 1 for a perfect ranking", () => {
  assert.equal(averagePrecision([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);
});

test("withPrevious pairs readings per zone", () => {
  const p = withPrevious([{ zoneId: "A", i: 1 }, { zoneId: "B", i: 2 }, { zoneId: "A", i: 3 }]);
  assert.equal(p[0].prev, null);
  assert.equal(p[2].prev.i, 1);
});

/* ---------- workflow ---------- */

test("dispatch is one step and the crew's report closes the case", () => {
  const a = createIncident({ zoneId: "Zone-01", message: "m", risk: "critical", time: new Date(0), contextSummary: "" });
  dispatchCrew(a, 12);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.OPEN, "no dispatch before acknowledgement");
  acknowledgeAlert(a);
  dispatchCrew(a, 12);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.DISPATCHED);
  assert.ok(a.ticketId && a.crewArrivesAt === 12);
  recordCrewReport(a, true);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.CLOSED_REPAIRED);
  closeNoAction(a);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.CLOSED_REPAIRED, "closed cases stay closed");
});

test("a crew that finds nothing closes the case as a wasted trip", () => {
  const a = createIncident({ zoneId: "Zone-03", message: "m", risk: "critical", time: new Date(0), contextSummary: "" });
  acknowledgeAlert(a);
  dispatchCrew(a, 5);
  recordCrewReport(a, false);
  assert.equal(a.workflowStatus, WORKFLOW_STATUS.CLOSED_NOTHING);
  assert.ok(isWorkflowClosed(a.workflowStatus));
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
