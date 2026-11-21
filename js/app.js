import { PRESSURE_ZONES, zoneById } from "./zones.js";
import { getChartTheme, getThemeLabel, initTheme, THEMES, toggleTheme } from "./theme.js";
import { buildUserGuide } from "./user-guide.js";
import { APP_PHASE, SIM, SIMULATION_MS } from "./config.js";
import { createNetwork, EVENT, formatNetworkTime, hourOfIndex, HOUR_MS, M3_PER_LPS_HOUR, START_MS } from "./network.js";
import { BASE_METHOD, contextCheck, createScorer, explain, METHOD, PERSISTENCE_HOURS, trainDetector, usual } from "./detect.js";
import { alertStream, summarize } from "./metrics.js";
import { describeEvent, formatHourWindow, getTimeContext } from "./context.js";
import { createZoneMap } from "./map.js";
import { renderZoneChart } from "./charts.js";
import {
  acknowledgeAlert,
  autoClearIncident,
  closeNoAction,
  createIncident,
  dispatchCrew,
  getOpenIncidents,
  getWorkflowActions,
  isWorkflowClosed,
  recordCrewReport,
  WORKFLOW_LABELS,
  WORKFLOW_STATUS,
} from "./workflow.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtM3 = (v) => `${Math.round(v).toLocaleString("en-GB")} m³`;

const METHOD_LABEL = {
  [METHOD.RULES]: "Rules",
  [METHOD.EWMA]: "EWMA",
  [METHOD.EWMA_CONTEXT]: "EWMA + context",
  [METHOD.ML]: "ML",
  [METHOD.ML_CONTEXT]: "ML + context",
};
const NEEDS_MODEL = { [METHOD.ML]: true, [METHOD.ML_CONTEXT]: true };
const NO_OUTCOMES = () => ({ repaired: 0, wasted: 0, missed: 0, closedRight: 0, savedM3: 0 });

const state = {
  appPhase: APP_PHASE.IDLE,
  net: null,
  readings: [],
  latestByZone: new Map(),
  evalByZone: new Map(), // latest evaluation per zone
  zoneRuns: new Map(), // zoneId -> { alarm, normal }
  model: null,
  scorer: null,
  testSummary: {},
  selectedZoneId: null,
  selectedAlertId: null,
  simulationTimer: null,
  simulationSpeed: "normal",
  detectionMode: METHOD.ML_CONTEXT,
  incidents: [],
  systemLog: [],
  outcomes: NO_OUTCOMES(),
  activeSideTab: "zone",
  theme: THEMES.DARK,
  contextTabViewed: false,
  zoneInspectDone: false,
  guideSimStarted: false,
  guideResetDone: false,
};

const $ = (id) => document.getElementById(id);
const ui = {
  btnGenerate: $("btn-generate"),
  btnTrain: $("btn-train"),
  btnSimulate: $("btn-simulate"),
  btnStep: $("btn-step"),
  btnReset: $("btn-reset"),
  btnHelp: $("btn-help"),
  btnTheme: $("btn-theme"),
  btnGuideStart: $("btn-guide-start"),
  btnGuideStop: $("btn-guide-stop"),
  btnGuideRun: $("btn-guide-run"),
  btnGuideSkip: $("btn-guide-skip"),
  guideIdle: $("guide-idle"),
  guideBody: $("guide-body"),
  guideSteps: $("guide-steps"),
  guideProgress: $("guide-progress"),
  guideStepTitle: $("guide-step-title"),
  guideStepDuration: $("guide-step-duration"),
  guideLearn: $("guide-learn"),
  guideYouWillSee: $("guide-you-will-see"),
  btnClearAlerts: $("btn-clear-alerts"),
  detectionMode: $("detection-mode"),
  simSpeed: $("sim-speed"),
  helpModal: $("help-modal"),
  metricAtRisk: $("metric-at-risk"),
  metricOpen: $("metric-open"),
  metricOpenNote: $("metric-open-note"),
  metricCrews: $("metric-crews"),
  metricRepaired: $("metric-repaired"),
  metricRepairedNote: $("metric-repaired-note"),
  comparisonBody: $("comparison-body"),
  comparisonNote: $("comparison-note"),
  scenarioHint: $("scenario-hint"),
  networkTime: $("network-time"),
  mapStatus: $("map-status"),
  mapSummary: $("map-summary"),
  zoneTitle: $("zone-title"),
  zoneStatus: $("zone-status"),
  zoneDetails: $("zone-details"),
  zoneContext: $("zone-context"),
  whyFlagged: $("why-flagged"),
  workflowSection: $("workflow-section"),
  workflowPanel: $("workflow-panel"),
  actionPlaceholder: $("action-placeholder"),
  alertListActive: $("alert-list-active"),
  alertListCloseout: $("alert-list-closeout"),
  decisionScore: $("decision-score"),
  activityLog: $("activity-log"),
  maintenanceList: $("maintenance-list"),
  zoneChart: $("zone-chart"),
};

const mapApi = createZoneMap("map", (zoneId) => selectZone(zoneId));

/* ---------------- detection state ---------------- */

function effectiveMethod() {
  return NEEDS_MODEL[state.detectionMode] && !state.model?.weights ? METHOD.EWMA_CONTEXT : state.detectionMode;
}

function contextFor(row) {
  return { scheduled: state.net.scheduledAt(row.zoneId, row.index, 1), weather: state.net.weatherForDay(row.day) };
}

/** Rebuild the scorer for the current method and replay the last two days so EWMA and alarm runs are warm. */
function rebuildScorer() {
  if (!state.model) return;
  state.scorer = createScorer(state.model, effectiveMethod(), contextFor);
  state.evalByZone = new Map();
  state.zoneRuns = new Map();
  const from = state.net.hourIndex - 48;
  for (const row of state.readings) if (row.index >= from) updateZone(row, false);
}

