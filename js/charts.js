/**
 * Zone history: flow (top) and pressure (bottom) as two stacked panels on one time axis,
 * each with the usual value for that hour of day as a dashed line. Two panels instead of a
 * dual-axis chart, so neither series can be read against the other's scale.
 */
let chartInstance = null;

/** `usualFor(row)` returns { flow, pressure } usual for that row's zone, day type and hour. */
export function renderZoneChart(canvas, history, usualFor, theme = {}) {
  const labels = history.map((row) =>
    row.timestamp.toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit" })
  );
  const text = theme.text ?? "#9fb0cc";
  const grid = theme.grid ?? "rgba(255,255,255,0.06)";
  const flowColor = theme.flow ?? "#2ea8ff";
  const presColor = theme.pressure ?? "#1dd3b0";
  const usual = theme.usual ?? "rgba(160,170,190,0.9)";

  const ds = (label, data, color, axis, dashed = false) => ({
    label,
    data,
    borderColor: dashed ? usual : color,
    backgroundColor: dashed ? "transparent" : `${color}22`,
    borderDash: dashed ? [5, 4] : undefined,
    borderWidth: dashed ? 1.5 : 2,
    pointRadius: 0,
    pointHoverRadius: dashed ? 0 : 4,
    tension: 0.25,
    yAxisID: axis,
  });

  const datasets = [ds("Flow (L/s)", history.map((r) => r.flowLps), flowColor, "yFlow")];
  if (usualFor) datasets.push(ds("Usual flow", history.map((r) => usualFor(r).flow), flowColor, "yFlow", true));
  datasets.push(ds("Pressure (psi)", history.map((r) => r.pressurePsi), presColor, "yPres"));
  if (usualFor) datasets.push(ds("Usual pressure", history.map((r) => usualFor(r).pressure), presColor, "yPres", true));

  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: text, boxWidth: 14, boxHeight: 2 } },
        tooltip: {
          callbacks: {
            label: (c) => ` ${c.dataset.label}: ${c.parsed.y.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: text, maxTicksLimit: 6, maxRotation: 0 }, grid: { color: grid } },
        yPres: {
          stack: "zone",
          stackWeight: 1,
          position: "left",
          title: { display: true, text: "Pressure (psi)", color: text },
          ticks: { color: text, maxTicksLimit: 4 },
          grid: { color: grid },
        },
        yFlow: {
          stack: "zone",
          stackWeight: 1,
          offset: true,
          position: "left",
          title: { display: true, text: "Flow (L/s)", color: text },
          ticks: { color: text, maxTicksLimit: 4 },
          grid: { color: grid },
        },
      },
    },
  });
  return chartInstance;
}

export function destroyZoneChart() {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
}
