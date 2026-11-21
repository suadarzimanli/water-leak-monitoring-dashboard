import { PRESSURE_ZONES, zoneById } from "./zones.js";
import { getChartTheme, getThemeLabel, initTheme, THEMES, toggleTheme } from "./theme.js";
import { buildUserGuide } from "./user-guide.js";
import { APP_PHASE, SIM, SIMULATION_MS } from "./config.js";
import { createNetwork, EVENT, formatNetworkTime, hourOfIndex } from "./network.js";
import { contextCheck, evaluate, explain, fitBaseline, METHOD, PERSISTENCE_HOURS, trainDetector } from "./detect.js";
import { alertStream, summarize } from "./metrics.js";
import { describeEvent, formatHourWindow, getTimeContext } from "./context.js";
import { createZoneMap } from "./map.js";
import { renderZoneChart } from "./charts.js";
import {
  acknowledgeAlert,
  autoClearIncident,
  closeAsFalseAlarm,
  closeAsLeak,
  createIncident,
  createTicket,
  dispatchCrew,
  getOpenIncidents,
  getWorkflowActions,
  isWorkflowClosed,
  WORKFLOW_LABELS,
  WORKFLOW_STATUS,
} from "./workflow.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const state = {
  appPhase: APP_PHASE.IDLE,
  net: null,
  readings: [],
  latestByZone: new Map(),
  prevByZone: new Map(),
  zoneRuns: new Map(), // zoneId -> { alarm, normal }
  model: null, // { baseline, weights?, threshold? }
  testSummary: {}, // method -> summary for the test week
  selectedZoneId: null,
  selectedAlertId: null,
  simulationTimer: null,
  simulationSpeed: "normal",
  detectionMode: METHOD.ML_CONTEXT,
  incidents: [],
  systemLog: [],
  decisions: { correct: 0, total: 0 },
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
  btnReset: $("btn-reset"),
  btnGuided: $("btn-guided"),
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
  metricPending: $("metric-pending"),
  metricCloseout: $("metric-closeout"),
  metricTickets: $("metric-tickets"),
  metricLeaks: $("metric-leaks"),
  metricLeaksNote: $("metric-leaks-note"),
  metricFalse: $("metric-false"),
  metricFalseNote: $("metric-false-note"),
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

/* ---------------- helpers ---------------- */

function badgeClass(risk) {
  if (risk === "critical") return "badge-critical";
  if (risk === "warning") return "badge-warning";
  return "badge-normal";
}

const METHOD_LABEL = {
  [METHOD.RULES]: "Rules",
  [METHOD.ML]: "ML",
  [METHOD.ML_CONTEXT]: "ML + context",
};

function effectiveMethod() {
  if (!state.model?.weights) return METHOD.RULES;
  return state.detectionMode;
}

function currentHourIndex() {
  return state.net ? state.net.hourIndex - 1 : 0;
}

function contextFor(row) {
  return { scheduled: state.net.scheduledAt(row.zoneId, row.index), weather: state.net.weatherForDay(row.day) };
}

function getZoneEvaluation(zoneId) {
  const latest = state.latestByZone.get(zoneId);
  if (!latest || !state.model) {
    return { risk: "normal", label: "Normal", score: 0, alarm: false, raised: false, explained: null, method: effectiveMethod() };
  }
  const ev = evaluate(latest, state.prevByZone.get(zoneId), state.model, effectiveMethod(), contextFor(latest));
  const run = state.zoneRuns.get(zoneId)?.alarm ?? 0;
  let risk = "normal";
  if (ev.raised && run >= PERSISTENCE_HOURS) risk = "critical";
  else if (ev.alarm) risk = "warning";
  const label = risk === "critical" ? "Likely leak" : ev.explained ? "Explained by context" : risk === "warning" ? "Watch" : "Normal";
  return { ...ev, risk, label };
}

function classifyOpenIncidents() {
  const open = getOpenIncidents(state.incidents);
  const activeOnMap = [];
  const awaitingCloseout = [];
  for (const incident of open) {
    if (getZoneEvaluation(incident.zoneId).risk !== "normal") activeOnMap.push(incident);
    else awaitingCloseout.push(incident);
  }
  return { activeOnMap, awaitingCloseout, open };
}

function countZonesAtRisk() {
  return PRESSURE_ZONES.filter((zone) => getZoneEvaluation(zone.id).risk !== "normal").length;
}