/** Score one reading and update the zone's alarm runs; opens incidents only when `live`. */
function updateZone(row, live) {
  const ev = state.scorer.next(row);
  state.evalByZone.set(row.zoneId, ev);
  const runs = state.zoneRuns.get(row.zoneId) ?? { alarm: 0, normal: 0 };
  runs.alarm = ev.raised ? runs.alarm + 1 : 0;
  runs.normal = ev.alarm ? 0 : runs.normal + 1;
  state.zoneRuns.set(row.zoneId, runs);
  if (live) handleIncidents(row, ev, runs);
}

function getZoneEvaluation(zoneId) {
  const ev = state.evalByZone.get(zoneId);
  if (!ev) return { risk: "normal", label: "Normal", score: 0, threshold: 1, alarm: false, raised: false, explained: null, method: effectiveMethod() };
  const run = state.zoneRuns.get(zoneId)?.alarm ?? 0;
  const risk = ev.raised && run >= PERSISTENCE_HOURS ? "critical" : ev.alarm ? "warning" : "normal";
  const label = risk === "critical" ? "Likely leak" : ev.explained ? "Explained by context" : risk === "warning" ? "Watch" : "Normal";
  return { ...ev, risk, label };
}

/* ---------------- helpers ---------------- */

function badgeClass(risk) {
  return risk === "critical" ? "badge-critical" : risk === "warning" ? "badge-warning" : "badge-normal";
}

const PRIORITY_RANK = { high: 0, standard: 1 };
function byPriority(a, b) {
  return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) || b.time - a.time;
}

function currentIndex() {
  return state.net ? state.net.hourIndex - 1 : 0;
}

function networkNow() {
  return state.latestByZone.get(PRESSURE_ZONES[0].id)?.timestamp ?? null;
}

function classifyOpenIncidents() {
  const open = getOpenIncidents(state.incidents).sort(byPriority);
  const activeOnMap = [];
  const awaitingCloseout = [];
  for (const incident of open) {
    if (getZoneEvaluation(incident.zoneId).risk !== "normal" || incident.workflowStatus === WORKFLOW_STATUS.DISPATCHED) activeOnMap.push(incident);
    else awaitingCloseout.push(incident);
  }
  return { activeOnMap, awaitingCloseout, open };
}

function getSelectedAlert() {
  return state.incidents.find((a) => a.id === state.selectedAlertId) ?? null;
}

/* ---------------- phase & selection ---------------- */

function setAppPhase(phase) {
  state.appPhase = phase;
  updateButtonStates();
}

function updateButtonStates() {
  const hasData = state.readings.length > 0;
  const hasModel = Boolean(state.model?.weights);
  const isLive = Boolean(state.simulationTimer);
  ui.btnTrain.disabled = !hasData || isLive;
  ui.btnSimulate.disabled = !hasData;
  ui.btnStep.disabled = !hasData || isLive;
  ui.btnGenerate.disabled = isLive;
  ui.detectionMode.disabled = !hasData;
  for (const opt of ui.detectionMode.options) opt.disabled = Boolean(NEEDS_MODEL[opt.value]) && !hasModel;
  ui.detectionMode.value = effectiveMethod();
  const canInject = hasData && Boolean(state.selectedZoneId);
  document.querySelectorAll("[data-scenario]").forEach((b) => (b.disabled = !canInject));
  ui.scenarioHint.textContent = !hasData ? "after loading data" : state.selectedZoneId ? `in ${state.selectedZoneId}` : "select a zone first";
  if (isLive) {
    ui.mapStatus.textContent = "Live";
    ui.mapStatus.className = "badge badge-warning";
  } else if (hasData) {
    ui.mapStatus.textContent = "Paused";
    ui.mapStatus.className = "badge badge-normal";
  } else {
    ui.mapStatus.textContent = "Ready";
    ui.mapStatus.className = "badge badge-neutral";
  }
}

function selectZone(zoneId) {
  state.selectedZoneId = zoneId;
  const openIncident = getOpenIncidents(state.incidents).find((a) => a.zoneId === zoneId);
  state.selectedAlertId = openIncident?.id ?? null;
  mapApi.focusZone(zoneId);
  renderAll();
}

function selectIncident(alertId) {
  const alert = state.incidents.find((a) => a.id === alertId);
  if (!alert) return;
  state.selectedAlertId = alert.id;
  state.selectedZoneId = alert.zoneId;
  setActiveSideTab("action");
  mapApi.focusZone(alert.zoneId);
  renderAll();
}

