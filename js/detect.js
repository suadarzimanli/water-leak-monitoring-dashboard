/**
 * Leak detection on hourly zone readings.
 *
 * Baseline: per zone, day type (weekday/weekend) and hour, the median flow and pressure of the
 * training period (robust to the few hours with events), plus a per-zone linear relation between
 * flow and pressure. A leak shows as more flow than usual AND less pressure than that flow explains.
 *
 * Methods (each has a score and a threshold)
 *   rules           score min(z_flow, z_pressure): flow up and pressure down together
 *   ewma            exponentially weighted moving average of the leak evidence (z_flow + z_residual)/2
 *                   (an EWMA control chart; needs no labels and forgets within a few hours)
 *   ml              logistic regression on deviation features (current and previous hour)
 *   *_context       the same alarm, set aside when information an operator has explains it:
 *                   announced work in the zone, extra demand on a hot day with pressure that fits
 *                   the flow, or low pressure without extra flow (likely a sensor problem)
 * Thresholds are calibrated on the training period to a common false-alert budget (alert episodes
 * without a leak, per zone-week), so methods are compared at the same operating point.
 * This module never reads `row.truth`; training labels are passed in by the caller.
 */

export const METHOD = {
  RULES: "rules",
  EWMA: "ewma",
  EWMA_CONTEXT: "ewma_context",
  ML: "ml",
  ML_CONTEXT: "ml_context",
};
export const BASE_METHOD = { rules: "rules", ewma: "ewma", ewma_context: "ewma", ml: "ml", ml_context: "ml" };
export const USES_CONTEXT = { ewma_context: true, ml_context: true };
/** Consecutive alarm hours before an alert (incident) opens. */
export const PERSISTENCE_HOURS = 2;
/** Default false-alert budget: one per zone every two weeks. */
export const FALSE_ALERT_BUDGET = 0.5;
/** EWMA smoothing: weight of the newest hour. */
export const EWMA_LAMBDA = 0.3;

const DEFAULT_THRESHOLD = { rules: 2.5, ewma: 2.0, ewma_context: 2.0, ml: 0.5, ml_context: 0.5 };
const MIN_SCALE_FLOW = 1.5;
const MIN_SCALE_PRESSURE = 0.5;

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(values, center) {
  return 1.4826 * median(values.map((v) => Math.abs(v - center)));
}

const slot = (row) => (row.weekend ? 24 : 0) + row.hour;

/** Fit hourly medians (weekday and weekend), robust scales and the flow–pressure relation per zone. */
export function fitBaseline(rows) {
  const byZone = new Map();
  for (const r of rows) {
    if (!byZone.has(r.zoneId)) byZone.set(r.zoneId, []);
    byZone.get(r.zoneId).push(r);
  }
  const baseline = new Map();
  for (const [zoneId, zr] of byZone) {
    const flowMed = new Array(48).fill(0);
    const presMed = new Array(48).fill(0);
    for (let s = 0; s < 48; s += 1) {
      let at = zr.filter((r) => slot(r) === s);
      if (!at.length) at = zr.filter((r) => r.hour === s % 24); // no weekend seen yet: fall back to all days
      flowMed[s] = median(at.map((r) => r.flowLps));
      presMed[s] = median(at.map((r) => r.pressurePsi));
    }
    const fRes = zr.map((r) => r.flowLps - flowMed[slot(r)]);
    const pRes = zr.map((r) => r.pressurePsi - presMed[slot(r)]);
    const mx = flowMed.reduce((a, b) => a + b, 0) / 48;
    const my = presMed.reduce((a, b) => a + b, 0) / 48;
    let sxy = 0;
    let sxx = 0;
    for (let s = 0; s < 48; s += 1) {
      sxy += (flowMed[s] - mx) * (presMed[s] - my);
      sxx += (flowMed[s] - mx) ** 2;
    }
    const b = sxx > 0 ? sxy / sxx : 0;
    const a = my - b * mx;
    const rRes = zr.map((r) => r.pressurePsi - (a + b * r.flowLps));
    baseline.set(zoneId, {
      flowMed,
      presMed,
      flowScale: Math.max(MIN_SCALE_FLOW, mad(fRes, median(fRes))),
      presScale: Math.max(MIN_SCALE_PRESSURE, mad(pRes, median(pRes))),
      a,
      b,
      resScale: Math.max(MIN_SCALE_PRESSURE, mad(rRes, median(rRes))),
    });
  }
  return baseline;
}