function getSelectedAlert() {
  return state.incidents.find((a) => a.id === state.selectedAlertId) ?? null;
}

function networkNow() {
  const latest = state.latestByZone.get(PRESSURE_ZONES[0].id);
  return latest ? latest.timestamp : null;
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
  ui.btnGenerate.disabled = isLive;
  for (const opt of ui.detectionMode.options) {
    if (opt.value !== METHOD.RULES) opt.disabled = !hasModel;
  }
  ui.detectionMode.value = effectiveMethod();
  document.querySelectorAll("[data-scenario]").forEach((b) => (b.disabled = !hasData));

  if (isLive) {
    ui.mapStatus.textContent = "Live";
    ui.mapStatus.className = "badge badge-warning";
  } else if (hasModel) {
    ui.mapStatus.textContent = "Model ready";
    ui.mapStatus.className = "badge badge-normal";
  } else if (hasData) {
    ui.mapStatus.textContent = "Data loaded";
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
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabId}`);
  });
}

/* ---------------- metrics & logs ---------------- */

function updateMetrics() {
  const atRisk = countZonesAtRisk();
  const { open, awaitingCloseout } = classifyOpenIncidents();
  ui.metricAtRisk.textContent = String(atRisk);
  ui.metricPending.textContent = String(open.length);
  ui.metricCloseout.textContent = String(awaitingCloseout.length);
  ui.metricTickets.textContent = String(state.incidents.filter((a) => a.ticketId).length);

  const s = state.testSummary[effectiveMethod()];
  if (s) {
    ui.metricLeaks.textContent = `${s.leaksDetected} / ${s.leaks}`;
    ui.metricLeaksNote.textContent = `${METHOD_LABEL[effectiveMethod()]} · test week`;
    ui.metricFalse.textContent = String(s.falseAlerts);
    ui.metricFalseNote.textContent = `precision ${s.precision == null ? "–" : `${Math.round(s.precision * 100)}%`} · test week`;
  } else {
    ui.metricLeaks.textContent = "—";
    ui.metricLeaksNote.textContent = "after Generate Data";
    ui.metricFalse.textContent = "—";
    ui.metricFalseNote.textContent = "after Generate Data";
  }

  const now = networkNow();
  ui.networkTime.textContent = now ? formatNetworkTime(now) : "—";

  if (!state.readings.length) {
    ui.mapSummary.textContent = `Click Generate Data to simulate ${SIM.historyDays} days of hourly readings for ${PRESSURE_ZONES.length} pressure zones.`;
  } else if (atRisk === 0) {
    ui.mapSummary.textContent = "All zones within their usual range on the latest readings.";
  } else {
    ui.mapSummary.textContent = `${atRisk} zone(s) flagged — select a marker to investigate.`;
  }
}

function pushSystemLog(message) {
  state.systemLog.unshift({ message, time: networkNow() });
  state.systemLog = state.systemLog.slice(0, 40); // log only; incidents are kept separately
  renderActivityLog();
}

/* ---------------- incidents ---------------- */

function openIncident(zone, row, evaluation) {
  const weather = state.net.weatherForDay(row.day);
  const incident = createIncident({
    zoneId: zone.id,
    message: `${evaluation.label} — ${METHOD_LABEL[evaluation.method]} ${(evaluation.score * 100).toFixed(0)}%`,
    risk: evaluation.risk,
    time: row.timestamp,
    contextSummary: `${getTimeContext(row.hour).label} · ${weather.label}`,
    contextNote: null,
  });
  // hidden truth, used only to show the outcome after the case is closed
  incident.truth = { leakSeen: Boolean(row.isLeak), events: new Set(row.truth.events) };
  incident.openedAt = row.index;
  state.incidents.unshift(incident);
  pushSystemLog(`Incident opened in ${zone.id} (${zone.name}).`);
  return incident;
}

/** Update run counters, open/auto-close incidents for one new reading. */
function processReading(row) {
  const zone = zoneById(row.zoneId);
  const runs = state.zoneRuns.get(row.zoneId) ?? { alarm: 0, normal: 0 };
  const ev = state.model
    ? evaluate(row, state.latestByZone.get(row.zoneId) ?? null, state.model, effectiveMethod(), contextFor(row)) // latest = previous hour here
    : { raised: false };
  runs.alarm = ev.raised ? runs.alarm + 1 : 0;
  runs.normal = ev.alarm ? 0 : runs.normal + 1;
  state.zoneRuns.set(row.zoneId, runs);

  const open = getOpenIncidents(state.incidents).find((a) => a.zoneId === row.zoneId);
  if (open) {
    open.truth.leakSeen ||= Boolean(row.isLeak);
    row.truth.events.forEach((e) => open.truth.events.add(e));
    if (runs.normal >= SIM.autoClearHours && open.workflowStatus === WORKFLOW_STATUS.OPEN) {
      autoClearIncident(open, SIM.autoClearHours);
      recordOutcome(open, "auto");
    }
  } else if (ev.raised && runs.alarm >= PERSISTENCE_HOURS) {
    openIncident(zone, row, getZoneEvaluationFor(row, ev));
  }
}

function getZoneEvaluationFor(row, ev) {
  return { ...ev, risk: "critical", label: "Likely leak" };
}

/** Compare the closing decision with the simulation truth and keep a tally. */
function recordOutcome(incident, decision) {
  const leak = incident.truth.leakSeen;
  const others = [...incident.truth.events].filter((e) => e !== EVENT.LEAK);
  const what = leak ? describeEvent(EVENT.LEAK) : others.length ? others.map(describeEvent).join(" and ") : "normal variation (no event)";
  let verdict;
  if (decision === "auto") verdict = leak ? "A leak was missed when the case cleared automatically." : "Clearing automatically was right.";
  else if (decision === "leak") verdict = leak ? "Correct — the crew found and repaired the leak." : "No leak was present; the dispatch was not needed.";
  else verdict = leak ? "A leak was present — closing as a false alarm missed it." : "Correct — there was no leak.";
  incident.outcome = { what, verdict, correct: decision === "auto" ? !leak : decision === "leak" ? leak : !leak };
  incident.workflowLog.push(`Simulation truth: ${what}. ${verdict}`);
  if (decision !== "auto") {
    state.decisions.total += 1;
    if (incident.outcome.correct) state.decisions.correct += 1;
  }
}

/* ---------------- rendering ---------------- */

function renderMaintenanceList() {
  if (!state.net) {
    ui.maintenanceList.innerHTML = '<li class="context-empty">Generate data to load the schedule.</li>';
    return;
  }
  const today = Math.floor(currentHourIndex() / 24);
  const items = state.net.scheduleFor([today, today + 1]).sort((a, b) => a.start - b.start);
  if (!items.length) {
    ui.maintenanceList.innerHTML = '<li class="context-empty">No work scheduled today or tomorrow.</li>';
    return;
  }
  const now = currentHourIndex();
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
  if (!state.systemLog.length) {
    ui.activityLog.innerHTML = '<li class="alert-empty">System messages appear here.</li>';
    return;
  }
  ui.activityLog.innerHTML = state.systemLog
    .slice(0, 10)
    .map((l) => `<li><div>${esc(l.message)}</div><div class="alert-time">${l.time ? formatNetworkTime(l.time) : ""}</div></li>`)
    .join("");
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
    li.innerHTML = `
      <div><strong>${esc(alert.zoneId)}</strong> — ${esc(alert.message)}</div>
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
  renderIncidentList(ui.alertListActive, activeOnMap, "No zones flagged on the map right now.");
  renderIncidentList(ui.alertListCloseout, awaitingCloseout, "No incidents waiting for close-out.");
  const d = state.decisions;
  ui.decisionScore.textContent = d.total ? `Your decisions: ${d.correct} of ${d.total} matched the simulation` : "";
}

