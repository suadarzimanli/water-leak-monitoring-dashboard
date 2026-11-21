/**
 * Exports one zone-week of the demo network (seed from js/config.js) for the paper's example
 * figure: readings, usual values, true events and the alerts of each method.
 *   node evaluation/export_example.mjs  -> evaluation/example.json
 */
import { writeFileSync } from "node:fs";
import { SIM } from "../js/config.js";
import { createNetwork, EVENT } from "../js/network.js";
import { METHOD, trainDetector, usual } from "../js/detect.js";
import { alertStream } from "../js/metrics.js";

const SHOWN = [METHOD.RULES, METHOD.EWMA, METHOD.EWMA_CONTEXT, METHOD.ML_CONTEXT];

const net = createNetwork({ seed: SIM.seed });
const rows = net.run(SIM.historyDays * 24);
const contextFor = (r) => ({ scheduled: net.scheduledAt(r.zoneId, r.index, 1), weather: net.weatherForDay(r.day) });
const model = trainDetector(rows.filter((r) => r.day < SIM.trainDays), { contextFor });
const test = rows.filter((r) => r.day >= SIM.trainDays);

// the test-week zone with a leak and the most different look-alike event types
const zones = [...new Set(test.map((r) => r.zoneId))];
const score = (z) => {
  const ev = new Set(test.filter((r) => r.zoneId === z).flatMap((r) => r.truth.events));
  return (ev.has(EVENT.LEAK) ? 10 : 0) + ev.size;
};
const zoneId = zones.sort((a, b) => score(b) - score(a))[0];

// alerts are computed on the whole test week (all zones) so each scorer sees the same history as in the app
const alerts = {};
for (const m of SHOWN) {
  alerts[m] = alertStream(test, model, m, { contextFor })
    .filter((s) => s.row.zoneId === zoneId)
    .map((s) => (s.alert ? 1 : 0));
}
const zr = test.filter((r) => r.zoneId === zoneId);
const out = {
  seed: SIM.seed,
  zoneId,
  start: zr[0].timestamp.toISOString(),
  hours: zr.map((r) => r.index - zr[0].index),
  flow: zr.map((r) => r.flowLps),
  pressure: zr.map((r) => r.pressurePsi),
  usualFlow: zr.map((r) => usual(r, model.baseline).flow),
  usualPressure: zr.map((r) => usual(r, model.baseline).pressure),
  events: zr.map((r) => r.truth.events),
  announced: zr.map((r) => net.scheduledAt(r.zoneId, r.index, 0).length > 0),
  weather: zr.map((r) => net.weatherForDay(r.day).id),
  alerts,
};
writeFileSync(new URL("./example.json", import.meta.url), JSON.stringify(out));
console.log(`example: ${zoneId}, events`, [...new Set(out.events.flat())].join(", "), "| alert hours", Object.fromEntries(SHOWN.map((m) => [m, alerts[m].reduce((a, b) => a + b, 0)])));
