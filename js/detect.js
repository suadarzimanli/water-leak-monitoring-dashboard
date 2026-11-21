/**
 * Leak detection on hourly zone readings.
 *
 * Baseline: per zone and hour of day, the median flow and pressure of the training period
 * (medians are robust to the few hours with leaks), plus a per-zone linear relation between flow
 * and pressure. A leak shows as more flow than usual AND less pressure than that flow explains.
 *
 * Methods
 *   rules       flow and pressure both ≥ 2.5 robust standard deviations from the hourly baseline
 *   ml          logistic regression on deviation features (current and previous hour)
 *   ml_context  ml, but an alarm is set aside when information an operator has explains it:
 *               scheduled work in the zone, extra demand on a hot day with pressure that fits the
 *               flow, or low pressure without extra flow (likely a sensor problem)
 * Detectors never read `row.truth`; only training labels (`isLeak`) come from the simulator.
 */

export const METHOD = { RULES: "rules", ML: "ml", ML_CONTEXT: "ml_context" };
export const RULE_Z = 2.5;
/** Consecutive alarm hours before an incident opens. */
export const PERSISTENCE_HOURS = 2;

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

/** Fit hourly medians, robust scales and the flow–pressure relation per zone. */
export function fitBaseline(rows) {
  const byZone = new Map();
  for (const r of rows) {
    if (!byZone.has(r.zoneId)) byZone.set(r.zoneId, []);
    byZone.get(r.zoneId).push(r);
  }
  const baseline = new Map();
  for (const [zoneId, zr] of byZone) {
    const flowMed = new Array(24).fill(0);
    const presMed = new Array(24).fill(0);
    for (let h = 0; h < 24; h += 1) {
      const at = zr.filter((r) => r.hour === h);
      flowMed[h] = median(at.map((r) => r.flowLps));
      presMed[h] = median(at.map((r) => r.pressurePsi));
    }
    const fRes = zr.map((r) => r.flowLps - flowMed[r.hour]);
    const pRes = zr.map((r) => r.pressurePsi - presMed[r.hour]);
    // pressure ≈ a + b·flow, fitted on hourly medians (robust to event hours)
    const xs = flowMed;
    const ys = presMed;
    const mx = xs.reduce((a, b) => a + b, 0) / 24;
    const my = ys.reduce((a, b) => a + b, 0) / 24;
    let sxy = 0;
    let sxx = 0;
    for (let h = 0; h < 24; h += 1) {
      sxy += (xs[h] - mx) * (ys[h] - my);
      sxx += (xs[h] - mx) ** 2;
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

/** Standardised deviations of one reading from its zone baseline. */
export function deviations(row, baseline) {
  const z = baseline.get(row.zoneId);
  if (!z) return { zf: 0, zp: 0, zr: 0 };
  return {
    zf: (row.flowLps - z.flowMed[row.hour]) / z.flowScale, // + = more flow than usual for this hour
    zp: (z.presMed[row.hour] - row.pressurePsi) / z.presScale, // + = lower pressure than usual
    zr: (z.a + z.b * row.flowLps - row.pressurePsi) / z.resScale, // + = lower pressure than the flow explains
  };
}

const clip = (v) => Math.max(-8, Math.min(8, v));

export function featureVector(row, prev, baseline) {
  const d = deviations(row, baseline);
  const p = prev ? deviations(prev, baseline) : { zf: 0, zp: 0, zr: 0 };
  const angle = (2 * Math.PI * row.hour) / 24;
  return [1, clip(d.zf), clip(d.zp), clip(d.zr), clip(d.zf) * clip(d.zr) / 4, clip(p.zf), clip(p.zr), Math.sin(angle), Math.cos(angle)];
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
 * Deterministic and converges in a few iterations; classes are weighted so leaks and
 * non-leaks contribute equally.
 */
export function trainLogistic(pairs, baseline, { iterations = 25, l2 = 1e-2 } = {}) {
  const X = pairs.map(({ row, prev }) => featureVector(row, prev, baseline));
  const y = pairs.map(({ row }) => row.isLeak);
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

/** Solve A·x = b by Gaussian elimination with partial pivoting (A is small and symmetric). */
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

export function scoreML(row, prev, model) {
  return sigmoid(dot(model.weights, featureVector(row, prev, model.baseline)));
}

/** Rules score in [0,1]: 0.5 exactly at the rule threshold. */
export function scoreRules(row, baseline) {
  const d = deviations(row, baseline);
  return sigmoid(2 * (Math.min(d.zf, d.zp) - RULE_Z));
}

/** Threshold that maximises F1 on the given scores (ties: the higher threshold). */
export function bestThreshold(scores, labels) {
  const order = scores.map((s, i) => [s, labels[i]]).sort((a, b) => b[0] - a[0]);
  const totalPos = labels.reduce((a, b) => a + b, 0);
  let tp = 0;
  let fp = 0;
  let best = { f1: -1, threshold: 0.5 };
  for (let i = 0; i < order.length; i += 1) {
    if (order[i][1]) tp += 1;
    else fp += 1;
    if (i + 1 < order.length && order[i + 1][0] === order[i][0]) continue;
    const precision = tp / (tp + fp);
    const recall = totalPos ? tp / totalPos : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > best.f1) best = { f1, threshold: order[i][0] };
  }
  return best.threshold;
}

/** Fit baseline and model on training readings; the ML alarm threshold maximises F1 on them. */
export function trainDetector(trainRows) {
  const baseline = fitBaseline(trainRows);
  const pairs = withPrevious(trainRows);
  const weights = trainLogistic(pairs, baseline);
  const model = { baseline, weights };
  const scores = pairs.map(({ row, prev }) => scoreML(row, prev, model));
  model.threshold = Math.min(0.95, Math.max(0.05, bestThreshold(scores, pairs.map(({ row }) => row.isLeak))));
  return model;
}

/**
 * Operator-observable explanation for an abnormal reading, or null.
 * `scheduled` = maintenance items active in this zone now (from the published schedule).
 */
export function contextCheck(row, baseline, { scheduled = [], weather } = {}) {
  const d = deviations(row, baseline);
  if (scheduled.length) {
    const s = scheduled[0];
    return { reason: s.type, text: `${s.title} scheduled in this zone now — ${s.note}` };
  }
  if (weather?.id === "heat" && d.zf > 0 && d.zr < 1.5) {
    return { reason: "demand", text: "Hot day: demand is higher than usual, and pressure fits the higher flow (a leak would lower it further)." };
  }
  if (d.zp >= RULE_Z && d.zf < 1) {
    return { reason: "sensor", text: "Pressure is low but flow is normal — check the pressure sensor before dispatch." };
  }
  return null;
}

/** Evaluate one reading with the chosen method. */
export function evaluate(row, prev, model, method, context) {
  const baseline = model.baseline;
  const d = deviations(row, baseline);
  const rulesHit = d.zf >= RULE_Z && d.zp >= RULE_Z;
  let score;
  let alarm;
  if (method === METHOD.RULES || !model.weights) {
    score = scoreRules(row, baseline);
    alarm = rulesHit;
  } else {
    score = scoreML(row, prev, model);
    alarm = score >= model.threshold;
  }
  let explained = null;
  if (alarm && method === METHOD.ML_CONTEXT && model.weights && context) {
    explained = contextCheck(row, baseline, context);
  }
  return { score, alarm, explained, raised: alarm && !explained, rulesHit, deviations: d, method: method === METHOD.RULES || !model.weights ? METHOD.RULES : method };
}

/** Plain-language reasons for the zone inspector. */
export function explain(row, evaluation, model) {
  const z = model.baseline.get(row.zoneId);
  const d = evaluation.deviations;
  const expected = (z.a + z.b * row.flowLps).toFixed(1);
  const lines = [
    `Flow ${row.flowLps.toFixed(1)} L/s — usual at this hour ${z.flowMed[row.hour].toFixed(1)} L/s (${fmtZ(d.zf)}).`,
    `Pressure ${row.pressurePsi.toFixed(1)} psi — usual ${z.presMed[row.hour].toFixed(1)} psi; ${expected} psi expected for this flow (${fmtZ(d.zr)} below).`,
    evaluation.rulesHit ? "Rule triggered: high flow and low pressure together." : "Rule not triggered.",
    evaluation.method === METHOD.RULES
      ? `Rules score ${(evaluation.score * 100).toFixed(0)}%.`
      : `Model score ${(evaluation.score * 100).toFixed(0)}% (alarm at ${(model.threshold * 100).toFixed(0)}%).`,
  ];
  if (evaluation.explained) lines.push(`Set aside by context check: ${evaluation.explained.text}`);
  return lines;
}

function fmtZ(z) {
  return `${z >= 0 ? "+" : ""}${z.toFixed(1)} σ`;
}
