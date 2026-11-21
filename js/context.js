/** Operator-facing context texts. Nothing here reads the simulator's hidden truth. */
import { EVENT } from "./network.js";

export function getTimeContext(hour) {
  if (hour < 5) return { label: "Night (minimum demand)", detail: "Flow should be at its lowest. Sustained extra flow at night is a classic leak sign." };
  if (hour < 10) return { label: "Morning peak", detail: "Demand rises steeply as people start the day; compare with the usual value for this hour." };
  if (hour < 17) return { label: "Daytime", detail: "Moderate demand. Scheduled work usually happens in these hours." };
  if (hour < 22) return { label: "Evening peak", detail: "Second daily peak; high flow alone is expected." };
  return { label: "Late evening", detail: "Demand tapers off towards the night minimum." };
}

/** Labels for the simulator's event types, used only after an incident is closed. */
export function describeEvent(type) {
  return (
    {
      [EVENT.LEAK]: "a leak",
      [EVENT.HYDRANT_TEST]: "a scheduled hydrant test",
      [EVENT.VALVE_WORK]: "scheduled valve work",
      [EVENT.HYDRANT_USE]: "unscheduled hydrant use",
      [EVENT.SENSOR_DRIFT]: "a drifting pressure sensor",
      [EVENT.DEMAND_SURGE]: "a demand peak",
    }[type] ?? type
  );
}

export function formatHourWindow(startIndex, endIndex, hourOfIndex) {
  const pad = (h) => `${String(h).padStart(2, "0")}:00`;
  return `${pad(hourOfIndex(startIndex))}–${pad(hourOfIndex(endIndex) || 24)}`;
}