/** Usual flow and pressure for this reading's zone, day type and hour. */
export function usual(row, baseline) {
  const z = baseline.get(row.zoneId);
  return z ? { flow: z.flowMed[slot(row)], pressure: z.presMed[slot(row)] } : null;
}

/** Standardised deviations of one reading from its zone baseline. */
export function deviations(row, baseline) {
  const z = baseline.get(row.zoneId);
  if (!z) return { zf: 0, zp: 0, zr: 0 };
  return {
    zf: (row.flowLps - z.flowMed[slot(row)]) / z.flowScale, // + = more flow than usual
    zp: (z.presMed[slot(row)] - row.pressurePsi) / z.presScale, // + = lower pressure than usual
    zr: (z.a + z.b * row.flowLps - row.pressurePsi) / z.resScale, // + = lower pressure than the flow explains
  };
}

const clip = (v) => Math.max(-8, Math.min(8, v));

export function featureVector(row, prev, baseline) {
  const d = deviations(row, baseline);
  const p = prev ? deviations(prev, baseline) : { zf: 0, zp: 0, zr: 0 };
  const angle = (2 * Math.PI * row.hour) / 24;
  return [1, clip(d.zf), clip(d.zp), clip(d.zr), (clip(d.zf) * clip(d.zr)) / 4, clip(p.zf), clip(p.zr), Math.sin(angle), Math.cos(angle)];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const dot = (w, x) => w.reduce((s, wi, i) => s + wi * x[i], 0);

/** Pair each reading with the previous reading of the same zone. */
export function withPrevious(rows) {
  const last = new Map();
  return rows.map((r) => {
    const prev = last.get(r.zoneId) ?? null;
    last.set(r.zoneId, r);
    return { row: r, prev };
  });
}

/**
 * Class-weighted, L2-regularised logistic regression fitted by Newton's method (IRLS).
 * Deterministic and converges in a few iterations.
 */
export function trainLogistic(pairs, baseline, labels, { iterations = 25, l2 = 1e-2 } = {}) {
  const X = pairs.map(({ row, prev }) => featureVector(row, prev, baseline));
  const y = labels;
  const n = y.length;
  const k = X[0].length;
  const pos = y.reduce((a, b) => a + b, 0);
  const wPos = pos ? n / (2 * pos) : 1;
  const wNeg = n - pos ? n / (2 * (n - pos)) : 1;
  const w = new Array(k).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    const g = new Array(k).fill(0);
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < n; i += 1) {
      const p = sigmoid(dot(w, X[i]));
      const cw = y[i] ? wPos : wNeg;
      const r = cw * (p - y[i]);
      const s = cw * p * (1 - p);
      for (let a = 0; a < k; a += 1) {
        g[a] += r * X[i][a];
        for (let b = a; b < k; b += 1) H[a][b] += s * X[i][a] * X[i][b];
      }
    }
    for (let a = 0; a < k; a += 1) {
      for (let b = 0; b < a; b += 1) H[a][b] = H[b][a];
      if (a) {
        g[a] += l2 * n * w[a];
        H[a][a] += l2 * n;
      }
    }
    const step = solve(H, g);
    let change = 0;
    for (let a = 0; a < k; a += 1) {
      w[a] -= step[a];
      change = Math.max(change, Math.abs(step[a]));
    }
    if (change < 1e-6) break;
  }
  return w;
}

