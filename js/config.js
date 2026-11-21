export const APP_PHASE = {
  IDLE: "idle",
  DATA_READY: "data_ready",
  MODEL_READY: "model_ready",
  LIVE: "live",
};

/** Real milliseconds per simulated hour in live mode. */
export const SIMULATION_MS = {
  slow: 3500,
  normal: 2000,
  fast: 900,
};

export const SIM = {
  seed: 53, // demo network: its test week has several leaks (the evaluation uses 40 other networks)
  historyDays: 28, // generated before live mode
  trainDays: 21, // days 1–21 fit the baseline and model; days 22–28 are the test week shown in the app
  autoClearHours: 3, // an untouched incident closes after this many normal hours
  chartHours: 48,
};