function setActiveSideTab(tabId) {
  state.activeSideTab = tabId;
  if (tabId === "context") state.contextTabViewed = true;
  document.querySelectorAll(".side-tab").forEach((btn) => {
    const on = btn.dataset.tab === tabId;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tabId}`));
}

/* ---------------- metrics, comparison, logs ---------------- */

function updateMetrics() {
  const flagged = PRESSURE_ZONES.filter((z) => getZoneEvaluation(z.id).risk !== "normal").length;
  const { open, awaitingCloseout } = classifyOpenIncidents();
  ui.metricAtRisk.textContent = String(flagged);
  ui.metricAtRisk.classList.toggle("alert", flagged > 0);
  ui.metricOpen.textContent = String(open.length);
  ui.metricOpenNote.textContent = awaitingCloseout.length ? `${awaitingCloseout.length} with normal readings again` : "";
  ui.metricCrews.textContent = String(open.filter((a) => a.workflowStatus === WORKFLOW_STATUS.DISPATCHED).length);
  const o = state.outcomes;
  ui.metricRepaired.textContent = String(o.repaired);
  ui.metricRepairedNote.textContent = o.repaired || o.wasted || o.missed ? `${o.wasted} wasted trip(s) · ${o.missed} found by customers` : "since monitoring started";
  const now = networkNow();
  ui.networkTime.textContent = now ? formatNetworkTime(now) : "—";
  ui.mapSummary.textContent = !state.readings.length
    ? `Click Load data to simulate ${SIM.historyDays} days of hourly readings for ${PRESSURE_ZONES.length} pressure zones.`
    : flagged === 0
      ? "All zones within their usual range on the latest readings."
      : flaggedSummary();
}

function flaggedSummary() {
  const risks = PRESSURE_ZONES.map((z) => getZoneEvaluation(z.id));
  const leaks = risks.filter((e) => e.risk === "critical").length;
  const explained = risks.filter((e) => e.risk !== "critical" && e.explained).length;
  const watch = risks.filter((e) => e.risk === "warning" && !e.explained).length;
  const parts = [];
  if (leaks) parts.push(`${leaks} likely leak${leaks > 1 ? "s" : ""}`);
  if (explained) parts.push(`${explained} explained by context`);
  if (watch) parts.push(`${watch} on watch`);
  return `${parts.join(" · ")} — select a marker to investigate.`;
}

function renderComparison() {
  const methods = [METHOD.RULES, METHOD.EWMA, METHOD.EWMA_CONTEXT, METHOD.ML, METHOD.ML_CONTEXT];
  if (!state.readings.length) {
    ui.comparisonBody.innerHTML = '<tr><td colspan="4" class="muted-cell">Load data to compare the detection methods on the test week.</td></tr>';
    ui.comparisonNote.textContent = "";
    return;
  }
  const current = effectiveMethod();
  ui.comparisonBody.innerHTML = methods
    .map((m) => {
      const s = state.testSummary[m];
      const cells = s
        ? `<td>${s.leaksDetected} / ${s.leaks}</td><td>${s.falseAlerts}</td><td>${s.waterSavedShare == null ? "–" : `${Math.round(s.waterSavedShare * 100)}%`}</td>`
        : '<td colspan="3" class="muted-cell">after Train model</td>';
      return `<tr class="${m === current ? "current" : ""}"><th scope="row">${esc(METHOD_LABEL[m])}${m === current ? ' <span class="tag tag-neutral">in use</span>' : ""}</th>${cells}</tr>`;
    })
    .join("");
  ui.comparisonNote.textContent = `Test week: days ${SIM.trainDays + 1}–${SIM.historyDays} of the demo network. Each method's threshold was set on days 1–${SIM.trainDays} to the same false-alert budget (one per zone every two weeks); an alert needs ${PERSISTENCE_HOURS} consecutive alarm hours.`;
}

function pushSystemLog(message) {
  state.systemLog.unshift({ message, time: networkNow() });
  state.systemLog = state.systemLog.slice(0, 40); // log only; incidents are kept separately
}

/* ---------------- incidents ---------------- */

function handleIncidents(row, ev, runs) {
  const zone = zoneById(row.zoneId);
  const open = getOpenIncidents(state.incidents).find((a) => a.zoneId === row.zoneId);
  if (open) {
    open.truth.leakSeen ||= Boolean(row.isLeak);
    row.truth.events.forEach((e) => open.truth.events.add(e));
    if (runs.normal >= SIM.autoClearHours && open.workflowStatus === WORKFLOW_STATUS.OPEN) {
      autoClearIncident(open, SIM.autoClearHours);
      revealOutcome(open, "auto");
    }
  } else if (ev.raised && runs.alarm >= PERSISTENCE_HOURS) {
    const weather = state.net.weatherForDay(row.day);
    const incident = createIncident({
      zoneId: zone.id,
      priority: zone.priority,
      message: `Likely leak — ${METHOD_LABEL[ev.method]}`,
      risk: "critical",
      time: row.timestamp,
      contextSummary: `${getTimeContext(row.hour).label}${row.weekend ? " (weekend)" : ""} · ${weather.label}`,
    });
    incident.truth = { leakSeen: Boolean(row.isLeak), events: new Set(row.truth.events) }; // hidden until closed
    state.incidents.unshift(incident);
    pushSystemLog(`Incident opened in ${zone.id} (${zone.name}).`);
  }
}

/** Crews whose report is due report what they find; leaks reported by customers are repaired. */
function processHourEnd() {
  const now = currentIndex();
  for (const a of getOpenIncidents(state.incidents)) {
    if (a.workflowStatus !== WORKFLOW_STATUS.DISPATCHED || a.crewArrivesAt > now) continue;
    const leak = state.net.repairLeak(a.zoneId);
    recordCrewReport(a, Boolean(leak));
    if (leak) {
      a.savedM3 = leak.dFlow * Math.max(0, leak.end - now) * M3_PER_LPS_HOUR;
      state.outcomes.savedM3 += a.savedM3;
    }
    revealOutcome(a, leak ? "repaired" : "nothing");
    pushSystemLog(`Crew report for ${a.zoneId}: ${leak ? "leak found and repaired" : "no leak found"}.`);
  }
  for (const e of state.net.drainEnded()) {
    state.outcomes.missed += 1;
    pushSystemLog(`Customers reported a leak in ${e.zoneId}; it was repaired.`);
  }
}

/** Compare the outcome with the simulation truth, after the case is closed. */
function revealOutcome(incident, how) {
  const leak = incident.truth.leakSeen;
  const others = [...incident.truth.events].filter((e) => e !== EVENT.LEAK);
  const what = leak ? describeEvent(EVENT.LEAK) : others.length ? others.map(describeEvent).join(" and ") : "normal variation (no event)";
  let verdict;
  let good;
  if (how === "repaired") {
    good = true;
    verdict = `Right call — the crew repaired the leak${incident.savedM3 ? `, saving about ${fmtM3(incident.savedM3)} compared with waiting for customer reports` : ""}.`;
    state.outcomes.repaired += 1;
  } else if (how === "nothing") {
    good = false;
    verdict = "The crew found no leak: a wasted trip.";
    state.outcomes.wasted += 1;
  } else if (how === "noaction") {
    good = !leak;
    verdict = leak ? "A leak was present — it keeps running until customers report it." : "Right call — no field visit was needed.";
    if (good) state.outcomes.closedRight += 1;
  } else {
    good = !leak;
    verdict = leak ? "A leak was missed when the case cleared automatically." : "Clearing automatically was right.";
  }
  incident.outcome = { what, verdict, good };
}

/* ---------------- rendering ---------------- */

function renderMaintenanceList() {
  if (!state.net) {
    ui.maintenanceList.innerHTML = '<li class="context-empty">Load data to see the schedule.</li>';
    return;
  }
  const today = Math.floor(currentIndex() / 24);
  const items = state.net.scheduleFor([today, today + 1]).sort((a, b) => a.start - b.start);
  if (!items.length) {
    ui.maintenanceList.innerHTML = '<li class="context-empty">No work announced for today or tomorrow.</li>';
    return;
  }
  const now = currentIndex();
  ui.maintenanceList.innerHTML = items
    .map((s) => {
      const zone = zoneById(s.zoneId);
      const status = s.start <= now && now < s.end ? '<span class="tag tag-warning">now</span>' : s.end <= now ? '<span class="tag tag-neutral">done</span>' : "";
      const day = Math.floor(s.start / 24) === today ? "Today" : "Tomorrow";
      return `<li><strong>${esc(s.zoneId)}</strong> ${esc(zone?.name ?? "")} — ${esc(s.title)} ${status}
        <div class="context-sub">${day} ${formatHourWindow(s.start, s.end, hourOfIndex)}</div>
        <div class="context-sub">${esc(s.note)}</div></li>`;
    })
    .join("");
}

function renderActivityLog() {
  ui.activityLog.innerHTML = state.systemLog.length
    ? state.systemLog.slice(0, 12).map((l) => `<li><div>${esc(l.message)}</div><div class="alert-time">${l.time ? formatNetworkTime(l.time) : ""}</div></li>`).join("")
    : '<li class="alert-empty">System messages appear here.</li>';
}

function renderIncidentList(container, incidents, emptyMessage) {
  if (!incidents.length) {
    container.innerHTML = `<li class="alert-empty">${esc(emptyMessage)}</li>`;
    return;
  }
  container.innerHTML = "";
  for (const alert of incidents) {
    const li = document.createElement("li");
    li.className = [alert.risk, alert.id === state.selectedAlertId ? "selected" : ""].filter(Boolean).join(" ");
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    const prio = alert.priority === "high" ? '<span class="tag tag-danger">High priority</span> ' : "";
    li.innerHTML = `
      <div>${prio}<strong>${esc(alert.zoneId)}</strong> — ${esc(alert.message)}</div>
      <div class="alert-context">${esc(alert.contextSummary)}</div>
      <div class="alert-time">${formatNetworkTime(alert.time)} · ${esc(WORKFLOW_LABELS[alert.workflowStatus])}</div>`;
    li.addEventListener("click", () => selectIncident(alert.id));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectIncident(alert.id);
      }
    });
    container.appendChild(li);
  }
}

