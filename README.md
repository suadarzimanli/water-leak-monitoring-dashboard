# Urban Leak Monitoring Dashboard

An interactive teaching dashboard and simulation study on **leak alarms in a water distribution network**. It shows how leaks are detected from hourly flow and pressure, why many alarms are false, and what it costs to send a crew to each one.

**Live app:** https://suadarzimanli.github.io/water-leak-monitoring-dashboard/

> **Disclaimer.** Educational simulation. Zones are placed on an OpenStreetMap basemap for illustration only. Zone names, the network layout and all readings are fictional. Not affiliated with, endorsed by, or based on data from any water utility or public authority.

## What it does

- **Simulated SCADA.** Eight pressure zones report hourly flow and pressure. The simulation includes:
  - weekday and weekend demand (weekends start later and are flatter);
  - weather (hot days raise demand; cold snaps raise the risk of main breaks);
  - planned hydrant tests and valve work, published in a schedule that is realistic rather than perfect: some jobs are never announced, some announced jobs are cancelled, and jobs can start late;
  - unscheduled hydrant use and drifting pressure sensors;
  - hidden leaks that run until a crew repairs them — or until customers report them, 12–72 hours after they start.
- **Five detection methods**, compared side by side on the same test week:
  - **Rules:** flow up and pressure down, both far from usual for the day type and hour;
  - **EWMA:** a control chart of the leak evidence; it needs no leak labels;
  - **ML:** a logistic regression on deviation features, fitted in the browser;
  - **EWMA + context / ML + context:** the same alarm, set aside when information an operator has explains it (announced work, the day's weather, or low pressure without extra flow — a sensor problem).
- **Fair comparison.** Every method's threshold is set on the training days to the same false-alert budget (one per zone every two weeks). The methods are then compared by leaks caught, false alerts and **leak water saved**.
- **Incidents.** An incident opens after **two consecutive alarm hours**. An untouched incident clears itself after three normal hours. High-priority zones are listed first.
- **Operator workflow:** acknowledge → **dispatch a crew** (creates a work order), or close with no action.
  - The Context tab shows only what an operator would know.
  - The crew reports two network hours later: leak found and repaired (with the water saved), or nothing found — a wasted trip.
  - Leaks nobody catches are reported by customers. A running score counts repairs, wasted trips and leaks found by customers.
- **Guide and platforms:** a 10-step interactive guide, light and dark themes (the map stays light), and phone and desktop layouts.

## Key results

From the simulation study (`paper/urban-leak-monitoring.pdf`, `evaluation/results.md`): 40 independent simulated networks of 8 zones, 28 training and 14 test days each (393 test leaks); every threshold set to 0.5 false alerts per zone-week on the training days; an alert after 2 consecutive alarm hours.

| Method | Leaks caught | False alerts per zone-week | Leak water saved |
|---|---:|---:|---:|
| Rules | 337 / 393 | 0.56 | 86% |
| EWMA | 353 / 393 | 0.53 | 88% |
| **EWMA + context** | **382 / 393** | 0.52 | **93%** |
| ML | 328 / 393 | 0.55 | 86% |
| **ML + context** | **381 / 393** | 0.52 | **93%** |

- **Context matters more than the detector.** At the same false-alert rate, the context check adds 13 percentage points of leaks caught to the ML model (95% CI 9–17) and 7 to the EWMA chart. Rules, EWMA and ML alone differ by at most 6 points.
- **No labels needed.** With context, the label-free EWMA chart is as good as the supervised model.
- **Labels are fragile.** Trained on the labels a utility would really have (the hours before a customer report), the model catches only 142 of 393 leaks.
- **Robust.** The gain holds when only half the planned work is announced, with noisier sensors, smaller leaks and twice as many look-alike events.
- **Method:** designed on 40 development networks (seeds 1–40); the reported results use 40 different networks (seeds 2001–2040).

## Run it

No build step and no dependencies. Serve the folder over HTTP: ES modules do not load from `file://`.

```bash
python -m http.server 8080        # then open http://localhost:8080
```

On Windows you can double-click `start-server.bat`.

**First steps:** **Start guide**, or **1. Load data** → **2. Train model** → **Run live** (or **+1 hour**). Then use **Start a leak** or **Announced valve work** on the selected zone, and compare the detection methods.

The demo network uses seed 55, whose test week contains six leaks.

## Tests and evaluation

Node.js 18 or newer is enough; there are no packages to install.

```bash
node --test tests/                          # 21 tests: simulator, detection, metrics, workflow
node evaluation/run_experiments.mjs         # simulation study (~2.5 min) -> evaluation/results.{json,md}
node evaluation/run_experiments.mjs --dev   # the development networks used while designing
node evaluation/export_example.mjs          # example zone-week for the paper
python evaluation/make_figures.py           # paper figures (matplotlib)
```

The app and the evaluation share the same modules (`js/network.js`, `js/detect.js`, `js/metrics.js`), so the dashboard's test-week numbers are computed exactly as in the study. The detection and context code never read the simulator's truth (a test checks this).

## Project structure

```
index.html  css/styles.css  favicon.svg
js/
  network.js     simulated network: demand, weather, schedule, events, readings
  detect.js      baselines, rules, EWMA, logistic regression, context check, threshold calibration
  metrics.js     alert streams and measures (shared with the evaluation)
  app.js         dashboard state, incidents, crew reports, rendering
  workflow.js    incident workflow
  context.js     operator-facing context texts
  map.js charts.js theme.js user-guide.js zones.js config.js rng.js
tests/           node:test unit tests
evaluation/      simulation study and figures
paper/           research paper (LaTeX + PDF)
```

External libraries are loaded from CDNs at fixed versions with integrity checks: Leaflet 1.9.4 and Chart.js 4.4.1. Map tiles are © OpenStreetMap contributors.

## Licence and citation

Code: **MIT** (see [LICENSE](LICENSE)). The paper and figures in `paper/` are licensed under **CC BY 4.0**. Please cite using [CITATION.cff](CITATION.cff).
