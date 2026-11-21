# Urban Leak Monitoring Dashboard

An interactive teaching dashboard and simulation study on **leak alarms in a water distribution network**. It shows how leaks are detected from hourly flow and pressure, and why many alarms are false, and it lets you work each incident from alert to close-out.

**Live app:** https://suadarzimanli.github.io/water-leak-monitoring-dashboard/

> **Disclaimer.** Educational simulation. Zones are placed on an OpenStreetMap basemap for illustration only. Zone names, the network layout and all readings are fictional. Not affiliated with, endorsed by, or based on data from any water utility or public authority.

## What it does

- **Simulated SCADA.** Eight pressure zones report hourly flow and pressure. The simulation includes:
  - a morning and an evening demand peak;
  - weather (hot days raise demand; cold snaps raise the risk of main breaks);
  - scheduled hydrant tests and valve work, published in advance;
  - unscheduled hydrant use;
  - drifting pressure sensors;
  - hidden leaks that persist until repaired.
- **Three detection methods**, all compared on the same simulated test week:
  - **Rules:** flow and pressure both far from their usual value for that hour;
  - **ML:** a logistic regression on deviation features, fitted in the browser;
  - **ML + context check:** ML, but an alarm is set aside when information an operator actually has explains it (the published schedule, the day's weather, or whether pressure fits the flow).
- **Honest measures.** It reports leaks caught and false alerts rather than accuracy, which is misleading when leaks are rare.
- **Incidents.** An incident opens after **two consecutive abnormal hours**. An untouched incident clears itself after three normal hours.
- **Operator workflow:** acknowledge → work order → dispatch → confirm leak, or close as a false alarm.
  - The context tab shows only operator-visible information.
  - After closing, the dashboard reveals what the simulation really contained and keeps a score of your decisions.
  - Confirming a leak repairs it in the simulation.
- **Guide and platforms:** a 10-step interactive guide, light and dark themes (the map stays light), and phone and desktop layouts.

## Key results

The figures come from the simulation study (`paper/urban-leak-monitoring.pdf`, `evaluation/results.md`):
- 40 independent simulated networks, each with 8 zones;
- 28 training days and 14 test days per network (400 test leaks);
- an alert after 2 consecutive alarm hours.

| Method | Leaks detected | False alerts per zone-week | Precision (hours) |
|---|---:|---:|---:|
| Rules | 308 / 400 | 0.41 | 0.95 |
| ML | 376 / 400 | 1.02 | 0.81 |
| **ML + context check** | **369 / 400** | **0.19** | **0.97** |

- **ML vs rules:** ML catches more leaks than the rules but raises 2.5× as many false alerts.
- **The context check** removes **81% of ML's false alerts** (95% CI of the difference: −1.01 to −0.67 per zone-week) and loses 7 of 400 leaks.
- **Training data:** training the model *without* the leak-like events (hydrant tests, valve work, demand peaks) gives no more false alerts than training with them, while catching slightly more leaks. The readings alone cannot separate these events from leaks; the schedule and weather can.
- **Method:** the detectors were designed on 40 development networks (seeds 1–40). The reported results use 40 different networks (seeds 1001–1040).

## Run it

No build step and no dependencies. Serve the folder over HTTP: ES modules do not load from `file://`.

```bash
python -m http.server 8080        # then open http://localhost:8080
```

On Windows you can double-click `start-server.bat`.

**First steps:** **Start guide**, or **1. Generate Data** → **2. Train Model** → **3. Live simulation**. Then use **Start a leak** or **Add valve work now** and compare the detection modes.

The demo network uses seed 53, whose test week contains several leaks.

## Tests and evaluation

Node.js 18 or newer is enough; there are no packages to install.

```bash
node --test tests/                          # 17 tests: simulator, detection, metrics, workflow
node evaluation/run_experiments.mjs         # simulation study (~7 s) -> evaluation/results.{json,md}
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
  detect.js      baselines, rules, logistic regression, context check
  metrics.js     alert streams and measures (shared with the evaluation)
  app.js         dashboard state, incidents, rendering
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