function renderAlerts() {
  const { activeOnMap, awaitingCloseout } = classifyOpenIncidents();
  renderIncidentList(ui.alertListActive, activeOnMap, "No open incidents.");
  renderIncidentList(ui.alertListCloseout, awaitingCloseout, "No incidents waiting for close-out.");
  const o = state.outcomes;
  ui.decisionScore.textContent = o.repaired + o.wasted + o.closedRight + o.missed
    ? `Repaired ${o.repaired} · wasted trips ${o.wasted} · found by customers ${o.missed}${o.savedM3 ? ` · water saved ≈ ${fmtM3(o.savedM3)}` : ""}`
    : "";
}

function renderWorkflowPanel() {
  const alert = getSelectedAlert();
  if (!alert) {
    ui.workflowSection.classList.add("hidden");
    ui.workflowPanel.innerHTML = "";
    ui.actionPlaceholder.classList.remove("hidden");
    return;
  }
  ui.actionPlaceholder.classList.add("hidden");
  ui.workflowSection.classList.remove("hidden");
  const closed = isWorkflowClosed(alert.workflowStatus);
  const actions = getWorkflowActions(alert.workflowStatus);
  const final = closed ? alert.workflowStatus : WORKFLOW_STATUS.CLOSED_REPAIRED;
  const steps = [WORKFLOW_STATUS.OPEN, WORKFLOW_STATUS.ACKNOWLEDGED, WORKFLOW_STATUS.DISPATCHED, final];
  const progress = closed ? 3 : { open: 0, acknowledged: 1, dispatched: 2 }[alert.workflowStatus] ?? 0;
  const stepHtml = steps
    .map((step, i) => `<div class="workflow-step ${i < progress || (closed && i === 3) ? "done" : ""} ${alert.workflowStatus === step ? "current" : ""}">${esc(WORKFLOW_LABELS[step])}</div>`)
    .join("");
  const primary = actions.primary ? `<button id="wf-primary" class="btn btn-primary" data-action="${actions.primary.id}">${esc(actions.primary.label)}</button>` : "";
  const secondary = actions.secondary.map((s) => `<button class="btn btn-ghost wf-secondary" data-action="${s.id}">${esc(s.label)}</button>`).join("");
  const eta = alert.workflowStatus === WORKFLOW_STATUS.DISPATCHED
    ? `<p class="workflow-hint">Crew report expected at ${esc(formatNetworkTime(new Date(START_MS + alert.crewArrivesAt * HOUR_MS)))} network time. Use “+1 hour” or run live.</p>`
    : "";
  const outcome = alert.outcome ? `<p class="outcome ${alert.outcome.good ? "outcome-ok" : "outcome-miss"}"><strong>Outcome:</strong> the simulation had ${esc(alert.outcome.what)}. ${esc(alert.outcome.verdict)}</p>` : "";
  ui.workflowPanel.innerHTML = `
    <h3>Operator workflow — ${esc(alert.zoneId)}</h3>
    ${actions.hint ? `<p class="workflow-hint">${esc(actions.hint)}</p>` : ""}
    <div class="workflow-steps">${stepHtml}</div>
    <div class="workflow-actions workflow-actions-primary">${primary}</div>
    <div class="workflow-actions">${secondary}</div>
    ${eta}
    ${alert.ticketId ? `<p class="ticket-id">Work order: <strong>${esc(alert.ticketId)}</strong></p>` : ""}
    ${outcome}
    <ul class="workflow-log">${alert.workflowLog.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
  if (!closed) {
    $("wf-primary")?.addEventListener("click", (e) => runWorkflowAction(e.currentTarget.dataset.action));
    document.querySelectorAll(".wf-secondary").forEach((btn) => btn.addEventListener("click", (e) => runWorkflowAction(e.currentTarget.dataset.action)));
  }
}

function runWorkflowAction(action) {
  const alert = getSelectedAlert();
  if (!alert || isWorkflowClosed(alert.workflowStatus)) return;
  const allowed = getWorkflowActions(alert.workflowStatus);
  if (![allowed.primary?.id, ...allowed.secondary.map((s) => s.id)].includes(action)) return;
  if (action === "ack") acknowledgeAlert(alert);
  else if (action === "dispatch") {
    dispatchCrew(alert, currentIndex() + SIM.crewHours);
    pushSystemLog(`Crew dispatched to ${alert.zoneId}; report in ${SIM.crewHours} network hours.`);
  } else if (action === "noaction") {
    closeNoAction(alert);
    revealOutcome(alert, "noaction");
  }
  renderAll();
}

function renderZoneContext(zone, row) {
  const time = getTimeContext(row.hour);
  const weather = state.net.weatherForDay(row.day);
  const today = Math.floor(row.index / 24);
  const schedule = state.net.scheduleFor([today]).filter((s) => s.zoneId === zone.id);
  const scheduleText = schedule.length
    ? schedule.map((s) => `${s.title} ${formatHourWindow(s.start, s.end, hourOfIndex)}${s.start - 1 <= row.index && row.index < s.end + 1 ? " (around now)" : ""}`).join("; ")
    : "None announced today";
  const ev = getZoneEvaluation(zone.id);
  const check = state.model ? contextCheck(row, state.model.baseline, contextFor(row)) : null;
  let title;
  let text;
  if (!ev.alarm) {
    title = "No alarm";
    text = "Readings are within the usual range for this hour.";
  } else if (check) {
    title = "Context explains the alarm";
    text = check.text;
  } else {
    title = "Nothing announced or in the weather explains this";
    text = "Treat as a possible leak: acknowledge, then dispatch a crew. Remember that not all work is announced.";
  }
  ui.zoneContext.innerHTML = `
    <h3>Operational context — ${esc(zone.id)}</h3>
    <p class="panel-hint">Only information an operator would have: time, weather, the published schedule and how the readings relate to each other.</p>
    <div class="context-grid">
      <div class="context-card"><span>Time</span><strong>${esc(formatNetworkTime(row.timestamp))} · ${esc(time.label)}${row.weekend ? " (weekend)" : ""}</strong><p>${esc(time.detail)}</p></div>
      <div class="context-card"><span>Weather today</span><strong>${esc(weather.label)}</strong><p>${esc(weather.impact)}</p></div>
      <div class="context-card"><span>Announced work in this zone</span><strong>${esc(scheduleText)}</strong><p>Jobs can start up to an hour late, and some are never announced.</p></div>
      <div class="context-card ${ev.alarm && check ? "context-highlight" : ""}"><span>Context check</span><strong>${esc(title)}</strong><p>${esc(text)}</p></div>
    </div>`;
}

function alarmLevelHtml(ev) {
  const isMl = BASE_METHOD[ev.method] === "ml";
  const fmt = (v) => (isMl ? v.toFixed(2) : `${v.toFixed(1)} σ`);
  const ratio = ev.threshold > 0 ? Math.max(0, Math.min(2, ev.score / ev.threshold)) : 0;
  return `<div class="detail-item alarm-level"><span>Alarm level · ${esc(METHOD_LABEL[ev.method])}</span>
    <strong>${fmt(Math.max(0, ev.score))}</strong><small>alarm at ${fmt(ev.threshold)}</small>
    <div class="level-bar" aria-hidden="true"><i style="width:${(ratio * 50).toFixed(0)}%"></i><b></b></div></div>`;
}

function renderWhyFlagged(zoneId, evaluation) {
  const row = state.latestByZone.get(zoneId);
  if (!row || !state.model || !evaluation.alarm) {
    ui.whyFlagged.classList.add("hidden");
    ui.whyFlagged.innerHTML = "";
    return;
  }
  const lines = explain(row, evaluation, state.model);
  const run = state.zoneRuns.get(zoneId)?.alarm ?? 0;
  if (evaluation.raised) lines.push(`Alarm for ${run} consecutive hour(s); an incident opens after ${PERSISTENCE_HOURS}.`);
  ui.whyFlagged.classList.remove("hidden");
  ui.whyFlagged.innerHTML = `<h4>Why flagged</h4><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
}