/** Solve A·x = b by Gaussian elimination with partial pivoting (A is small). */
function solve(A, b) {
  const k = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c += 1) {
    let piv = c;
    for (let r = c + 1; r < k; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < k; r += 1) {
      const f = M[r][c] / d;
      for (let j = c; j <= k; j += 1) M[r][j] -= f * M[c][j];
    }
  }
  const x = new Array(k).fill(0);
  for (let r = k - 1; r >= 0; r -= 1) {
    let s = M[r][k];
    for (let j = r + 1; j < k; j += 1) s -= M[r][j] * x[j];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

/**
 * Operator-observable explanation for an abnormal reading, or null.
 * `scheduled` = announced work in this zone around now (from the published schedule).
 */
export function contextCheck(row, baseline, { scheduled = [], weather } = {}) {
  const d = deviations(row, baseline);
  if (scheduled.length) {
    const s = scheduled[0];
    return { reason: s.type, text: `${s.title} announced in this zone around now — ${s.note}` };
  }
  if (weather?.id === "heat" && d.zf > 0 && d.zr < 1.5) {
    return { reason: "demand", text: "Hot day: demand is higher than usual, and pressure fits the higher flow (a leak would lower it further)." };
  }
  if (d.zp >= 2.5 && d.zf < 1) {
    return { reason: "sensor", text: "Pressure is low but flow is normal — check the pressure sensor before dispatch." };
  }
  return null;
}

/**
 * A stateful scorer for one method: call `next(row)` with readings in time order (any zone mix).
 * Keeps the previous reading and the EWMA statistic per zone. Without a trained model, ML
 * methods fall back to the rules.
 */
export function createScorer(model, method, contextFor) {
  const effective = !model.weights && BASE_METHOD[method] === "ml" ? METHOD.RULES : method;
  const base = BASE_METHOD[effective];
  const threshold = model.thresholds?.[effective] ?? DEFAULT_THRESHOLD[effective];
  const prev = new Map();
  const ewma = new Map();
  return {
    method: effective,
    threshold,
    next(row) {
      const d = deviations(row, model.baseline);
      // context is checked for every hour: explained hours add no leak evidence to the EWMA
      const context = USES_CONTEXT[effective] && contextFor ? contextCheck(row, model.baseline, contextFor(row)) : null;
      let score;
      if (base === "ml") score = sigmoid(dot(model.weights, featureVector(row, prev.get(row.zoneId) ?? null, model.baseline)));
      else if (base === "ewma") {
        const evidence = context ? 0 : (clip(d.zf) + clip(d.zr)) / 2;
        score = EWMA_LAMBDA * evidence + (1 - EWMA_LAMBDA) * (ewma.get(row.zoneId) ?? 0);
        ewma.set(row.zoneId, score);
      } else score = Math.min(d.zf, d.zp);
      prev.set(row.zoneId, row);
      const alarm = score >= threshold;
      const explained = alarm ? context : null;
      return { score, threshold, alarm, explained, raised: alarm && !explained, deviations: d, method: effective };
    },
    /** A known repair in the zone: forget its EWMA statistic and previous reading. */
    resetZone(zoneId) {
      ewma.delete(zoneId);
      prev.delete(zoneId);
    },
  };
}

/**
 * Lowest threshold whose training false-alert rate (alert episodes with no leak, per zone-week,
 * alert after `persistence` consecutive alarm hours) stays within `budget`.
 */
export function calibrateThreshold(rows, labels, model, method, { budget = FALSE_ALERT_BUDGET, persistence = PERSISTENCE_HOURS, contextFor, zones = 8, hours } = {}) {
  const scorer = createScorer({ ...model, thresholds: { [method]: -Infinity } }, method, contextFor);
  const scores = rows.map((r) => scorer.next(r).score);
  const explainable = USES_CONTEXT[method] && contextFor ? rows.map((r) => Boolean(contextCheck(r, model.baseline, contextFor(r)))) : rows.map(() => false);
  const zoneWeeks = (zones * hours) / (24 * 7);
  const falseRate = (t) => {
    const run = new Map();
    const episode = new Map();
    let falseAlerts = 0;
    rows.forEach((r, i) => {
      const raised = scores[i] >= t && !explainable[i];
      const n = raised ? (run.get(r.zoneId) ?? 0) + 1 : 0;
      run.set(r.zoneId, n);
      const ep = episode.get(r.zoneId);
      if (n >= persistence) {
        if (!ep) episode.set(r.zoneId, { hadLeak: Boolean(labels[i]) });
        else if (labels[i]) ep.hadLeak = true;
      } else if (ep) {
        if (!ep.hadLeak) falseAlerts += 1;
        episode.delete(r.zoneId);
      }
    });
    for (const ep of episode.values()) if (!ep.hadLeak) falseAlerts += 1;
    return falseAlerts / zoneWeeks;
  };
  const sorted = scores.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  const candidates = new Set();
  for (let q = 0.5; q < 0.9995; q += 0.0025) candidates.add(sorted[Math.floor(q * sorted.length)]);
  candidates.add(sorted[sorted.length - 1] + 1e-9);
  const ordered = [...candidates].sort((a, b) => a - b);
  for (const t of ordered) if (falseRate(t) <= budget) return t;
  return ordered[ordered.length - 1];
}

/**
 * Fit baseline and model on training readings and calibrate every method's threshold.
 *   labels     per-row 0/1 leak labels for the training rows (default: row.isLeak)
 *   contextFor operator context for a row (needed to calibrate the *_context methods)
 */
export function trainDetector(trainRows, { labels, contextFor, budget = FALSE_ALERT_BUDGET, persistence = PERSISTENCE_HOURS, zones = 8, methods = Object.values(METHOD) } = {}) {
  const y = labels ?? trainRows.map((r) => r.isLeak);
  const baseline = fitBaseline(trainRows);
  const weights = trainLogistic(withPrevious(trainRows), baseline, y);
  const model = { baseline, weights, thresholds: {} };
  const hours = new Set(trainRows.map((r) => r.index)).size;
  for (const m of methods) model.thresholds[m] = calibrateThreshold(trainRows, y, model, m, { budget, persistence, contextFor, zones, hours });
  return model;
}

/** Baseline-only model (before training): rules and EWMA with default thresholds. */
export function baselineModel(trainRows) {
  return { baseline: fitBaseline(trainRows), weights: null, thresholds: { ...DEFAULT_THRESHOLD } };
}

/** Plain-language reasons for the zone inspector. */
export function explain(row, evaluation, model) {
  const z = model.baseline.get(row.zoneId);
  const u = usual(row, model.baseline);
  const d = evaluation.deviations;
  const expected = (z.a + z.b * row.flowLps).toFixed(1);
  const day = row.weekend ? "weekend" : "weekday";
  const lines = [
    `Flow ${row.flowLps.toFixed(1)} L/s — usual for a ${day} at this hour ${u.flow.toFixed(1)} L/s (${fmtZ(d.zf)}).`,
    `Pressure ${row.pressurePsi.toFixed(1)} psi — usual ${u.pressure.toFixed(1)} psi; ${expected} psi expected for this flow (${fmtZ(d.zr)} below).`,
  ];
  const m = evaluation.method;
  if (m === METHOD.RULES) lines.push(`Rules: flow and pressure both at least ${evaluation.threshold.toFixed(1)} σ from usual — ${evaluation.alarm ? "met" : "not met"} (weaker of the two ${evaluation.score.toFixed(1)} σ).`);
  else if (BASE_METHOD[m] === "ewma") lines.push(`EWMA: smoothed leak evidence ${evaluation.score.toFixed(1)} σ (alarm at ${evaluation.threshold.toFixed(1)}).`);
  else lines.push(`Model alarm level ${evaluation.score.toFixed(2)} (alarm at ${evaluation.threshold.toFixed(2)}).`);
  if (evaluation.explained) lines.push(`Set aside by context check: ${evaluation.explained.text}`);
  return lines;
}

function fmtZ(z) {
  return `${z >= 0 ? "+" : ""}${z.toFixed(1)} σ`;
}
