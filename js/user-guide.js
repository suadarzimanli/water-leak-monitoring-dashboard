export const GUIDE_STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  COMPLETE: "complete",
};

/**
 * Interactive user guide — steps complete in order (or can be skipped).
 * Each step explains what to learn and can run the action for you.
 */
export function createUserGuide(steps, deps) {
  let stepIndex = 0;
  let status = GUIDE_STATUS.IDLE;
  let skippedSteps = new Set();

  function currentStep() {
    return steps[stepIndex] ?? null;
  }

  function isStepComplete(index) {
    const step = steps[index];
    if (!step) return true;
    if (skippedSteps.has(step.id)) return true;
    return step.check(deps.getContext());
  }

  function syncProgress() {
    while (stepIndex < steps.length - 1 && isStepComplete(stepIndex)) {
      stepIndex += 1;
    }
    if (stepIndex >= steps.length - 1 && isStepComplete(stepIndex)) {
      status = GUIDE_STATUS.COMPLETE;
    }
  }

  return {
    getStatus: () => status,
    getStepIndex: () => stepIndex,
    getSteps: () => steps,
    getCurrentStep: () => currentStep(),
    isActive: () => status === GUIDE_STATUS.RUNNING,
    isStepDone(index) {
      return index < stepIndex || isStepComplete(index) || skippedSteps.has(steps[index]?.id);
    },
    isStepCurrent(index) {
      return status === GUIDE_STATUS.RUNNING && index === stepIndex;
    },
    isStepLocked(index) {
      return status !== GUIDE_STATUS.RUNNING || index > stepIndex;
    },
    isStepCompleteAt(index) {
      return isStepComplete(index);
    },
    getSkippedStepIds() {
      return [...skippedSteps];
    },
    canRunCurrentAction() {
      const step = currentStep();
      if (!step || status !== GUIDE_STATUS.RUNNING) return false;
      if (step.actionDisabled?.(deps.getContext())) return false;
      return Boolean(step.action);
    },
    start() {
      stepIndex = 0;
      skippedSteps = new Set();
      status = GUIDE_STATUS.RUNNING;
      deps.onStart?.();
      syncProgress();
      deps.onChange?.();
    },
    stop() {
      status = GUIDE_STATUS.IDLE;
      stepIndex = 0;
      skippedSteps = new Set();
      deps.onStop?.();
      deps.onChange?.();
    },
    skipCurrent() {
      const step = currentStep();
      if (!step || status !== GUIDE_STATUS.RUNNING) return;
      skippedSteps.add(step.id);
      if (stepIndex < steps.length - 1) stepIndex += 1;
      else status = GUIDE_STATUS.COMPLETE;
      deps.onChange?.();
    },
    async runCurrentAction() {
      const step = currentStep();
      if (!step?.action || status !== GUIDE_STATUS.RUNNING) return;
      await step.action(deps);
      syncProgress();
      deps.onChange?.();
    },
    refresh() {
      if (status !== GUIDE_STATUS.RUNNING) return;
      syncProgress();
      deps.onChange?.();
    },
  };
}