function renderSelectedZone() {
  const zoneId = state.selectedZoneId;
  if (!zoneId || !state.latestByZone.get(zoneId)) {
    ui.zoneContext.innerHTML = '<p class="placeholder-text">Operational context appears when a zone is selected.</p>';
    ui.whyFlagged.classList.add("hidden");
    return;
  }
  const zone = zoneById(zoneId);
  const row = state.latestByZone.get(zoneId);
  const ev = getZoneEvaluation(zoneId);
  const u = state.model ? usual(row, state.model.baseline) : null;
  ui.zoneTitle.textContent = `${zone.id} — ${zone.name}`;
  ui.zoneStatus.textContent = ev.label;
  ui.zoneStatus.className = `badge ${badgeClass(ev.risk)}`;
  ui.zoneDetails.innerHTML = `
    <div class="zone-meta">
      <span class="tag ${zone.priority === "high" ? "tag-danger" : "tag-neutral"}">${zone.priority === "high" ? "High priority" : "Standard priority"}</span>
      <span class="zone-note">${esc(zone.note)}</span>
    </div>
    <div class="detail-grid">
      <div class="detail-item"><span>Flow</span><strong>${row.flowLps.toFixed(1)} L/s</strong>${u ? `<small>usual ${u.flow.toFixed(1)}</small>` : ""}</div>
      <div class="detail-item"><span>Pressure</span><strong>${row.pressurePsi.toFixed(1)} psi</strong>${u ? `<small>usual ${u.pressure.toFixed(1)}</small>` : ""}</div>
      ${state.evalByZone.has(zoneId) ? alarmLevelHtml(ev) : ""}
    </div>`;
  renderZoneContext(zone, row);
  renderWhyFlagged(zoneId, ev);
  const history = state.readings.filter((r) => r.zoneId === zoneId).slice(-SIM.chartHours);
  renderZoneChart(ui.zoneChart, history, state.model ? (r) => usual(r, state.model.baseline) : null, getChartTheme());
  mapApi.setSelected(zoneId);
}

