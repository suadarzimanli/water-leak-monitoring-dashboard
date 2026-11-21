/**
 * Operator incident workflow.
 *
 *   open ──acknowledge──▶ acknowledged ──dispatch crew──▶ dispatched ──crew report──▶ repaired | nothing found
 *     │                        │
 *     └──────── close, no action needed ───────────────▶ closed (no action)
 *   open ── readings normal for a while, nobody acted ──▶ cleared automatically
 *
 * The operator decides whether to send a crew; what the crew finds on site is reported back
 * (from the simulation) — the operator never "confirms" a leak nobody has looked at.
 */
export const WORKFLOW_STATUS = {
  OPEN: "open",
  ACKNOWLEDGED: "acknowledged",
  DISPATCHED: "dispatched",
  CLOSED_REPAIRED: "closed_repaired",
  CLOSED_NOTHING: "closed_nothing_found",
  CLOSED_NO_ACTION: "closed_no_action",
  CLOSED_AUTO: "closed_auto",
};

export const WORKFLOW_LABELS = {
  [WORKFLOW_STATUS.OPEN]: "Open — awaiting review",
  [WORKFLOW_STATUS.ACKNOWLEDGED]: "Acknowledged by operator",
  [WORKFLOW_STATUS.DISPATCHED]: "Crew on the way",
  [WORKFLOW_STATUS.CLOSED_REPAIRED]: "Closed — leak found and repaired",
  [WORKFLOW_STATUS.CLOSED_NOTHING]: "Closed — crew found no leak",
  [WORKFLOW_STATUS.CLOSED_NO_ACTION]: "Closed — no action needed",
  [WORKFLOW_STATUS.CLOSED_AUTO]: "Closed — cleared automatically",
};

let ticketCounter = 1040;
let incidentCounter = 0;

/**
 * A new operator incident. Only operator-visible information is stored here; the simulator's
 * truth is attached separately by the app and shown only after the case is closed.
 */
export function createIncident({ zoneId, message, risk, time, contextSummary, contextNote = null, priority = "standard" }) {
  return {
    id: `incident-${++incidentCounter}`,
    kind: "incident",
    zoneId,
    message,
    risk,
    time,
    priority,
    contextSummary,
    contextNote,
    workflowStatus: WORKFLOW_STATUS.OPEN,
    ticketId: null,
    crewArrivesAt: null,
    workflowLog: ["Incident opened — alarm persisted for consecutive hours"],
  };
}

export function autoClearIncident(alert, hours) {
  if (alert.workflowStatus !== WORKFLOW_STATUS.OPEN) return alert;
  alert.workflowStatus = WORKFLOW_STATUS.CLOSED_AUTO;
  alert.workflowLog.push(`Cleared automatically — readings normal for ${hours} hours and no operator action yet`);
  return alert;
}

export function acknowledgeAlert(alert) {
  if (alert.workflowStatus !== WORKFLOW_STATUS.OPEN) return alert;
  alert.workflowStatus = WORKFLOW_STATUS.ACKNOWLEDGED;
  alert.workflowLog.push("Operator acknowledged the alert");
  return alert;
}

/** Send a crew (creates the work order). `arrivesAt` = network hour index of the crew's report. */
export function dispatchCrew(alert, arrivesAt) {
  if (alert.workflowStatus !== WORKFLOW_STATUS.ACKNOWLEDGED) return alert;
  ticketCounter += 1;
  alert.ticketId = `WO-${ticketCounter}`;
  alert.crewArrivesAt = arrivesAt;
  alert.workflowStatus = WORKFLOW_STATUS.DISPATCHED;
  alert.workflowLog.push(`Work order ${alert.ticketId}: crew dispatched`);
  return alert;
}

/** The crew's finding on site closes the case. */
export function recordCrewReport(alert, leakFound) {
  if (alert.workflowStatus !== WORKFLOW_STATUS.DISPATCHED) return alert;
  alert.workflowStatus = leakFound ? WORKFLOW_STATUS.CLOSED_REPAIRED : WORKFLOW_STATUS.CLOSED_NOTHING;
  alert.workflowLog.push(leakFound ? "Crew report: leak found and repaired" : "Crew report: no leak found on site");
  return alert;
}

/** The operator judges that no field visit is needed. */
export function closeNoAction(alert) {
  if (![WORKFLOW_STATUS.OPEN, WORKFLOW_STATUS.ACKNOWLEDGED].includes(alert.workflowStatus)) return alert;
  alert.workflowStatus = WORKFLOW_STATUS.CLOSED_NO_ACTION;
  alert.workflowLog.push("Operator closed the case: no action needed");
  return alert;
}

export function isWorkflowClosed(status) {
  if (!status) return true;
  return [WORKFLOW_STATUS.CLOSED_REPAIRED, WORKFLOW_STATUS.CLOSED_NOTHING, WORKFLOW_STATUS.CLOSED_NO_ACTION, WORKFLOW_STATUS.CLOSED_AUTO].includes(status);
}

export function getOpenIncidents(alerts) {
  return alerts.filter((alert) => alert.kind === "incident" && !isWorkflowClosed(alert.workflowStatus));
}

/** Actions allowed in the current state. */
export function getWorkflowActions(status) {
  if (isWorkflowClosed(status)) return { primary: null, secondary: [], hint: "Case closed." };
  switch (status) {
    case WORKFLOW_STATUS.OPEN:
      return {
        primary: { id: "ack", label: "Acknowledge" },
        secondary: [{ id: "noaction", label: "Close — no action needed" }],
        hint: "Step 1: check the Context tab, then acknowledge.",
      };
    case WORKFLOW_STATUS.ACKNOWLEDGED:
      return {
        primary: { id: "dispatch", label: "Dispatch crew" },
        secondary: [{ id: "noaction", label: "Close — no action needed" }],
        hint: "Step 2: send a crew if nothing explains the alarm.",
      };
    case WORKFLOW_STATUS.DISPATCHED:
      return { primary: null, secondary: [], hint: "Step 3: wait for the crew's report (advance the network clock)." };
    default:
      return { primary: null, secondary: [], hint: "" };
  }
}