function shouldShowWorkflow(alert) {
  return Boolean(alert);
}

function renderWorkflowPanel() {
  const alert = getSelectedAlert();
  if (!shouldShowWorkflow(alert)) {
    ui.workflowSection.classList.add("hidden");
    ui.workflowPanel.innerHTML = "";
    ui.actionPlaceholder.classList.remove("hidden");
    return;
  }
  ui.actionPlaceholder.classList.add("hidden");
  ui.workflowSection.classList.remove("hidden");

  const closed = isWorkflowClosed(alert.workflowStatus);
  const actions = getWorkflowActions(alert.workflowStatus);
  const finalStep = [WORKFLOW_STATUS.CLOSED_FALSE, WORKFLOW_STATUS.CLOSED_AUTO].includes(alert.workflowStatus) ? alert.workflowStatus : WORKFLOW_STATUS.CLOSED_LEAK;
  const steps = [WORKFLOW_STATUS.OPEN, WORKFLOW_STATUS.ACKNOWLEDGED, WORKFLOW_STATUS.TICKET, WORKFLOW_STATUS.DISPATCHED, finalStep];
  const progress = { open: 0, acknowledged: 1, ticket_created: 2, dispatched: 3, closed_leak: 4, closed_false_alarm: 4, closed_auto: 4 }[alert.workflowStatus] ?? 0;
  const stepHtml = steps
    .map((step, i) => `<div class="workflow-step ${i < progress || (closed && i <= progress) ? "done" : ""} ${alert.workflowStatus === step ? "current" : ""}">${esc(WORKFLOW_LABELS[step])}</div>`)
    .join("");
  const primary = actions.primary ? `<button id="wf-primary" class="btn btn-primary" data-action="${actions.primary.id}">${esc(actions.primary.label)}</button>` : "";
  const secondary = actions.secondary.map((s) => `<button class="btn btn-ghost wf-secondary" data-action="${s.id}">${esc(s.label)}</button>`).join("");
  const outcome = alert.outcome
    ? `<p class="outcome ${alert.outcome.correct ? "outcome-ok" : "outcome-miss"}"><strong>Outcome:</strong> the simulation had ${esc(alert.outcome.what)}. ${esc(alert.outcome.verdict)}</p>`
    : "";

  ui.workflowPanel.innerHTML = `
    <h3>Operator workflow — ${esc(alert.zoneId)}</h3>
    <p class="workflow-intro">Check the Context tab first. Only the next valid action is enabled.</p>
    ${actions.hint ? `<p class="workflow-hint">${esc(actions.hint)}</p>` : ""}
    <div class="workflow-steps">${stepHtml}</div>
    <div class="workflow-actions workflow-actions-primary">${primary}</div>
    <div class="workflow-actions">${secondary}</div>
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
  const ids = [allowed.primary?.id, ...allowed.secondary.map((s) => s.id)].filter(Boolean);
  if (!ids.includes(action)) return;
  switch (action) {
    case "ack":
      acknowledgeAlert(alert);
      break;
    case "ticket":
      createTicket(alert);
      break;
    case "dispatch":
      dispatchCrew(alert);
      break;
    case "leak":
      closeAsLeak(alert);
      if (state.net.repairLeak(alert.zoneId)) alert.truth.leakSeen = true;
      recordOutcome(alert, "leak");
      break;
    case "false":
      closeAsFalseAlarm(alert);
      recordOutcome(alert, "false");
      break;
    default:
      break;
  }
  renderAll();
}

function renderZoneContext(zone, row) {
  const time = getTimeContext(row.hour);
  const weather = state.net.weatherForDay(row.day);
  const today = Math.floor(row.index / 24);
  const schedule = state.net.scheduleFor([today]).filter((s) => s.zoneId === zone.id);
  const scheduleText = schedule.length
    ? schedule.map((s) => `${s.title} ${formatHourWindow(s.start, s.end, hourOfIndex)}${s.start <= row.index && row.index < s.end ? " (now)" : ""}`).join("; ")
    : "None scheduled today";
  const ev = getZoneEvaluation(zone.id);
  const check = state.model ? contextCheck(row, state.model.baseline, contextFor(row)) : null;
  let checkTitle;
  let checkText;
  if (!ev.alarm) {
    checkTitle = "No alarm";
    checkText = "Readings are within the usual range for this hour.";
  } else if (check) {
    checkTitle = "Context explains the alarm";
    checkText = check.text;
  } else {
    checkTitle = "Nothing in the schedule or weather explains this";
    checkText = "Treat as a possible leak: acknowledge, then create a work order.";
  }
  ui.zoneContext.innerHTML = `
    <h3>Operational context — ${esc(zone.id)}</h3>
    <p class="panel-hint">Only information an operator would have: time, weather, the published schedule and how the readings relate to each other.</p>
    <div class="context-grid">
      <div class="context-card"><span>Time</span><strong>${esc(formatNetworkTime(row.timestamp))} · ${esc(time.label)}</strong><p>${esc(time.detail)}</p></div>
      <div class="context-card"><span>Weather today</span><strong>${esc(weather.label)}</strong><p>${esc(weather.impact)}</p></div>
      <div class="context-card"><span>Scheduled work in this zone</span><strong>${esc(scheduleText)}</strong><p>Cross-check alerts against the schedule before dispatch.</p></div>
      <div class="context-card ${ev.alarm && check ? "context-highlight" : ""}"><span>Context check</span><strong>${esc(checkTitle)}</strong><p>${esc(checkText)}</p></div>
    </div>`;
}

function renderWhyFlagged(zoneId, evaluation) {
  const latest = state.latestByZone.get(zoneId);
  if (!latest || !state.model || !evaluation.alarm) {
    ui.whyFlagged.classList.add("hidden");
    ui.whyFlagged.innerHTML = "";
    return;
  }
  const lines = explain(latest, evaluation, state.model);
  const run = state.zoneRuns.get(zoneId)?.alarm ?? 0;
  if (evaluation.raised) lines.push(`Alarm for ${run} consecutive hour(s); an incident opens after ${PERSISTENCE_HOURS}.`);
  ui.whyFlagged.classList.remove("hidden");
  ui.whyFlagged.innerHTML = `<h4>Why flagged</h4><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
}

