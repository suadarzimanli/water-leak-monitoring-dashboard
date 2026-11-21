/**
 * Simulation study for the Urban Leak Monitoring Dashboard.
 *
 *   node evaluation/run_experiments.mjs            -> evaluation/results.json, evaluation/results.md
 *
 * For each of SEEDS independent networks: 42 days of hourly readings for 8 zones; days 0–27 train,
 * days 28–41 test. Methods (same test stream for all):
 *   rules         flow and pressure both ≥ 2.5 robust SD from the hourly baseline
 *   ml_naive      logistic regression trained on a network with leaks only (no scheduled work,
 *                 hydrant use, sensor drift or demand peaks), as in a training set without confounders
 *   ml            logistic regression trained on the full network
 *   ml_context    ml + context check using only operator-visible information (schedule, weather,
 *                 whether pressure fits the flow)
 * An alert needs K consecutive alarm hours (K = 1, 2, 3). Results are means over seeds with 95%
 * percentile-bootstrap intervals (resampling seeds); differences are paired by seed.
 */
import { writeFileSync } from "node:fs";
import { createNetwork, EVENT } from "../js/network.js";
import { METHOD, trainDetector } from "../js/detect.js";
import { alertStream, summarize } from "../js/metrics.js";
import { mulberry32 } from "../js/rng.js";

// Seeds 1–40 were used while designing the detectors (development). Reported results use
// confirmation seeds 1001–1040, which were not looked at before the design was fixed.
const SEEDS = process.argv.includes("--dev")
  ? Array.from({ length: 40 }, (_, i) => i + 1)
  : Array.from({ length: 40 }, (_, i) => i + 1001);
const TRAIN_DAYS = 28;
const TEST_DAYS = 14;
const ZONES = 8;
const PERSISTENCE = [1, 2, 3];
const METHODS = ["rules", "ml_naive", "ml", "ml_context"];

function runSeed(seed) {
  const net = createNetwork({ seed });
  const rows = net.run((TRAIN_DAYS + TEST_DAYS) * 24);
  const train = rows.filter((r) => r.day < TRAIN_DAYS);
  const test = rows.filter((r) => r.day >= TRAIN_DAYS);
  const model = trainDetector(train);
  const naiveNet = createNetwork({ seed, confounders: false });
  const naiveModel = trainDetector(naiveNet.run(TRAIN_DAYS * 24));
  const contextFor = (row) => ({ scheduled: net.scheduledAt(row.zoneId, row.index), weather: net.weatherForDay(row.day) });

  const out = {};
  for (const k of PERSISTENCE) {
    for (const m of METHODS) {
      const mdl = m === "ml_naive" ? naiveModel : model;
      const method = m === "rules" ? METHOD.RULES : m === "ml_context" ? METHOD.ML_CONTEXT : METHOD.ML;
      const stream = alertStream(test, mdl, method, { persistence: k, contextFor });
      out[`${m}|${k}`] = { ...summarize(stream, { zones: ZONES, hours: TEST_DAYS * 24 }), causes: falseAlertCauses(stream, net.weatherForDay) };
    }
  }
  const events = {};
  for (const r of test) for (const e of r.truth.events) events[e] = (events[e] ?? 0) + 1;
  return { seed, results: out, testEventHours: events, leakHourShare: test.reduce((a, r) => a + r.isLeak, 0) / test.length };
}

/** What was going on at the start of each false alert episode (truth used only for this analysis). */
function falseAlertCauses(stream, weatherForDay) {
  const causes = {};
  const byZone = new Map();
  for (const s of stream) {
    if (!byZone.has(s.row.zoneId)) byZone.set(s.row.zoneId, []);
    byZone.get(s.row.zoneId).push(s);
  }
  for (const list of byZone.values()) {
    let ep = null;
    const close = () => {
      if (ep && !ep.hadLeak) causes[ep.cause] = (causes[ep.cause] ?? 0) + 1;
      ep = null;
    };
    for (const s of list) {
      if (s.alert) {
        if (!ep) {
          const ev = s.row.truth.events.filter((e) => e !== EVENT.LEAK);
          ep = { hadLeak: false, cause: ev[0] ?? `no event (${weatherForDay(s.row.day).id} day)` };
        }
        if (s.row.isLeak) ep.hadLeak = true;
      } else close();
    }
    close();
  }
  return causes;
}

function mean(xs) {
  const v = xs.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function bootstrapCI(xs, reps = 4000, seed = 7) {
  const v = xs.filter((x) => x != null && !Number.isNaN(x));
  if (v.length < 2) return [null, null];
  const rng = mulberry32(seed);
  const means = [];
  for (let r = 0; r < reps; r += 1) {
    let s = 0;
    for (let i = 0; i < v.length; i += 1) s += v[Math.floor(rng() * v.length)];
    means.push(s / v.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * reps)], means[Math.floor(0.975 * reps)]];
}