export function buildUserGuide(deps) {
  return createUserGuide(
    [
      {
        id: "reset",
        title: "1. Start with a clean dashboard",
        duration: "About 30 sec",
        learn:
          "Every session begins empty: no readings, no model, no open incidents. This is the baseline before you load data.",
        youWillSee: "Metrics at zero, map status Ready, and an empty incident list.",
        check: (ctx) => ctx.guideResetDone,
        action: async (d) => {
          d.resetDemo();
          d.markGuideResetDone();
        },
      },
      {
        id: "generate",
        title: "2. Load synthetic SCADA data",
        duration: "About 1 min",
        learn:
          "The app simulates 28 days of hourly flow and pressure for 8 fictional pressure zones: daily demand peaks, weather, scheduled work, hydrant use, sensor drift and hidden leaks. All values are synthetic.",
        youWillSee:
          "Map markers, today's maintenance schedule, a flow/pressure chart with the usual values dashed, and test-week results for the rules.",
        check: (ctx) => ctx.hasData,
        action: async (d) => {
          d.generateData();
        },
      },
      {
        id: "train",
        title: "3. Train the leak detection model",
        duration: "About 1 min",
        learn:
          "A logistic regression model is fitted in your browser on days 1–21 and tested on days 22–28. Instead of accuracy (misleading when leaks are rare), the dashboard shows how many test-week leaks were caught and how many false alerts were raised.",
        youWillSee: "Leaks caught and false alerts for ML + context. Switch the Detection menu to compare ML only and Rules only.",
        check: (ctx) => ctx.hasModel || ctx.rulesOnly,
        action: async (d) => {
          d.trainModel();
        },
      },
      {
        id: "select-zone",
        title: "4. Explore a zone",
        duration: "About 45 sec",
        learn:
          "Click any map marker to inspect flow, pressure, history chart, and baseline context. Operators review a zone before reacting to alerts.",
        youWillSee:
          "The Zone tab with current readings, a flow/pressure chart, and zone metadata (priority, DMA).",
        check: (ctx) => ctx.zoneInspectDone,
        action: async (d) => {
          d.selectFirstZone();
          d.setSideTab("zone");
          d.markZoneInspectDone();
        },
      },
      {
        id: "simulate",
        title: "5. Turn on live simulation",
        duration: "About 1 min",
        learn:
          "Each tick is one network hour for all zones, like a SCADA stream. An incident opens only after two consecutive abnormal hours, and an untouched incident clears itself after three normal hours.",
        youWillSee: "Map status Live and the network clock advancing. Marker colours and incident lists update together.",
        check: (ctx) => ctx.guideSimStarted,
        action: async (d) => {
          d.startSimulation();
          d.markGuideSimStarted();
        },
      },
      {
        id: "flagged-zone",
        title: "6. Open a flagged zone",
        duration: "About 1–2 min",
        learn:
          "Orange means one abnormal hour (watch) or an alarm the context explains; red means the alarm persisted and an incident is open. Zones at risk counts map colours; open incidents counts operator cases — they can differ.",
        youWillSee:
          "An incident under Active on map, map panning to the zone, and updated metrics.",
        check: (ctx) => ctx.hasActiveIncident && ctx.hasSelection,
        action: async (d) => {
          if (!d.selectFirstRiskyZone()) {
            d.injectScenario("leak");
            await d.wait(600);
            d.selectFirstRiskyZone();
          }
          d.setSideTab("zone");
        },
      },
      {
        id: "context",
        title: "7. Read operational context",
        duration: "About 1 min",
        learn:
          "Before dispatching a crew, check what an operator can know: the time, today's weather, the published maintenance schedule and whether pressure fits the flow. Scheduled hydrant tests and valve work look like leaks in the readings.",
        youWillSee:
          "The Context tab with four cards, including a context check that says whether anything explains the alarm.",
        check: (ctx) => ctx.contextTabViewed && ctx.hasSelection,
        action: async (d) => {
          d.setSideTab("context");
          d.markContextViewed();
        },
      },
      {
        id: "workflow-false",
        title: "8. Close a false alarm (optional)",
        duration: "About 1 min",
        learn:
          "If context explains the alert, close it as a false alarm without dispatching. After closing, the dashboard reveals what the simulation really contained, so you can see whether the decision was right.",
        youWillSee:
          "The Action tab workflow; after closing, an outcome line and your running decision score.",
        check: (ctx) =>
          ctx.hasClosedFalseAlarm || ctx.skippedStepIds.includes("workflow-false"),
        actionDisabled: (ctx) => !ctx.hasOpenIncident,
        action: async (d) => {
          d.setSideTab("action");
          d.acknowledgeSelected();
        },
      },
      {
        id: "workflow-leak",
        title: "9. Complete the leak workflow",
        duration: "About 2 min",
        learn:
          "For a real leak, follow the ordered steps: Acknowledge → Create work order → Dispatch crew → Confirm leak. Only the next valid button is enabled at each stage.",
        youWillSee:
          "A work order ID (e.g. WO-1041), workflow steps turning green, the case closed as a confirmed leak, and the repaired zone returning to normal.",
        check: (ctx) => ctx.hasClosedLeak,
        action: async (d) => {
          if (!d.hasRiskyZone()) {
            d.injectScenario("leak");
            await d.wait(600);
            d.selectFirstRiskyZone();
          }
          d.setSideTab("action");
          const incident = d.getSelectedIncident();
          if (!incident || d.isIncidentClosed(incident)) {
            d.selectFirstRiskyZone();
          }
          const open = d.getOpenIncidentsForWorkflow?.() ?? [];
          if (!d.getSelectedIncident() && open.length) {
            d.selectIncidentById(open[0].id);
          }
          d.acknowledgeSelected();
          await d.wait(400);
          d.createTicketSelected();
          await d.wait(400);
          d.dispatchSelected();
          await d.wait(400);
          d.confirmLeakSelected();
        },
      },
      {
        id: "wrap",
        title: "10. Stop and explore on your own",
        duration: "About 30 sec",
        learn:
          "You have seen simulated data, detection, live updates, the context check and the operator workflow. Use the toolbar to compare detection methods or start a leak, unscheduled hydrant use or valve work.",
        youWillSee:
          "Simulation stopped. Header buttons work again so you can experiment freely.",
        check: (ctx) => !ctx.isLive,
        action: async (d) => {
          d.stopSimulation();
        },
      },
    ],
    deps
  );
}
