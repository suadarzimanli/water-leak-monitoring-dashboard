/**
 * Alarm-stream measures shared by the app and the evaluation script.
 *
 * An alert is raised when a zone has `persistence` consecutive alarm hours; it stays raised while
 * alarms continue. Measures (truth is read here only to score, never to detect):
 *   leaks           leak events detected (an alert while the leak is active) and hours to detection
 *   water           m³ lost from leaks up to and including the hour of their first alert (or until the end of the leak or of the
 *                   window if never alerted), against the total lost without any monitoring
 *   falseAlerts     alert episodes during which no leak was active (each one is a wasted crew trip)
 *   hourly          precision / recall of alert hours against hours with an active leak
 */
import { createScorer } from "./detect.js";
import { M3_PER_LPS_HOUR } from "./network.js";

export function alertStream(rows, model, method, { persistence = 2, contextFor } = {}) {
  const scorer = createScorer(model, method, contextFor);
  const run = new Map();
  return rows.map((row) => {
    const ev = scorer.next(row);
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

  const leaks = new Map(); // leakId -> { first, detectedAt, lostBefore, total }
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
      if (id != null) {
        if (!leaks.has(id)) leaks.set(id, { first: s.row.index, detectedAt: null, lost: 0, total: 0 });
        const L = leaks.get(id);
        const m3 = (s.row.truth.leakFlow ?? 0) * M3_PER_LPS_HOUR;
        L.total += m3;
        if (L.detectedAt == null) L.lost += m3; // water runs until the first alert
        if (s.alert && L.detectedAt == null) L.detectedAt = s.row.index;
      }
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
  const waterTotal = events.reduce((a, e) => a + e.total, 0);
  const waterLost = events.reduce((a, e) => a + e.lost, 0);
  return {
    precision,
    recall,
    f1: precision && recall ? (2 * precision * recall) / (precision + recall) : 0,
    leaks: events.length,
    leaksDetected: detected.length,
    leakRecall: events.length ? detected.length / events.length : null,
    medianHoursToDetect: delays.length ? delays[(delays.length - 1) >> 1] : null,
    waterTotalM3: waterTotal,
    waterLostM3: waterLost,
    waterSavedShare: waterTotal ? 1 - waterLost / waterTotal : null,
    falseAlerts,
    falseAlertsPerZoneWeek: falseAlerts / ((zones * hours) / (24 * 7)),
    ap: averagePrecision(stream.map((s) => s.score), stream.map((s) => s.row.isLeak)),
  };
}