function refreshMap() {
  const today = Math.floor(currentIndex() / 24);
  const scheduled = new Set(state.net ? state.net.scheduleFor([today]).map((s) => s.zoneId) : []);
  for (const zone of PRESSURE_ZONES) {
    mapApi.setMarkerRisk(zone.id, getZoneEvaluation(zone.id).risk);
    mapApi.setMaintenanceBadge(zone.id, scheduled.has(zone.id));
  }
}

function renderAll() {
  refreshMap();
  updateMetrics();
  renderComparison();
  renderAlerts();
  renderActivityLog();
  renderMaintenanceList();
  renderSelectedZone();
  renderWorkflowPanel();
  updateButtonStates();
  renderUserGuidePanel();
  if (userGuide?.isActive?.()) userGuide.refresh();
}

/* ---------------- data, model, simulation ---------------- */

function ingest(rows, live) {
  for (const row of rows) {
    state.readings.push(row);
    state.latestByZone.set(row.zoneId, row);
    if (state.scorer) updateZone(row, live);
  }
}

function advanceHour() {
  ingest(state.net.step(), true);
  processHourEnd();
  renderAll();
}

function computeTestSummaries() {
  const test = state.readings.filter((r) => r.day >= SIM.trainDays && r.day < SIM.historyDays);
  const hours = (SIM.historyDays - SIM.trainDays) * 24;
  state.testSummary = {};
  for (const m of Object.values(METHOD)) {
    if (NEEDS_MODEL[m] && !state.model.weights) continue;
    state.testSummary[m] = summarize(alertStream(test, state.model, m, { persistence: PERSISTENCE_HOURS, contextFor }), { zones: PRESSURE_ZONES.length, hours });
  }
}

const trainRows = () => state.readings.filter((r) => r.day < SIM.trainDays);

function onGenerateData() {
  stopSimulation();
  Object.assign(state, {
    net: createNetwork({ seed: SIM.seed }),
    readings: [],
    latestByZone: new Map(),
    evalByZone: new Map(),
    zoneRuns: new Map(),
    model: null,
    scorer: null,
    incidents: [],
    outcomes: NO_OUTCOMES(),
    selectedAlertId: null,
  });
  ingest(state.net.run(SIM.historyDays * 24), false);
  state.net.drainEnded(); // leaks before monitoring started were reported by customers
  const model = trainDetector(trainRows(), { contextFor, methods: [METHOD.RULES, METHOD.EWMA, METHOD.EWMA_CONTEXT] });
  state.model = { ...model, weights: null }; // the ML model appears after Train model
  computeTestSummaries();
  rebuildScorer();
  setAppPhase(APP_PHASE.DATA_READY);
  pushSystemLog(`Simulated ${SIM.historyDays} days for ${PRESSURE_ZONES.length} zones; rules and EWMA calibrated on days 1–${SIM.trainDays}.`);
  selectZone(PRESSURE_ZONES[0].id);
}

function onTrainModel() {
  if (!state.readings.length) return;
  state.model = trainDetector(trainRows(), { contextFor });
  state.detectionMode = METHOD.ML_CONTEXT;
  computeTestSummaries();
  rebuildScorer();
  setAppPhase(APP_PHASE.MODEL_READY);
  const s = state.testSummary[METHOD.ML_CONTEXT];
  pushSystemLog(`ML model trained on days 1–${SIM.trainDays}. Test week (ML + context): ${s.leaksDetected}/${s.leaks} leaks, ${s.falseAlerts} false alerts.`);
  renderAll();
}

