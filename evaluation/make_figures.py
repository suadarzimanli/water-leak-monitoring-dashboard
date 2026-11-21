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
else:
    C = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
    INK, INK2, GRID, NEUTRAL, BG = "#0b0b0b", "#52514e", "#e6e5e0", "#c3c2b7", "#ffffff"
plt.rcParams.update({
    "figure.facecolor": BG, "axes.facecolor": BG, "savefig.facecolor": BG, "text.color": INK, "legend.labelcolor": INK,
    "font.family": "DejaVu Sans", "font.size": 8.5, "axes.edgecolor": INK2, "axes.labelcolor": INK2,
    "xtick.color": INK2, "ytick.color": INK2, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True,
    "savefig.bbox": "tight", "savefig.dpi": 300,
})

res = json.loads((HERE / "results.json").read_text(encoding="utf-8"))
ex = json.loads((HERE / "example.json").read_text(encoding="utf-8"))
METHODS = ["rules", "ml_naive", "ml", "ml_context"]
LABEL = {"rules": "Rules", "ml_naive": "ML, trained without look-alike events", "ml": "ML", "ml_context": "ML + context check"}
MCOL = {"rules": C[1], "ml_naive": C[3], "ml": C[0], "ml_context": C[2]}

# ---------- 1. example zone-week ----------
EVT = [("leak", "Leak", C[7]), ("hydrant_use", "Unscheduled hydrant use", C[3]), ("sensor_drift", "Pressure sensor drift", C[4]),
       ("valve_work", "Scheduled valve work", C[6]), ("hydrant_test", "Scheduled hydrant test", C[5]), ("demand_surge", "Demand peak", C[1])]
h = ex["hours"]
fig, axes = plt.subplots(3, 1, figsize=(6.4, 4.6), sharex=True, gridspec_kw={"height_ratios": [2, 2, 1.1]})
present = [e for e in EVT if any(e[0] in ev for ev in ex["events"])]
for ax in axes[:2]:
    for key, _, col in present:
        on = [key in ev for ev in ex["events"]]
        i = 0
        while i < len(on):
            if on[i]:
                j = i
                while j + 1 < len(on) and on[j + 1]:
                    j += 1
                ax.axvspan(h[i] - 0.5, h[j] + 0.5, color=col, alpha=0.18, lw=0)
                i = j + 1
            else:
                i += 1
axes[0].plot(h, ex["usualFlow"], color=INK2, lw=1, ls=(0, (4, 3)), label="Usual for the hour")
axes[0].plot(h, ex["flow"], color=C[0], lw=1.4, label="Flow")
axes[0].set_ylabel("Flow (L/s)")
axes[1].plot(h, ex["usualPressure"], color=INK2, lw=1, ls=(0, (4, 3)))
axes[1].plot(h, ex["pressure"], color=C[2], lw=1.4, label="Pressure")
axes[1].set_ylabel("Pressure (psi)")
names = [("ml_context", "ML + context"), ("ml", "ML"), ("rules", "Rules")]
for k, (m, lab) in enumerate(names):
    a = ex["alerts"][m]
    axes[2].bar([x for x, v in zip(h, a) if v], [0.7] * sum(a), bottom=k - 0.35, width=1.0, color=INK, lw=0)
axes[2].set_yticks(range(len(names)), [n for _, n in names])
axes[2].set_ylim(-0.6, len(names) - 0.4)
axes[2].grid(axis="y", visible=False)
axes[2].set_xlabel("Hours into the test week")
axes[2].set_title("Alerts (2 consecutive alarm hours)", fontsize=8.5, color=INK2, loc="left")
handles = [plt.Line2D([], [], color=C[0], lw=1.4, label="Flow"), plt.Line2D([], [], color=C[2], lw=1.4, label="Pressure"),
           plt.Line2D([], [], color=INK2, lw=1, ls=(0, (4, 3)), label="Usual for the hour")]
handles += [Patch(color=col, alpha=0.35, label=lab) for _, lab, col in present]
fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3, frameon=False, fontsize=7.5)
fig.savefig(OUT / ("fig-example" + EXT))
plt.close(fig)

# ---------- 2. trade-off: leaks caught vs false alerts ----------
fig, ax = plt.subplots(figsize=(6.4, 3.3))
for m in METHODS:
    xs, ys = [], []
    for k in (1, 2, 3):
        e = res["summary"][f"{m}|{k}"]
        x, y = e["falseAlertsPerZoneWeek"]["mean"], e["leaksDetected"] / e["leaks"]
        xs.append(x)
        ys.append(y)
        lo, hi = e["falseAlertsPerZoneWeek"]["ci"]
        ax.errorbar(x, y, xerr=[[x - lo], [hi - x]], color=MCOL[m], lw=0.9, capsize=2)
        ax.scatter(x, y, s=[46, 30, 18][k - 1], color=MCOL[m], zorder=3, edgecolor="white", linewidth=0.8)
        ax.annotate(f"K={k}", (x, y), xytext=(5, -3 if m != "ml_naive" else 4), textcoords="offset points", fontsize=7, color=INK2)
    ax.plot(xs, ys, color=MCOL[m], lw=1.2, label=LABEL[m])
ax.set_xlabel("False alerts per zone-week (lower is better)")
ax.set_ylabel("Share of leaks detected")
ax.set_ylim(0.65, 1.01)
ax.set_xlim(left=0)
ax.legend(frameon=False, fontsize=7.5, loc="lower right")
fig.savefig(OUT / ("fig-tradeoff" + EXT))
plt.close(fig)

# ---------- 3. what caused the false alerts (K = 2) ----------
CAUSES = [("hydrant_test", "Scheduled hydrant test"), ("valve_work", "Scheduled valve work"), ("demand_surge", "Demand peak"),
          ("hydrant_use", "Unscheduled hydrant use"), ("sensor_drift", "Pressure sensor drift"), ("none", "No event (weather, noise)")]
fig, ax = plt.subplots(figsize=(6.4, 2.5))
order = ["ml_context", "ml", "ml_naive", "rules"]
for i, m in enumerate(order):
    raw = res["summary"][f"{m}|2"]["falseAlertCauses"]
    vals = {k: 0 for k, _ in CAUSES}
    for key, n in raw.items():
        vals["none" if key.startswith("no event") else key] += n
    left = 0
    for j, (k, _) in enumerate(CAUSES):
        ax.barh(i, vals[k], left=left, color=C[j], height=0.6, edgecolor="white", linewidth=1)
        left += vals[k]
    ax.text(left + 8, i, f"{left}", va="center", fontsize=7.5, color=INK)
ax.set_yticks(range(len(order)), [LABEL[m] for m in order])
ax.set_xlabel("False alerts in 40 networks × 2 test weeks (alert after 2 alarm hours)")
ax.grid(axis="y", visible=False)
ax.legend(handles=[Patch(color=C[j], label=lab) for j, (_, lab) in enumerate(CAUSES)], loc="lower center",
          bbox_to_anchor=(0.45, 1.0), ncol=3, frameon=False, fontsize=7.2)
fig.savefig(OUT / ("fig-causes" + EXT))
plt.close(fig)
print("figures written to", OUT)
