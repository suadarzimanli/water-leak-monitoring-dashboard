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
        learn: "Every session begins empty: no readings, no model, no open incidents.",
        youWillSee: "Counters at zero, map status Ready and an empty incident list.",
        check: (ctx) => ctx.guideResetDone,
        action: async (d) => {
          d.resetDemo();
          d.markGuideResetDone();
        },
      },
      {
        id: "generate",
        title: "2. Load the simulated network",
        duration: "About 1 min",
        learn:
          "28 days of hourly flow and pressure for 8 fictional zones: weekday and weekend demand, weather, planned work (not always announced), hydrant use, sensor drift and hidden leaks. Rules and the EWMA detector are calibrated on days 1–21.",
        youWillSee: "Map markers, the announced schedule, and the detection comparison for the test week (days 22–28).",
        check: (ctx) => ctx.hasData,
        action: async (d) => d.generateData(),
      },
      {
        id: "train",
        title: "3. Train the ML model",
        duration: "About 1 min",
        learn:
          "A logistic regression is fitted on days 1–21. Every method's alarm threshold is set to the same false-alert budget, so the comparison shows which one catches more leaks and saves more water at the same cost in wasted trips.",
        youWillSee: "ML and ML + context rows filled in the detection comparison.",
        check: (ctx) => ctx.hasModel,
        action: async (d) => d.trainModel(),
      },
      {
        id: "select-zone",
        title: "4. Explore a zone",
        duration: "About 45 sec",
        learn: "Select a marker to see flow and pressure against the usual values for that hour and day type, and the alarm level of the detector in use.",
        youWillSee: "The Zone tab with readings, alarm level and a two-panel history chart.",
        check: (ctx) => ctx.zoneInspectDone,
        action: async (d) => {
          d.selectFirstZone();
          d.setSideTab("zone");
          d.markZoneInspectDone();
        },
      },
      {
        id: "simulate",
        title: "5. Let the network run",
        duration: "About 1 min",
        learn:
          "Each tick is one network hour for all zones. An incident opens after two consecutive abnormal hours; an untouched incident clears itself after three normal hours. Leaks nobody catches are eventually reported by customers.",
        youWillSee: "Map status Live and the network clock advancing. Use Pause and “+1 hour” to step manually.",
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
          "Orange means watch (one abnormal hour) or an alarm the context explains; red means the alarm persisted and an incident is open. If nothing is flagged, the guide starts a leak in the selected zone.",
        youWillSee: "An incident in the list (high-priority zones first) and the map panning to it.",
        check: (ctx) => ctx.hasActiveIncident && ctx.hasSelection,
        action: async (d) => {
          d.stopSimulation();
          if (!d.selectFirstRiskyZone()) d.injectScenario("leak");
          d.setSideTab("zone");
        },
      },
      {
        id: "context",
        title: "7. Read the operational context",
        duration: "About 1 min",
        learn:
          "Before sending a crew, check what an operator can know: the time and day, today's weather, announced work in the zone and whether pressure fits the flow. Planned work looks like a leak in the readings — but not all of it is announced.",
        youWillSee: "Four context cards, including a context check that says whether anything explains the alarm.",
        check: (ctx) => ctx.contextTabViewed && ctx.hasSelection,
        action: async (d) => {
          d.setSideTab("context");
          d.markContextViewed();
        },
      },
      {
        id: "workflow-noaction",
        title: "8. Close a case without a visit (optional)",
        duration: "About 1 min",
        learn:
          "If the context explains an alarm, acknowledge it and close it with “no action needed”. The dashboard then reveals what the simulation contained — including the leaks such decisions miss.",
        youWillSee: "The Action tab; after closing, an outcome line and the running score.",
        check: (ctx) => ctx.hasClosedNoAction || ctx.skippedStepIds.includes("workflow-noaction"),
        actionDisabled: (ctx) => !ctx.hasOpenIncident,
        action: async (d) => {
          d.stopSimulation();
          d.setSideTab("action");
          d.runAction("ack");
          await d.wait(300);
          d.runAction("noaction");
        },
      },
      {
        id: "workflow-dispatch",
        title: "9. Dispatch a crew and read its report",
        duration: "About 2 min",
        learn:
          "Acknowledge, then dispatch: the work order is created and a crew goes out. Two network hours later the crew reports what it found — a leak, which it repairs, or nothing (a wasted trip).",
        youWillSee: "Crew on the way, then the case closed by the crew's report and the water saved compared with waiting for customer reports.",
        check: (ctx) => ctx.hasCrewReport,
        action: async (d) => {
          d.stopSimulation();
          let open = d.getOpenIncidentsForWorkflow();
          if (!open.length) {
            d.injectScenario("leak");
            open = d.getOpenIncidentsForWorkflow();
          }
          const target = d.getSelectedIncident() && !d.isIncidentClosed(d.getSelectedIncident()) ? d.getSelectedIncident() : open[0];
          if (!target) return;
          d.selectIncidentById(target.id);
          d.runAction("ack");
          await d.wait(300);
          d.runAction("dispatch");
          await d.wait(300);
          d.advanceHours(2);
          d.selectIncidentById(target.id);
        },
      },
      {
        id: "wrap",
        title: "10. Explore on your own",
        duration: "About 30 sec",
        learn:
          "Try the detection methods in the comparison, select a zone and start a leak, unscheduled hydrant use or announced valve work, and watch which alarms the context check sets aside.",
        youWillSee: "Simulation paused; all controls available again.",
        check: (ctx) => !ctx.isLive,
        action: async (d) => d.stopSimulation(),
      },
    ],
    deps
  );
}
