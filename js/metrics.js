/**
 * Alarm-stream metrics shared by the app and the evaluation script.
 *
 * An alert is raised when a zone has `persistence` consecutive alarm hours; it stays raised while
 * alarms continue. Measures:
 *   hourly       precision / recall / F1 of alert hours against hours with an active leak
 *   leaks        leak events detected (an alert while the leak is active) and hours to detection
 *   falseAlerts  alert episodes during which no leak was active, per zone-week
 *   ap           average precision of the raw score (threshold-free)
 */
import { evaluate, withPrevious } from "./detect.js";

export function alertStream(rows, model, method, { persistence = 2, contextFor } = {}) {
  const run = new Map();
  return withPrevious(rows).map(({ row, prev }) => {
    const ev = evaluate(row, prev, model, method, contextFor ? contextFor(row) : undefined);
    const n = ev.raised ? (run.get(row.zoneId) ?? 0) + 1 : 0;
    run.set(row.zoneId, n);
    return { row, score: ev.score, raised: ev.raised, alert: n >= persistence };
  });
}

export function averagePrecision(scores, labels) {
  const order = scores.map((s, i) => [s, labels[i]]).sort((a, b) => b[0] - a[0]);
  const totalPos = labels.reduce((a, b) => a + b, 0);
  if (!totalPos) return null;
  let tp = 0;
  let ap = 0;
  for (let i = 0; i < order.length; i += 1) {
    if (order[i][1]) {
      tp += 1;
      ap += tp / (i + 1);
    }
  }
  return ap / totalPos;
}

export function summarize(stream, { zones, hours }) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of stream) {
    if (s.alert && s.row.isLeak) tp += 1;
    else if (s.alert) fp += 1;
    else if (s.row.isLeak) fn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : 0;

  // leak events and alert episodes, per zone in time order
  const leaks = new Map(); // leakId -> { first, detectedAt }
  let falseAlerts = 0;
  const byZone = new Map();
  for (const s of stream) {
    if (!byZone.has(s.row.zoneId)) byZone.set(s.row.zoneId, []);
    byZone.get(s.row.zoneId).push(s);
  }
  for (const list of byZone.values()) {
    let episode = null;
    for (const s of list) {
      const id = s.row.truth?.leakId;
      if (id != null && !leaks.has(id)) leaks.set(id, { first: s.row.index, detectedAt: null });
      if (id != null && s.alert && leaks.get(id).detectedAt == null) leaks.get(id).detectedAt = s.row.index;
      if (s.alert) {
        if (!episode) episode = { hadLeak: false };
        if (s.row.isLeak) episode.hadLeak = true;
      } else if (episode) {
        if (!episode.hadLeak) falseAlerts += 1;
        episode = null;
      }
    }
    if (episode && !episode.hadLeak) falseAlerts += 1;
  }
  const events = [...leaks.values()];
  const detected = events.filter((e) => e.detectedAt != null);
  const delays = detected.map((e) => e.detectedAt - e.first).sort((a, b) => a - b);
  return {
    precision,
    recall,
    f1,
    leaks: events.length,
    leaksDetected: detected.length,
    leakRecall: events.length ? detected.length / events.length : null,
    medianHoursToDetect: delays.length ? delays[(delays.length - 1) >> 1] : null,
    falseAlerts,
    falseAlertsPerZoneWeek: falseAlerts / ((zones * hours) / (24 * 7)),
    ap: averagePrecision(stream.map((s) => s.score), stream.map((s) => s.row.isLeak)),
  };
}
