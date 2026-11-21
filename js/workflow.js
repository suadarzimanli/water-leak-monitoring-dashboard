export const WORKFLOW_STATUS = {
  OPEN: "open",
  ACKNOWLEDGED: "acknowledged",
  TICKET: "ticket_created",
  DISPATCHED: "dispatched",
  CLOSED_LEAK: "closed_leak",
  CLOSED_FALSE: "closed_false_alarm",
  CLOSED_AUTO: "closed_auto",
};

export const WORKFLOW_LABELS = {
  [WORKFLOW_STATUS.OPEN]: "Open — awaiting review",
  [WORKFLOW_STATUS.ACKNOWLEDGED]: "Acknowledged by operator",
  [WORKFLOW_STATUS.TICKET]: "Work order created",
  [WORKFLOW_STATUS.DISPATCHED]: "Crew dispatched",
  [WORKFLOW_STATUS.CLOSED_LEAK]: "Closed — leak confirmed",
  [WORKFLOW_STATUS.CLOSED_FALSE]: "Closed — false alarm",
  [WORKFLOW_STATUS.CLOSED_AUTO]: "Closed — cleared automatically",
};

let ticketCounter = 1040;
let incidentCounter = 0;

/**
 * A new operator incident. Only operator-visible information is stored here; the simulator's
 * truth is attached separately by the app and shown only after the case is closed.
 */
export function createIncident({ zoneId, message, risk, time, contextSummary, contextNote = null }) {
  return {
    id: `incident-${++incidentCounter}`,
    kind: "incident",
    zoneId,
    message,
    risk,
    time,
    contextSummary,
    contextNote,
    workflowStatus: WORKFLOW_STATUS.OPEN,
    ticketId: null,
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
  alert.workflowLog.push("Operator acknowledged alert");
  return alert;
}

export function createTicket(alert) {
  if (alert.workflowStatus !== WORKFLOW_STATUS.ACKNOWLEDGED) {
    return alert;
  }
  ticketCounter += 1;
  alert.ticketId = `WO-${ticketCounter}`;
  alert.workflowStatus = WORKFLOW_STATUS.TICKET;
  alert.workflowLog.push(`Work order ${alert.ticketId} created`);
  return alert;
}

export function dispatchCrew(alert) {
  if (alert.workflowStatus !== WORKFLOW_STATUS.TICKET) return alert;
  alert.workflowStatus = WORKFLOW_STATUS.DISPATCHED;
  alert.workflowLog.push("Repair crew dispatched to zone");
  return alert;
}

export function closeAsLeak(alert) {
  if (isWorkflowClosed(alert.workflowStatus)) return alert;
  alert.workflowStatus = WORKFLOW_STATUS.CLOSED_LEAK;
  alert.workflowLog.push("Field crew confirmed leak — case closed");
  return alert;
}

export function closeAsFalseAlarm(alert) {
  if (isWorkflowClosed(alert.workflowStatus)) return alert;
  alert.workflowStatus = WORKFLOW_STATUS.CLOSED_FALSE;
  alert.workflowLog.push("Operator marked false alarm");
  return alert;
}

export function isWorkflowClosed(status) {
  if (!status) return true;
  return (
    status === WORKFLOW_STATUS.CLOSED_LEAK ||
    status === WORKFLOW_STATUS.CLOSED_FALSE ||
    status === WORKFLOW_STATUS.CLOSED_AUTO
  );
}

export function getOpenIncidents(alerts) {
  return alerts.filter(
    (alert) => alert.kind === "incident" && !isWorkflowClosed(alert.workflowStatus)
  );
}

/** Returns primary and secondary actions allowed for current workflow state. */
export function getWorkflowActions(status) {
  if (isWorkflowClosed(status)) {
    return { primary: null, secondary: [], hint: "Incident closed." };
  }
  switch (status) {
    case WORKFLOW_STATUS.OPEN:
      return {
        primary: { id: "ack", label: "Acknowledge alert" },
        secondary: [{ id: "false", label: "Mark false alarm" }],
        hint: "Step 1: Review context, then acknowledge.",
      };
    case WORKFLOW_STATUS.ACKNOWLEDGED:
      return {
        primary: { id: "ticket", label: "Create work order" },
        secondary: [{ id: "false", label: "Mark false alarm" }],
        hint: "Step 2: Create a ticket if dispatch is needed.",
      };
    case WORKFLOW_STATUS.TICKET:
      return {
        primary: { id: "dispatch", label: "Dispatch crew" },
        secondary: [
          { id: "false", label: "Mark false alarm" },
          { id: "leak", label: "Confirm leak (skip dispatch)" },
        ],
        hint: "Step 3: Dispatch crew or close if not needed.",
      };
    case WORKFLOW_STATUS.DISPATCHED:
      return {
        primary: { id: "leak", label: "Confirm leak — close case" },
        secondary: [{ id: "false", label: "Mark false alarm" }],
        hint: "Step 4: Record field outcome.",
      };
    default:
      return { primary: null, secondary: [], hint: "" };
  }
}