function renderSelectedZone() {
  const zoneId = state.selectedZoneId;
  if (!zoneId) {
    ui.zoneContext.innerHTML = '<p class="placeholder-text">Operational context appears when a zone is selected.</p>';
    ui.whyFlagged.classList.add("hidden");
    return;
  }
  const zone = zoneById(zoneId);
  const latest = state.latestByZone.get(zoneId);
  if (!zone || !latest) return;
  const evaluation = getZoneEvaluation(zoneId);
  ui.zoneTitle.textContent = `${zone.id} — ${zone.name}`;
  ui.zoneStatus.textContent = evaluation.label;
  ui.zoneStatus.className = `badge ${badgeClass(evaluation.risk)}`;
  const b = state.model?.baseline.get(zoneId);
  ui.zoneDetails.innerHTML = `
    <div class="zone-meta">
      <span class="tag ${zone.priority === "high" ? "tag-danger" : "tag-neutral"}">${zone.priority === "high" ? "High priority" : "Standard"}</span>
      <span class="tag tag-neutral">${esc(zone.dma)}</span>
    </div>
    <p class="zone-note">${esc(zone.note)}</p>
    <div class="detail-grid">
      <div class="detail-item"><span>Flow</span><strong>${latest.flowLps.toFixed(1)} L/s</strong>${b ? `<small>usual ${b.flowMed[latest.hour].toFixed(1)}</small>` : ""}</div>
      <div class="detail-item"><span>Pressure</span><strong>${latest.pressurePsi.toFixed(1)} psi</strong>${b ? `<small>usual ${b.presMed[latest.hour].toFixed(1)}</small>` : ""}</div>
      <div class="detail-item"><span>${evaluation.method === METHOD.RULES ? "Rules score" : "Leak score"}</span><strong>${(evaluation.score * 100).toFixed(0)}%</strong></div>
      <div class="detail-item"><span>Detection</span><strong>${esc(METHOD_LABEL[evaluation.method])}</strong></div>
    </div>`;
  renderZoneContext(zone, latest);
  renderWhyFlagged(zoneId, evaluation);
  const history = state.readings.filter((r) => r.zoneId === zoneId).slice(-SIM.chartHours);
  renderZoneChart(ui.zoneChart, history, b, getChartTheme());
  mapApi.setSelected(zoneId);
}