function stopSimulation() {
  if (state.simulationTimer) {
    clearInterval(state.simulationTimer);
    state.simulationTimer = null;
  }
  state.guideSimStarted = false;
  ui.btnSimulate.textContent = "Run live";
  ui.btnSimulate.classList.remove("btn-active");
  if (state.appPhase === APP_PHASE.LIVE) setAppPhase(state.model?.weights ? APP_PHASE.MODEL_READY : APP_PHASE.DATA_READY);
  updateButtonStates();
}

function startSimulation() {
  if (!state.net || state.simulationTimer) return;
  state.simulationTimer = setInterval(advanceHour, SIMULATION_MS[state.simulationSpeed] ?? SIMULATION_MS.normal);
  ui.btnSimulate.textContent = "Pause";
  ui.btnSimulate.classList.add("btn-active");
  setAppPhase(APP_PHASE.LIVE);
}

function onToggleSimulation() {
  if (state.simulationTimer) stopSimulation();
  else if (state.readings.length) startSimulation();
}

function resetDemo(options = {}) {
  if (!options.keepGuide && userGuide?.isActive()) userGuide.stop();
  stopSimulation();
  Object.assign(state, {
    net: null,
    readings: [],
    latestByZone: new Map(),
    evalByZone: new Map(),
    zoneRuns: new Map(),
    model: null,
    scorer: null,
    testSummary: {},
    incidents: [],
    systemLog: [],
    outcomes: NO_OUTCOMES(),
    selectedZoneId: null,
    selectedAlertId: null,
    detectionMode: METHOD.ML_CONTEXT,
    contextTabViewed: false,
    zoneInspectDone: false,
    guideSimStarted: false,
    guideResetDone: false,
  });
  mapApi.setSelected(null);
  ui.zoneTitle.textContent = "Zone inspector";
  ui.zoneStatus.textContent = "Select a zone";
  ui.zoneStatus.className = "badge badge-neutral";
  ui.zoneDetails.innerHTML = '<p class="placeholder-text">Click a marker or an incident. The map pans to your selection.</p>';
  ui.whyFlagged.classList.add("hidden");
  setAppPhase(APP_PHASE.IDLE);
  pushSystemLog("Demo reset — start with Load data.");
  renderAll();
}

const SCENARIO_LABEL = {
  [EVENT.LEAK]: "Leak started",
  [EVENT.HYDRANT_USE]: "Unscheduled hydrant use",
  [EVENT.VALVE_WORK]: "Valve work announced and started",
};

/** Demo control: start an event in the selected zone and advance two network hours. */
function injectScenario(type, zoneId = state.selectedZoneId) {
  if (!state.net || !zoneId) return;
  state.net.inject(zoneId, type);
  pushSystemLog(`${SCENARIO_LABEL[type] ?? type} in ${zoneId}.`);
  for (let i = 0; i < PERSISTENCE_HOURS; i += 1) {
    ingest(state.net.step(), true);
    processHourEnd();
  }
  state.selectedZoneId = zoneId;
  const open = getOpenIncidents(state.incidents).find((a) => a.zoneId === zoneId);
  state.selectedAlertId = open?.id ?? null;
  mapApi.focusZone(zoneId);
  setActiveSideTab(open ? "action" : "context");
  renderAll();
}

/* ---------------- user guide ---------------- */

function getScriptContext() {
  const { activeOnMap } = classifyOpenIncidents();
  return {
    appPhase: state.appPhase,
    hasData: state.readings.length > 0,
    hasModel: Boolean(state.model?.weights),
    hasSelection: Boolean(state.selectedZoneId),
    isLive: Boolean(state.simulationTimer),
    hasActiveIncident: activeOnMap.length > 0,
    hasOpenIncident: getOpenIncidents(state.incidents).length > 0,
    contextTabViewed: state.contextTabViewed,
    zoneInspectDone: state.zoneInspectDone,
    guideSimStarted: state.guideSimStarted,
    guideResetDone: state.guideResetDone,
    hasClosedNoAction: state.incidents.some((a) => a.workflowStatus === WORKFLOW_STATUS.CLOSED_NO_ACTION),
    hasCrewReport: state.incidents.some((a) => a.workflowStatus === WORKFLOW_STATUS.CLOSED_REPAIRED || a.workflowStatus === WORKFLOW_STATUS.CLOSED_NOTHING),
    skippedStepIds: userGuide?.getSkippedStepIds?.() ?? [],
  };
}

function selectFirstRiskyZone() {
  const risky = PRESSURE_ZONES.find((z) => getZoneEvaluation(z.id).risk !== "normal");
  if (!risky) return false;
  const open = getOpenIncidents(state.incidents).find((a) => a.zoneId === risky.id);
  if (open) selectIncident(open.id);
  else selectZone(risky.id);
  return true;
}

function setGuideMode(active) {
  document.body.classList.toggle("guide-mode-active", active);
}

