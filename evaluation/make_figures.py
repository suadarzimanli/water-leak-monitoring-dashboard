#!/usr/bin/env python3
"""Paper figures from evaluation/results.json and evaluation/example.json.

    node evaluation/run_experiments.mjs && node evaluation/export_example.mjs
    python evaluation/make_figures.py            # -> paper/figures/*.pdf
    python evaluation/make_figures.py --dark DIR # dark-background PNG versions (e.g. for a website)
"""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("--dark", type=Path, metavar="DIR")
ARGS = ap.parse_args()
DARK = ARGS.dark is not None
OUT = ARGS.dark if DARK else HERE.parent / "paper" / "figures"
OUT.mkdir(parents=True, exist_ok=True)
EXT = ".png" if DARK else ".pdf"

# reference categorical palette, fixed order (light steps, or dark steps on a dark background)
if DARK:
    C = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"]
    INK, INK2, GRID, NEUTRAL, BG = "#f0efec", "#c3c2b7", "#2a2f38", "#4a5260", "#14171c"
    NOGREY = "#7d828c"
else:
    C = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
    INK, INK2, GRID, NEUTRAL, BG = "#0b0b0b", "#52514e", "#e6e5e0", "#c3c2b7", "#ffffff"
    NOGREY = "#a3a29b"
plt.rcParams.update({
    "figure.facecolor": BG, "axes.facecolor": BG, "savefig.facecolor": BG, "text.color": INK, "legend.labelcolor": INK,
    "font.family": "DejaVu Sans", "font.size": 8.5, "axes.edgecolor": INK2, "axes.labelcolor": INK2,
    "xtick.color": INK2, "ytick.color": INK2, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True,
    "savefig.bbox": "tight", "savefig.dpi": 300,
})

res = json.loads((HERE / "results.json").read_text(encoding="utf-8"))
ex = json.loads((HERE / "example.json").read_text(encoding="utf-8"))
CORE = ["rules", "ewma", "ewma_context", "ml", "ml_context"]
LABEL = {"rules": "Rules", "ewma": "EWMA", "ewma_context": "EWMA + context", "ml": "ML", "ml_context": "ML + context"}
MCOL = {m: C[i] for i, m in enumerate(CORE)}  # fixed categorical order
MLS = {"rules": "-", "ewma": "-", "ewma_context": "-", "ml": (0, (4, 2)), "ml_context": (0, (4, 2))}
N_NETS = res["seeds"][1] - res["seeds"][0] + 1


def spans(on):
    i = 0
    while i < len(on):
        if on[i]:
            j = i
            while j + 1 < len(on) and on[j + 1]:
                j += 1
            yield i, j
            i = j + 1
        else:
            i += 1


# ---------- 1. example zone-week ----------
EVT = [("leak", "Leak", C[7]), ("hydrant_use", "Unscheduled hydrant use", C[3]), ("sensor_drift", "Pressure sensor drift", C[6]),
       ("valve_work", "Valve work", C[4]), ("hydrant_test", "Hydrant test", C[5]), ("demand_surge", "Demand peak", C[1])]
HATCH = {"sensor_drift": "////"}
h = ex["hours"]
fig, axes = plt.subplots(3, 1, figsize=(6.4, 4.8), sharex=True, gridspec_kw={"height_ratios": [2, 2, 1.4]})
present = [e for e in EVT if any(e[0] in ev for ev in ex["events"])]
for ax in axes[:2]:
    for key, _, col in present:
        for i, j in spans([key in ev for ev in ex["events"]]):
            ax.axvspan(h[i] - 0.5, h[j] + 0.5, facecolor=col, alpha=0.22, lw=0, hatch=HATCH.get(key), edgecolor=col)
for key, lab, col in present:
    for i, j in spans([key in ev for ev in ex["events"]]):
        if j - i >= 6:  # direct label on wide spans
            axes[0].text((h[i] + h[j]) / 2, 1.0, lab.replace("Pressure sensor drift", "Sensor drift"), transform=axes[0].get_xaxis_transform(),
                         ha="center", va="bottom", fontsize=7, color=INK2)
axes[0].plot(h, ex["usualFlow"], color=INK2, lw=1, ls=(0, (4, 3)))
axes[0].plot(h, ex["flow"], color=C[0], lw=1.4)
axes[0].set_ylabel("Flow (L/s)")
axes[1].plot(h, ex["usualPressure"], color=INK2, lw=1, ls=(0, (4, 3)))
axes[1].plot(h, ex["pressure"], color=C[2], lw=1.4)
axes[1].set_ylabel("Pressure (psi)")
rows = [m for m in ["ml_context", "ewma_context", "ewma", "rules"] if m in ex["alerts"]]
for k, m in enumerate(rows):
    for i, j in spans([bool(v) for v in ex["alerts"][m]]):
        axes[2].broken_barh([(h[i] - 0.5, h[j] - h[i] + 1)], (k - 0.3, 0.6), color=INK, lw=0)
axes[2].set_yticks(range(len(rows)), [LABEL[m] for m in rows])
axes[2].set_ylim(-0.6, len(rows) - 0.4)
axes[2].grid(axis="y", visible=False)
axes[2].set_xlabel("Hours into the test week")
axes[2].set_title("Alerts (2 consecutive alarm hours)", fontsize=8.5, color=INK2, loc="left")
handles = [plt.Line2D([], [], color=C[0], lw=1.4, label="Flow"), plt.Line2D([], [], color=C[2], lw=1.4, label="Pressure"),
           plt.Line2D([], [], color=INK2, lw=1, ls=(0, (4, 3)), label="Usual for the day type and hour")]
