/**
 * Simulation study for the Urban Leak Monitoring Dashboard.
 *
 *   node evaluation/run_experiments.mjs          confirmation networks (seeds 2001–2040) -> results.json, results.md
 *   node evaluation/run_experiments.mjs --dev    development networks (seeds 1–40), used while designing
 *
 * Each network: 42 days of hourly readings for 8 zones; days 1–28 train (baseline, model and
 * threshold calibration), days 29–42 test. Every method's threshold is calibrated on the training
 * period to the same false-alert budget (default 0.5 per zone-week, alert after 2 alarm hours).
 * Methods
 *   rules, ewma                   no labels (labels only to calibrate the threshold)
 *   ml                            logistic regression with exact leak labels
 *   ml_records                    the same with labels a utility would have: only the last 6 hours
 *                                 before each leak was reported
 *   ml_naive                      trained on a network without leak-like events
 *   *_context                     + operator-visible context check
 * Experiments: main comparison; false-alert budget sweep; persistence K = 1, 2, 3; reliability of
 * the published schedule; simulator sensitivity (noise, leak size, event rates).
 * Means over networks with 95% percentile-bootstrap intervals; differences paired by network.
 */
import { writeFileSync } from "node:fs";
import { createNetwork, EVENT } from "../js/network.js";
import { trainDetector } from "../js/detect.js";
import { alertStream, summarize } from "../js/metrics.js";
import { mulberry32 } from "../js/rng.js";

const DEV = process.argv.includes("--dev");
const SEEDS = DEV ? Array.from({ length: 40 }, (_, i) => i + 1) : Array.from({ length: 40 }, (_, i) => i + 2001);
const TRAIN_DAYS = 28;
const TEST_DAYS = 14;
const ZONES = 8;
const TEST_HOURS = TEST_DAYS * 24;
const MAIN = ["rules", "ewma", "ewma_context", "ml", "ml_context", "ml_records", "ml_records_context", "ml_naive"];
const CORE = ["rules", "ewma", "ewma_context", "ml", "ml_context"];
const BUDGETS = [0.25, 0.5, 1, 2];
const SCHEDULES = {
  perfect: { announced: 1, cancelled: 0, maxDelay: 0 },
  realistic: { announced: 0.9, cancelled: 0.05, maxDelay: 1 },
  poor: { announced: 0.75, cancelled: 0.1, maxDelay: 2 },
  unreliable: { announced: 0.5, cancelled: 0.2, maxDelay: 2 },
};
const SENSITIVITY = {
  base: {},
  noisier: { noiseFlow: 3.75, noisePressure: 1.05 },
  smallerLeaks: { leakScale: 0.7 },
  moreLookAlikes: { eventRateScale: 2 },
};

const recordLabels = (rows) => rows.map((r) => (r.isLeak && r.truth.leakReportedAt - r.index <= 6 ? 1 : 0));

/** Train the needed models on one network and score methods on its test period. */
function evaluateNetwork(seed, netOptions, { budget = 0.5, persistence = 2, methods = MAIN } = {}) {
  const net = createNetwork({ seed, ...netOptions });
  const rows = net.run((TRAIN_DAYS + TEST_DAYS) * 24);
  const train = rows.filter((r) => r.day < TRAIN_DAYS);
  const test = rows.filter((r) => r.day >= TRAIN_DAYS);
  const contextFor = (r) => ({ scheduled: net.scheduledAt(r.zoneId, r.index, 1), weather: net.weatherForDay(r.day) });
  const opts = { contextFor, budget, persistence };
  const mainMethods = methods.filter((m) => !m.startsWith("ml_records") && m !== "ml_naive");
  const models = { main: trainDetector(train, { ...opts, methods: mainMethods }) };
  if (methods.some((m) => m.startsWith("ml_records"))) models.records = trainDetector(train, { ...opts, labels: recordLabels(train), methods: ["ml", "ml_context"] });
  if (methods.includes("ml_naive")) {
    const naive = createNetwork({ seed, ...netOptions, confounders: false }).run(TRAIN_DAYS * 24);
    models.naive = trainDetector(naive, { contextFor: () => ({ scheduled: [], weather: null }), budget, persistence, methods: ["ml"] });
  }
  const out = {};
  for (const name of methods) {
    const [model, method] = name.startsWith("ml_records") ? [models.records, name.replace("ml_records", "ml")] : name === "ml_naive" ? [models.naive, "ml"] : [models.main, name];
    const stream = alertStream(test, model, method, { persistence, contextFor });
    out[name] = { ...summarize(stream, { zones: ZONES, hours: TEST_HOURS }), causes: falseAlertCauses(stream, net) };
  }
  return out;
}

