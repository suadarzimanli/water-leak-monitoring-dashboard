/**
 * Exports one zone-week of the demo network (seed from js/config.js) for the paper's example
 * figure: readings, usual values, true events and the alerts of each method.
 *   node evaluation/export_example.mjs  -> evaluation/example.json
 */
import { writeFileSync } from "node:fs";
import { SIM } from "../js/config.js";
import { createNetwork, EVENT } from "../js/network.js";
import { METHOD, trainDetector } from "../js/detect.js";
import { alertStream } from "../js/metrics.js";

const net = createNetwork({ seed: SIM.seed });
const rows = net.run(SIM.historyDays * 24);
const model = trainDetector(rows.filter((r) => r.day < SIM.trainDays));
const test = rows.filter((r) => r.day >= SIM.trainDays);
const contextFor = (r) => ({ scheduled: net.scheduledAt(r.zoneId, r.index), weather: net.weatherForDay(r.day) });

// the test-week zone with the most different event types (a leak plus confounders)
const zones = [...new Set(test.map((r) => r.zoneId))];
const score = (z) => {
  const ev = new Set(test.filter((r) => r.zoneId === z).flatMap((r) => r.truth.events));
  return (ev.has(EVENT.LEAK) ? 10 : 0) + ev.size;
};
const zoneId = zones.sort((a, b) => score(b) - score(a))[0];
const zr = test.filter((r) => r.zoneId === zoneId);
const b = model.baseline.get(zoneId);
const alerts = {};
for (const m of [METHOD.RULES, METHOD.ML, METHOD.ML_CONTEXT]) {
  alerts[m] = alertStream(zr, model, m, { contextFor }).map((s) => (s.alert ? 1 : 0));
}
const out = {
  seed: SIM.seed,
  zoneId,
  start: zr[0].timestamp.toISOString(),
  hours: zr.map((r) => r.index - zr[0].index),
  flow: zr.map((r) => r.flowLps),
  pressure: zr.map((r) => r.pressurePsi),
  usualFlow: zr.map((r) => b.flowMed[r.hour]),
  usualPressure: zr.map((r) => b.presMed[r.hour]),
  events: zr.map((r) => r.truth.events),
  weather: zr.map((r) => net.weatherForDay(r.day).id),
  alerts,
};
writeFileSync(new URL("./example.json", import.meta.url), JSON.stringify(out));
console.log(`example: ${zoneId}, events`, [...new Set(out.events.flat())].join(", "));