function renderUserGuidePanel() {
  const steps = userGuide.getSteps();
  const current = userGuide.getCurrentStep();
  const running = userGuide.isActive();
  const complete = userGuide.getStatus() === "complete";
  ui.guideIdle.classList.toggle("hidden", running || complete);
  ui.guideBody.classList.toggle("hidden", !running && !complete);
  ui.btnGuideStart.classList.toggle("hidden", running);
  ui.btnGuideStop.classList.toggle("hidden", !running);
  if (!running && !complete) {
    ui.guideProgress.textContent = "Not started";
    return;
  }
  if (complete) {
    ui.guideProgress.textContent = "Guide complete";
    ui.guideStepTitle.textContent = "You're ready to explore";
    ui.guideStepDuration.textContent = "";
    ui.guideLearn.innerHTML = "<strong>What you learned:</strong> how readings, detection, context checks, dispatch decisions and crew reports fit together. Use <strong>Reset</strong> anytime to start over.";
    ui.guideYouWillSee.innerHTML = "<strong>Try next:</strong> compare the methods in the detection panel, select a zone and start a leak, or announce valve work and watch the context check.";
    ui.btnGuideRun.disabled = true;
    ui.btnGuideSkip.disabled = true;
    ui.guideSteps.innerHTML = "";
    return;
  }
  ui.guideProgress.textContent = `Step ${userGuide.getStepIndex() + 1} of ${steps.length}`;
  ui.guideSteps.innerHTML = steps
    .map((step, index) => {
      const done = userGuide.isStepCompleteAt(index);
      const cur = userGuide.isStepCurrent(index);
      const icon = done ? "✓" : cur ? "▶" : userGuide.isStepLocked(index) ? "○" : "·";
      const cls = [done ? "done" : "", cur ? "current" : "", userGuide.isStepLocked(index) ? "locked" : ""].filter(Boolean).join(" ");
      return `<li class="${cls}"><span class="user-guide-step-icon">${icon}</span><span>${esc(step.title)}</span></li>`;
    })
    .join("");
  if (current) {
    ui.guideStepTitle.textContent = current.title;
    ui.guideStepDuration.textContent = current.duration ?? "";
    ui.guideLearn.innerHTML = `<strong>What you'll learn:</strong> ${current.learn}`;
    ui.guideYouWillSee.innerHTML = `<strong>What you'll see:</strong> ${current.youWillSee}`;
  }
  const stepComplete = current && userGuide.isStepCompleteAt(userGuide.getStepIndex());
  ui.btnGuideRun.disabled = !userGuide.canRunCurrentAction() || stepComplete;
  ui.btnGuideRun.textContent = stepComplete ? "Done — continue below" : "Do this step";
  ui.btnGuideSkip.disabled = !current;
}

const userGuide = buildUserGuide({
  getContext: getScriptContext,
  onChange: () => renderUserGuidePanel(),
  onStart: () => {
    stopSimulation();
    Object.assign(state, { contextTabViewed: false, zoneInspectDone: false, guideSimStarted: false, guideResetDone: false });
    setGuideMode(true);
    renderUserGuidePanel();
  },
  onStop: () => {
    stopSimulation();
    setGuideMode(false);
    renderUserGuidePanel();
  },
  resetDemo: (options) => resetDemo(options ?? { keepGuide: true }),
  generateData: () => onGenerateData(),
  trainModel: () => onTrainModel(),
  startSimulation: () => startSimulation(),
  stopSimulation: () => stopSimulation(),
  selectFirstZone: () => selectZone(PRESSURE_ZONES[0].id),
  selectFirstRiskyZone: () => selectFirstRiskyZone(),
  setSideTab: (tab) => setActiveSideTab(tab),
  markContextViewed: () => (state.contextTabViewed = true),
  markZoneInspectDone: () => (state.zoneInspectDone = true),
  markGuideSimStarted: () => (state.guideSimStarted = true),
  markGuideResetDone: () => (state.guideResetDone = true),
  injectScenario: (type) => injectScenario(type, state.selectedZoneId ?? PRESSURE_ZONES[0].id),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  getSelectedIncident: () => getSelectedAlert(),
  getOpenIncidentsForWorkflow: () => getOpenIncidents(state.incidents),
  selectIncidentById: (id) => selectIncident(id),
  isIncidentClosed: (alert) => !alert || isWorkflowClosed(alert.workflowStatus),
  hasRiskyZone: () => PRESSURE_ZONES.some((z) => getZoneEvaluation(z.id).risk !== "normal"),
  runAction: (action) => runWorkflowAction(action),
  advanceHours: (n) => {
    for (let i = 0; i < n; i += 1) advanceHour();
  },
});

/* ---------------- events ---------------- */

document.querySelectorAll(".side-tab").forEach((btn) => btn.addEventListener("click", () => setActiveSideTab(btn.dataset.tab)));
ui.btnGenerate.addEventListener("click", onGenerateData);
ui.btnTrain.addEventListener("click", onTrainModel);
ui.btnSimulate.addEventListener("click", onToggleSimulation);
ui.btnStep.addEventListener("click", () => {
  if (state.net && !state.simulationTimer) advanceHour();
});
ui.btnReset.addEventListener("click", () => resetDemo());
ui.btnHelp.addEventListener("click", () => ui.helpModal.showModal());
ui.btnTheme.addEventListener("click", () => {
  state.theme = toggleTheme(state.theme);
  ui.btnTheme.textContent = getThemeLabel(state.theme);
  if (state.selectedZoneId) renderSelectedZone();
});
ui.btnGuideStart.addEventListener("click", () => userGuide.start());
ui.btnGuideStop.addEventListener("click", () => userGuide.stop());
ui.btnGuideRun.addEventListener("click", () => userGuide.runCurrentAction());
ui.btnGuideSkip.addEventListener("click", () => userGuide.skipCurrent());
ui.detectionMode.addEventListener("change", () => {
  state.detectionMode = ui.detectionMode.value;
  rebuildScorer();
  if (state.readings.length) pushSystemLog(`Detection: ${METHOD_LABEL[effectiveMethod()]}.`);
  renderAll();
});
ui.simSpeed.addEventListener("change", () => {
  state.simulationSpeed = ui.simSpeed.value;
  if (state.simulationTimer) {
    stopSimulation();
    startSimulation();
  }
});
document.querySelectorAll("[data-scenario]").forEach((btn) => btn.addEventListener("click", () => injectScenario(btn.dataset.scenario)));
ui.btnClearAlerts.addEventListener("click", () => {
  state.incidents = state.incidents.filter((a) => !isWorkflowClosed(a.workflowStatus));
  state.selectedAlertId = null;
  renderAll();
});

state.theme = initTheme();
ui.btnTheme.textContent = getThemeLabel(state.theme);
setAppPhase(APP_PHASE.IDLE);
renderAll();