/** What was going on at the start of each false alert (truth used only for this analysis). */
function falseAlertCauses(stream, net) {
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
          const planned = ev.find((e) => e === EVENT.VALVE_WORK || e === EVENT.HYDRANT_TEST);
          const announced = net.scheduledAt(s.row.zoneId, s.row.index, 1).length > 0;
          ep = { hadLeak: false, cause: planned ? `${planned}${announced ? "" : " (unannounced)"}` : ev[0] ?? `no event (${net.weatherForDay(s.row.day).id} day)` };
        }
        if (s.row.isLeak) ep.hadLeak = true;
      } else close();
    }
    close();
  }
  return causes;
}

const mean = (xs) => {
  const v = xs.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
function ci(xs, reps = 4000) {
  const v = xs.filter((x) => x != null && !Number.isNaN(x));
  if (v.length < 2) return [null, null];
  const rng = mulberry32(7);
  const m = [];
  for (let r = 0; r < reps; r += 1) {
    let s = 0;
    for (let i = 0; i < v.length; i += 1) s += v[Math.floor(rng() * v.length)];
    m.push(s / v.length);
  }
  m.sort((a, b) => a - b);
  return [m[Math.floor(0.025 * reps)], m[Math.floor(0.975 * reps)]];
}
const KEYS = ["leakRecall", "falseAlertsPerZoneWeek", "waterSavedShare", "medianHoursToDetect", "precision", "recall", "ap"];
function aggregate(perSeed, methods) {
  const out = {};
  for (const m of methods) {
    const e = {};
    for (const k of KEYS) {
      const xs = perSeed.map((p) => p[m][k]);
      e[k] = { mean: mean(xs), ci: ci(xs) };
    }
    for (const k of ["leaks", "leaksDetected", "falseAlerts", "waterLostM3", "waterTotalM3"]) e[k] = perSeed.reduce((a, p) => a + p[m][k], 0);
    e.causes = {};
    for (const p of perSeed) for (const [c, n] of Object.entries(p[m].causes)) e.causes[c] = (e.causes[c] ?? 0) + n;
    out[m] = e;
  }
  return out;
}
function paired(perSeed, a, b, key) {
  const d = perSeed.map((p) => (p[a][key] == null || p[b][key] == null ? null : p[a][key] - p[b][key]));
  return { mean: mean(d), ci: ci(d) };
}

const t0 = Date.now();
const result = { seeds: [SEEDS[0], SEEDS[SEEDS.length - 1]], setup: { trainDays: TRAIN_DAYS, testDays: TEST_DAYS, zones: ZONES, defaultBudget: 0.5, persistence: 2, schedule: SCHEDULES.realistic } };

// 1. main comparison
const main = SEEDS.map((s) => evaluateNetwork(s, { schedule: SCHEDULES.realistic }));
result.main = aggregate(main, MAIN);
result.paired = {};
for (const [a, b] of [["ml_context", "ml"], ["ewma_context", "ewma"], ["ewma_context", "ml_context"], ["ml", "rules"], ["ewma", "rules"], ["ml_records", "ml"], ["ml", "ml_naive"], ["ewma_context", "rules"]]) {
  for (const k of ["leakRecall", "falseAlertsPerZoneWeek", "waterSavedShare"]) result.paired[`${a} − ${b} | ${k}`] = paired(main, a, b, k);
}

// 2. false-alert budget sweep
result.budgets = {};
for (const budget of BUDGETS) {
  result.budgets[budget] = budget === 0.5 ? Object.fromEntries(CORE.map((m) => [m, result.main[m]])) : aggregate(SEEDS.map((s) => evaluateNetwork(s, { schedule: SCHEDULES.realistic }, { budget, methods: CORE })), CORE);
}

// 3. persistence
result.persistence = { 2: Object.fromEntries(CORE.map((m) => [m, result.main[m]])) };
for (const k of [1, 3]) result.persistence[k] = aggregate(SEEDS.map((s) => evaluateNetwork(s, { schedule: SCHEDULES.realistic }, { persistence: k, methods: CORE })), CORE);

// 4. schedule reliability
result.schedules = {};
for (const [name, sch] of Object.entries(SCHEDULES)) {
  result.schedules[name] = name === "realistic" ? Object.fromEntries(CORE.map((m) => [m, result.main[m]])) : aggregate(SEEDS.map((s) => evaluateNetwork(s, { schedule: sch }, { methods: CORE })), CORE);
}

// 5. simulator sensitivity
result.sensitivity = {};
for (const [name, opt] of Object.entries(SENSITIVITY)) {
  result.sensitivity[name] = name === "base" ? Object.fromEntries(CORE.map((m) => [m, result.main[m]])) : aggregate(SEEDS.map((s) => evaluateNetwork(s, { schedule: SCHEDULES.realistic, ...opt }, { methods: CORE })), CORE);
}
result.runtimeSeconds = (Date.now() - t0) / 1000;
writeFileSync(new URL(DEV ? "./results-dev.json" : "./results.json", import.meta.url), JSON.stringify(result, null, 2));

// ---------- markdown ----------
const f = (x, d = 2) => (x == null ? "–" : x.toFixed(d));
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const iv = (e, d = 2) => `${f(e.mean, d)} [${f(e.ci[0], d)}, ${f(e.ci[1], d)}]`;
const cell = (e) => `${e.leaksDetected}/${e.leaks} · FA ${f(e.falseAlertsPerZoneWeek.mean)} · saved ${pct(e.waterSavedShare.mean)}`;
const L = [
  "# Simulation study results",
  "",
  `${SEEDS.length} networks (seeds ${SEEDS[0]}–${SEEDS[SEEDS.length - 1]}), ${ZONES} zones, train ${TRAIN_DAYS} days, test ${TEST_DAYS} days. Thresholds calibrated on training to 0.5 false alerts per zone-week; alert after 2 alarm hours; realistic schedule (90% of planned jobs announced, 5% of announced jobs cancelled, up to 1 h late).`,
  "",
  "## Main comparison",
  "",
  "| Method | Leaks detected | False alerts / zone-week | Water saved | Median hours to detect |",
  "|---|---:|---:|---:|---:|",
];
for (const m of MAIN) {
  const e = result.main[m];
  L.push(`| ${m} | ${e.leaksDetected}/${e.leaks} | ${iv(e.falseAlertsPerZoneWeek)} | ${pct(e.waterSavedShare.mean)} [${pct(e.waterSavedShare.ci[0])}, ${pct(e.waterSavedShare.ci[1])}] | ${f(e.medianHoursToDetect.mean, 1)} |`);
}
L.push("", "Paired differences (by network):", "");
for (const [k, v] of Object.entries(result.paired)) L.push(`- ${k}: ${iv(v, 3)}`);
L.push("", "False alerts by cause:", "");
for (const m of MAIN) L.push(`- ${m}: ${JSON.stringify(result.main[m].causes)}`);
const table = (title, rows) => {
  L.push("", `## ${title}`, "", "| | " + CORE.join(" | ") + " |", "|---|" + CORE.map(() => "---|").join(""));
  for (const [label, block] of rows) L.push(`| ${label} | ` + CORE.map((m) => cell(block[m])).join(" | ") + " |");
};
table("False-alert budget (per zone-week, set on training)", BUDGETS.map((b) => [b, result.budgets[b]]));
table("Persistence (alarm hours before an alert)", [1, 2, 3].map((k) => [k, result.persistence[k]]));
table("Reliability of the published schedule", Object.keys(SCHEDULES).map((s) => [`${s} ${JSON.stringify(SCHEDULES[s])}`, result.schedules[s]]));
table("Simulator sensitivity", Object.keys(SENSITIVITY).map((s) => [s, result.sensitivity[s]]));
L.push("", `(${result.runtimeSeconds.toFixed(0)} s)`);
writeFileSync(new URL(DEV ? "./results-dev.md" : "./results.md", import.meta.url), L.join("\n") + "\n");
console.log(L.join("\n"));