handles += [Patch(facecolor=col, alpha=0.45, hatch=HATCH.get(k), edgecolor=col, label=lab) for k, lab, col in present]
fig.tight_layout(rect=(0, 0, 1, 0.97))
fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.985), ncol=3, frameon=False, fontsize=7.5)
fig.savefig(OUT / ("fig-example" + EXT))
plt.close(fig)

# ---------- 2. trade-off: water saved vs false alerts across budgets ----------
budgets = sorted(res["budgets"], key=float)
fig, ax = plt.subplots(figsize=(6.4, 3.4))
for m in CORE:
    xs, ys = [], []
    for k, b in enumerate(budgets):
        e = res["budgets"][b][m]
        x, y = e["falseAlertsPerZoneWeek"]["mean"], e["waterSavedShare"]["mean"] * 100
        lo, hi = e["falseAlertsPerZoneWeek"]["ci"]
        ylo, yhi = (v * 100 for v in e["waterSavedShare"]["ci"])
        ax.errorbar(x, y, xerr=[[x - lo], [hi - x]], yerr=[[y - ylo], [yhi - y]], color=MCOL[m], lw=0.8, capsize=1.5, zorder=2)
        xs.append(x)
        ys.append(y)
    ax.plot(xs, ys, color=MCOL[m], lw=1.6, ls=MLS[m], marker="o", ms=4.5, mec=BG, mew=0.8, label=LABEL[m], zorder=3)
ax.set_xlabel("False alerts per zone-week (wasted crew trips; lower is better)")
ax.set_ylabel("Leak water saved (%)")
ax.set_xlim(left=0)
ax.legend(frameon=False, fontsize=7.5, loc="lower right")
fig.savefig(OUT / ("fig-tradeoff" + EXT))
plt.close(fig)

# ---------- 3. what caused the false alerts (default budget) ----------
CAUSES = [("announced", "Announced work"), ("unannounced", "Unannounced or moved work"), ("demand_surge", "Demand peak"),
          ("hydrant_use", "Unscheduled hydrant use"), ("sensor_drift", "Pressure sensor drift"), ("none", "No event (weather, noise)")]


def cause_group(key):
    if key.startswith("no event"):
        return "none"
    if "(unannounced)" in key:
        return "unannounced"
    if key in ("valve_work", "hydrant_test"):
        return "announced"
    return key


CAUSE_COL = C[:5] + [NOGREY]
fig, ax = plt.subplots(figsize=(6.4, 2.7))
order = list(reversed(CORE))
for i, m in enumerate(order):
    vals = {k: 0 for k, _ in CAUSES}
    for key, n in res["main"][m]["causes"].items():
        vals[cause_group(key)] += n
    left = 0
    for j, (k, _) in enumerate(CAUSES):
        ax.barh(i, vals[k], left=left, color=CAUSE_COL[j], height=0.6, edgecolor=BG, linewidth=1)
        left += vals[k]
    ax.text(left + 6, i, f"{left}", va="center", fontsize=7.5, color=INK)
ax.set_yticks(range(len(order)), [LABEL[m] for m in order])
ax.set_xlabel(f"False alerts in {N_NETS} networks × 2 test weeks (same false-alert budget for every method)")
ax.grid(axis="y", visible=False)
ax.legend(handles=[Patch(color=CAUSE_COL[j], label=lab) for j, (_, lab) in enumerate(CAUSES)], loc="lower center",
          bbox_to_anchor=(0.45, 1.0), ncol=3, frameon=False, fontsize=7.2)
fig.savefig(OUT / ("fig-causes" + EXT))
plt.close(fig)

# ---------- 4. schedule reliability ----------
SCHED = [("perfect", "All work\nannounced"), ("realistic", "90% announced\n(default)"), ("poor", "75%\nannounced"), ("unreliable", "50%\nannounced")]
SCHED = [s for s in SCHED if s[0] in res["schedules"]]
fig, axes = plt.subplots(1, 2, figsize=(6.4, 2.7))
for ax, key, ylab, scale in [(axes[0], "leakRecall", "Leaks detected (%)", 100), (axes[1], "falseAlertsPerZoneWeek", "False alerts per zone-week", 1)]:
    for m in CORE:
        ys = [res["schedules"][s][m][key]["mean"] * scale for s, _ in SCHED]
        ax.plot(range(len(SCHED)), ys, color=MCOL[m], lw=1.6, ls=MLS[m], marker="o", ms=4, mec=BG, mew=0.8, label=LABEL[m])
    ax.set_xticks(range(len(SCHED)), [lab for _, lab in SCHED], fontsize=7.2)
    ax.set_ylabel(ylab)
    ax.grid(axis="x", visible=False)
axes[1].set_ylim(bottom=0)
handles, labels = axes[0].get_legend_handles_labels()
fig.legend(handles, labels, loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=5, frameon=False, fontsize=7.5)
fig.tight_layout()
fig.savefig(OUT / ("fig-schedules" + EXT))
plt.close(fig)
print("figures written to", OUT)