const t0 = Date.now();
const perSeed = SEEDS.map(runSeed);
const keys = ["precision", "recall", "f1", "leakRecall", "medianHoursToDetect", "falseAlertsPerZoneWeek", "ap"];
const summary = {};
for (const k of PERSISTENCE) {
  for (const m of METHODS) {
    const id = `${m}|${k}`;
    const entry = {};
    for (const key of keys) {
      const xs = perSeed.map((p) => p.results[id][key]);
      entry[key] = { mean: mean(xs), ci: bootstrapCI(xs) };
    }
    const causes = {};
    for (const p of perSeed) for (const [c, n] of Object.entries(p.results[id].causes)) causes[c] = (causes[c] ?? 0) + n;
    entry.falseAlertCauses = causes;
    entry.leaks = perSeed.reduce((a, p) => a + p.results[id].leaks, 0);
    entry.leaksDetected = perSeed.reduce((a, p) => a + p.results[id].leaksDetected, 0);
    summary[id] = entry;
  }
}
const paired = {};
for (const k of PERSISTENCE) {
  for (const [a, b] of [["ml_context", "ml"], ["ml", "rules"], ["ml", "ml_naive"], ["ml_context", "rules"]]) {
    for (const key of ["f1", "falseAlertsPerZoneWeek", "leakRecall", "precision"]) {
      const d = perSeed.map((p) => {
        const x = p.results[`${a}|${k}`][key];
        const y = p.results[`${b}|${k}`][key];
        return x == null || y == null ? null : x - y;
      });
      paired[`${a}-${b}|${k}|${key}`] = { mean: mean(d), ci: bootstrapCI(d) };
    }
  }
}
const testHours = perSeed.reduce((a, p) => a + TEST_DAYS * 24 * ZONES, 0);
const result = {
  setup: { seeds: SEEDS.length, trainDays: TRAIN_DAYS, testDays: TEST_DAYS, zones: ZONES, testZoneHours: testHours },
  leakHourShare: mean(perSeed.map((p) => p.leakHourShare)),
  summary,
  paired,
  runtimeSeconds: (Date.now() - t0) / 1000,
};
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(result, null, 2));

const f = (x, d = 2) => (x == null ? "–" : x.toFixed(d));
const ci = (e, d = 2) => `${f(e.mean, d)} [${f(e.ci[0], d)}, ${f(e.ci[1], d)}]`;
const L = [
  "# Simulation study results",
  "",
  `${SEEDS.length} simulated networks (seeds ${SEEDS[0]}–${SEEDS[SEEDS.length - 1]}) × ${ZONES} zones; train ${TRAIN_DAYS} days, test ${TEST_DAYS} days per network (${testHours.toLocaleString("en")} test zone-hours). Leak hours: ${(result.leakHourShare * 100).toFixed(1)}% of test zone-hours.`,
  "Means over networks with 95% bootstrap intervals. False alerts = alert episodes with no leak, per zone-week.",
  "",
];
for (const k of PERSISTENCE) {
  L.push(`## Alert after ${k} consecutive alarm hour${k > 1 ? "s" : ""}`, "", "| Method | Precision | Recall (hours) | F1 | Leaks detected | Median hours to detect | False alerts / zone-week | AP |", "|---|---|---|---|---|---|---|---|");
  for (const m of METHODS) {
    const e = summary[`${m}|${k}`];
    L.push(`| ${m} | ${ci(e.precision)} | ${ci(e.recall)} | ${ci(e.f1)} | ${e.leaksDetected}/${e.leaks} | ${f(e.medianHoursToDetect.mean, 1)} | ${ci(e.falseAlertsPerZoneWeek)} | ${ci(e.ap)} |`);
  }
  L.push("", "False alerts by what was happening (all networks):", "");
  for (const m of METHODS) L.push(`- ${m}: ${JSON.stringify(summary[`${m}|${k}`].falseAlertCauses)}`);
  L.push("", "Paired differences (by network):", "");
  for (const [a, b] of [["ml_context", "ml"], ["ml", "rules"], ["ml", "ml_naive"], ["ml_context", "rules"]]) {
    L.push(`- ${a} − ${b}: F1 ${ci(paired[`${a}-${b}|${k}|f1`])}; precision ${ci(paired[`${a}-${b}|${k}|precision`])}; false alerts/zone-week ${ci(paired[`${a}-${b}|${k}|falseAlertsPerZoneWeek`])}; leak recall ${ci(paired[`${a}-${b}|${k}|leakRecall`])}`);
  }
  L.push("");
}
writeFileSync(new URL("./results.md", import.meta.url), L.join("\n") + "\n");
console.log(L.join("\n"));
console.log(`(${result.runtimeSeconds.toFixed(1)} s)`);