function refreshMap() {
  const today = Math.floor(currentHourIndex() / 24);
  const scheduledZones = new Set(state.net ? state.net.scheduleFor([today]).map((s) => s.zoneId) : []);
  for (const zone of PRESSURE_ZONES) {
    mapApi.setMarkerRisk(zone.id, getZoneEvaluation(zone.id).risk);
    mapApi.setMaintenanceBadge(zone.id, scheduledZones.has(zone.id));
  }
}

function renderAll() {
  refreshMap();
  updateMetrics();
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

function ingest(rows) {
  for (const row of rows) {
    state.readings.push(row);
    processReading(row);
    state.prevByZone.set(row.zoneId, state.latestByZone.get(row.zoneId) ?? null);
    state.latestByZone.set(row.zoneId, row);
  }
}

function advanceHour() {
  ingest(state.net.step());
  renderAll();
}

function computeTestSummaries() {
  const test = state.readings.filter((r) => r.day >= SIM.trainDays && r.day < SIM.historyDays);
  const hours = (SIM.historyDays - SIM.trainDays) * 24;
  const methods = state.model.weights ? [METHOD.RULES, METHOD.ML, METHOD.ML_CONTEXT] : [METHOD.RULES];
  state.testSummary = {};
  for (const m of methods) {
    const stream = alertStream(test, state.model, m, { persistence: PERSISTENCE_HOURS, contextFor });
    state.testSummary[m] = summarize(stream, { zones: PRESSURE_ZONES.length, hours });
  }
}

function onGenerateData() {
  stopSimulation();
  state.net = createNetwork({ seed: SIM.seed });
  state.readings = [];
  state.latestByZone = new Map();
  state.prevByZone = new Map();
  state.zoneRuns = new Map();
  state.model = null;
  state.incidents = [];
  state.decisions = { correct: 0, total: 0 };
  state.selectedAlertId = null;
  ingest(state.net.run(SIM.historyDays * 24));
  const train = state.readings.filter((r) => r.day < SIM.trainDays);
  state.model = { baseline: fitBaseline(train) };
  computeTestSummaries();
  resetRuns();
  selectZone(PRESSURE_ZONES[0].id);
  setAppPhase(APP_PHASE.DATA_READY);
  pushSystemLog(`Simulated ${SIM.historyDays} days for ${PRESSURE_ZONES.length} zones; baseline from the first ${SIM.trainDays} days. Rules detection active.`);
  renderAll();
}

/** History readings do not open incidents: start live monitoring with clean counters. */
function resetRuns() {
  state.zoneRuns = new Map();
  state.incidents = [];
}

function onTrainModel() {
  if (!state.readings.length) {
    pushSystemLog("Generate data before training.");
    return;
  }
  const train = state.readings.filter((r) => r.day < SIM.trainDays);
  state.model = trainDetector(train);
  state.detectionMode = METHOD.ML_CONTEXT;
  computeTestSummaries();
  setAppPhase(APP_PHASE.MODEL_READY);
  const s = state.testSummary[METHOD.ML_CONTEXT];
  pushSystemLog(`Model trained on days 1–${SIM.trainDays}. Test week: ${s.leaksDetected}/${s.leaks} leaks caught, ${s.falseAlerts} false alerts (ML + context).`);
  renderAll();
}

function stopSimulation() {
  if (state.simulationTimer) {
    clearInterval(state.simulationTimer);
    state.simulationTimer = null;
  }
  state.guideSimStarted = false;
  ui.btnSimulate.textContent = "3. Live simulation";
  ui.btnSimulate.classList.remove("btn-active");
  if (state.appPhase === APP_PHASE.LIVE) setAppPhase(state.model?.weights ? APP_PHASE.MODEL_READY : APP_PHASE.DATA_READY);
}

function startSimulation() {
  if (!state.net || state.simulationTimer) return;
  const intervalMs = SIMULATION_MS[state.simulationSpeed] ?? SIMULATION_MS.normal;
  state.simulationTimer = setInterval(advanceHour, intervalMs);
  ui.btnSimulate.textContent = "Stop live simulation";
  ui.btnSimulate.classList.add("btn-active");
  setAppPhase(APP_PHASE.LIVE);
  pushSystemLog("Live simulation: one network hour per tick.");
}

function onToggleSimulation() {
  if (state.simulationTimer) stopSimulation();
  else if (!state.readings.length) pushSystemLog("Generate data first.");
  else startSimulation();
}

function resetDemo(options = {}) {
  if (!options.keepGuide && userGuide?.isActive()) userGuide.stop();
  stopSimulation();
  Object.assign(state, {
    net: null,
    readings: [],
    latestByZone: new Map(),
    prevByZone: new Map(),
    zoneRuns: new Map(),
    model: null,
    testSummary: {},
    incidents: [],
    systemLog: [],
    decisions: { correct: 0, total: 0 },
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
  pushSystemLog("Demo reset — start with Generate Data.");
  renderAll();
}

const SCENARIO_LABEL = {
  [EVENT.LEAK]: "Leak started",
  [EVENT.HYDRANT_USE]: "Unscheduled hydrant use",
  [EVENT.VALVE_WORK]: "Valve work added to today's schedule",
};

/** Demo control: start an event in a random zone and advance two network hours. */
function injectScenario(type) {
  if (!state.net) {
    pushSystemLog("Generate data before starting a scenario.");
    return;
  }
  const zone = PRESSURE_ZONES[Math.floor(Math.random() * PRESSURE_ZONES.length)];
  state.net.inject(zone.id, type);
  pushSystemLog(`${SCENARIO_LABEL[type] ?? type} in ${zone.id} (${zone.name}).`);
  for (let i = 0; i < PERSISTENCE_HOURS; i += 1) ingest(state.net.step());
  selectZone(zone.id);
  setActiveSideTab(getOpenIncidents(state.incidents).some((a) => a.zoneId === zone.id) ? "action" : "context");
  renderAll();
}

/* ---------------- user guide ---------------- */

function getScriptContext() {
  const { activeOnMap } = classifyOpenIncidents();
  return {
    appPhase: state.appPhase,
    hasData: state.readings.length > 0,
    hasModel: Boolean(state.model?.weights),
    rulesOnly: state.detectionMode === METHOD.RULES,
    hasSelection: Boolean(state.selectedZoneId),
    isLive: Boolean(state.simulationTimer),
    hasActiveIncident: activeOnMap.length > 0,
    hasOpenIncident: getOpenIncidents(state.incidents).length > 0,
    contextTabViewed: state.contextTabViewed,
    zoneInspectDone: state.zoneInspectDone,
    guideSimStarted: state.guideSimStarted,
    guideResetDone: state.guideResetDone,
    hasClosedFalseAlarm: state.incidents.some((a) => a.workflowStatus === WORKFLOW_STATUS.CLOSED_FALSE),
    workflowAcknowledged: state.incidents.some((a) => a.workflowStatus !== WORKFLOW_STATUS.OPEN && !isWorkflowClosed(a.workflowStatus)),
    hasClosedLeak: state.incidents.some((a) => a.workflowStatus === WORKFLOW_STATUS.CLOSED_LEAK),
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

function withSelected(fn) {
  const alert = getSelectedAlert();
  if (alert) fn(alert);
  renderAll();
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
    ui.guideLearn.innerHTML = "<strong>What you learned:</strong> how readings, detection, context checks and the operator workflow fit together. Use <strong>Reset demo</strong> anytime to start over.";
    ui.guideYouWillSee.innerHTML = "<strong>Try next:</strong> switch detection to <em>ML only</em> or <em>Rules only</em>, add valve work, or start a leak, and compare the false alerts.";
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
    state.guideSimStarted = false;
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
  injectScenario: (key) => injectScenario(key),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  getSelectedIncident: () => getSelectedAlert(),
  getOpenIncidentsForWorkflow: () => getOpenIncidents(state.incidents),
  selectIncidentById: (id) => selectIncident(id),
  isIncidentClosed: (alert) => !alert || isWorkflowClosed(alert.workflowStatus),
  hasRiskyZone: () => PRESSURE_ZONES.some((z) => getZoneEvaluation(z.id).risk !== "normal"),
  acknowledgeSelected: () => withSelected(acknowledgeAlert),
  closeSelectedFalseAlarm: () => withSelected((a) => runWorkflowAction("false")),
  createTicketSelected: () => withSelected(createTicket),
  dispatchSelected: () => withSelected(dispatchCrew),
  confirmLeakSelected: () => withSelected((a) => runWorkflowAction("leak")),
});

async function runGuidedDemo() {
  resetDemo();
  onGenerateData();
  onTrainModel();
  startSimulation();
  injectScenario(EVENT.LEAK);
  pushSystemLog("Quick tour: a leak was started — follow the red marker.");
}

/* ---------------- events ---------------- */

document.querySelectorAll(".side-tab").forEach((btn) => btn.addEventListener("click", () => setActiveSideTab(btn.dataset.tab)));
ui.btnGenerate.addEventListener("click", onGenerateData);
ui.btnTrain.addEventListener("click", onTrainModel);
ui.btnSimulate.addEventListener("click", onToggleSimulation);
ui.btnReset.addEventListener("click", () => resetDemo());
ui.btnGuided.addEventListener("click", () => runGuidedDemo());
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
  state.zoneRuns = new Map(); // alarm runs depend on the method
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
