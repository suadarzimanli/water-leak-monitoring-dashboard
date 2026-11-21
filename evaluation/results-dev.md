# Simulation study results

40 networks (seeds 1–40), 8 zones, train 28 days, test 14 days. Thresholds calibrated on training to 0.5 false alerts per zone-week; alert after 2 alarm hours; realistic schedule (90% of planned jobs announced, 5% of announced jobs cancelled, up to 1 h late).

## Main comparison

| Method | Leaks detected | False alerts / zone-week | Water saved | Median hours to detect |
|---|---:|---:|---:|---:|
| rules | 337/399 | 0.55 [0.47, 0.66] | 85% [81%, 88%] | 1.1 |
| ewma | 359/399 | 0.57 [0.49, 0.66] | 87% [85%, 89%] | 2.1 |
| ewma_context | 392/399 | 0.47 [0.38, 0.56] | 93% [93%, 94%] | 1.1 |
| ml | 345/399 | 0.58 [0.50, 0.67] | 86% [83%, 89%] | 1.7 |
| ml_context | 392/399 | 0.48 [0.41, 0.55] | 93% [93%, 94%] | 1.0 |
| ml_records | 155/399 | 0.29 [0.22, 0.38] | 36% [29%, 43%] | 9.1 |
| ml_records_context | 322/399 | 0.15 [0.10, 0.20] | 77% [70%, 83%] | 3.5 |
| ml_naive | 397/399 | 1.56 [1.39, 1.75] | 94% [94%, 95%] | 1.0 |

Paired differences (by network):

- ml_context − ml | leakRecall: 0.131 [0.092, 0.175]
- ml_context − ml | falseAlertsPerZoneWeek: -0.100 [-0.203, -0.006]
- ml_context − ml | waterSavedShare: 0.070 [0.046, 0.097]
- ewma_context − ewma | leakRecall: 0.094 [0.062, 0.127]
- ewma_context − ewma | falseAlertsPerZoneWeek: -0.105 [-0.228, 0.008]
- ewma_context − ewma | waterSavedShare: 0.061 [0.043, 0.082]
- ewma_context − ml_context | leakRecall: 0.000 [-0.008, 0.011]
- ewma_context − ml_context | falseAlertsPerZoneWeek: -0.013 [-0.075, 0.053]
- ewma_context − ml_context | waterSavedShare: -0.001 [-0.004, 0.002]
- ml − rules | leakRecall: 0.017 [-0.022, 0.060]
- ml − rules | falseAlertsPerZoneWeek: 0.027 [-0.059, 0.103]
- ml − rules | waterSavedShare: 0.014 [-0.010, 0.041]
- ewma − rules | leakRecall: 0.055 [0.021, 0.091]
- ewma − rules | falseAlertsPerZoneWeek: 0.019 [-0.045, 0.083]
- ewma − rules | waterSavedShare: 0.021 [0.001, 0.044]
- ml_records − ml | leakRecall: -0.463 [-0.536, -0.387]
- ml_records − ml | falseAlertsPerZoneWeek: -0.287 [-0.364, -0.212]
- ml_records − ml | waterSavedShare: -0.509 [-0.587, -0.428]
- ml − ml_naive | leakRecall: -0.142 [-0.188, -0.099]
- ml − ml_naive | falseAlertsPerZoneWeek: -0.983 [-1.137, -0.836]
- ml − ml_naive | waterSavedShare: -0.079 [-0.106, -0.052]
- ewma_context − rules | leakRecall: 0.148 [0.102, 0.197]
- ewma_context − rules | falseAlertsPerZoneWeek: -0.086 [-0.220, 0.033]
- ewma_context − rules | waterSavedShare: 0.083 [0.052, 0.116]

False alerts by cause:

- rules: {"hydrant_use":45,"valve_work":73,"demand_surge":83,"hydrant_test":83,"no event (heat day)":31,"hydrant_test (unannounced)":13,"sensor_drift":18,"valve_work (unannounced)":8}
- ewma: {"hydrant_use":21,"valve_work":40,"demand_surge":115,"hydrant_test":49,"sensor_drift":56,"no event (clear day)":25,"no event (rain day)":10,"no event (heat day)":33,"no event (cold day)":6,"hydrant_test (unannounced)":6,"valve_work (unannounced)":5}
- ewma_context: {"hydrant_use":40,"demand_surge":2,"no event (clear day)":69,"hydrant_test (unannounced)":13,"no event (cold day)":82,"sensor_drift":67,"no event (heat day)":7,"no event (rain day)":8,"valve_work (unannounced)":11}
- ml: {"hydrant_use":27,"valve_work":71,"demand_surge":93,"no event (clear day)":21,"hydrant_test (unannounced)":9,"sensor_drift":65,"hydrant_test":58,"no event (heat day)":10,"no event (cold day)":4,"no event (rain day)":5,"valve_work (unannounced)":8}
- ml_context: {"hydrant_use":43,"demand_surge":2,"no event (clear day)":80,"hydrant_test (unannounced)":13,"sensor_drift":78,"no event (heat day)":13,"no event (cold day)":58,"valve_work (unannounced)":13,"no event (rain day)":7}
- ml_records: {"sensor_drift":77,"demand_surge":78,"valve_work":13,"no event (heat day)":9,"hydrant_test":3,"hydrant_use":1,"no event (clear day)":4,"hydrant_test (unannounced)":1,"no event (cold day)":1}
- ml_records_context: {"hydrant_use":10,"sensor_drift":46,"no event (clear day)":17,"no event (cold day)":6,"no event (rain day)":3,"no event (heat day)":4,"hydrant_test (unannounced)":4,"valve_work (unannounced)":6}
- ml_naive: {"no event (heat day)":310,"hydrant_use":46,"valve_work":121,"hydrant_test":85,"demand_surge":169,"no event (clear day)":128,"hydrant_test (unannounced)":11,"sensor_drift":60,"no event (cold day)":39,"valve_work (unannounced)":14,"no event (rain day)":17}

## False-alert budget (per zone-week, set on training)

| | rules | ewma | ewma_context | ml | ml_context |
|---|---|---|---|---|---|
| 0.25 | 222/399 · FA 0.24 · saved 61% | 335/399 · FA 0.29 · saved 83% | 377/399 · FA 0.24 · saved 90% | 295/399 · FA 0.31 · saved 79% | 370/399 · FA 0.24 · saved 90% |
| 0.5 | 337/399 · FA 0.55 · saved 85% | 359/399 · FA 0.57 · saved 87% | 392/399 · FA 0.47 · saved 93% | 345/399 · FA 0.58 · saved 86% | 392/399 · FA 0.48 · saved 93% |
| 1 | 380/399 · FA 1.19 · saved 92% | 389/399 · FA 1.10 · saved 92% | 393/399 · FA 0.90 · saved 94% | 378/399 · FA 1.04 · saved 91% | 394/399 · FA 0.99 · saved 94% |
| 2 | 392/399 · FA 2.33 · saved 94% | 396/399 · FA 1.97 · saved 94% | 393/399 · FA 1.89 · saved 94% | 394/399 · FA 2.11 · saved 94% | 394/399 · FA 1.96 · saved 94% |

## Persistence (alarm hours before an alert)

| | rules | ewma | ewma_context | ml | ml_context |
|---|---|---|---|---|---|
| 1 | 250/399 · FA 0.48 · saved 70% | 337/399 · FA 0.55 · saved 86% | 383/399 · FA 0.51 · saved 94% | 295/399 · FA 0.52 · saved 79% | 371/399 · FA 0.54 · saved 92% |
| 2 | 337/399 · FA 0.55 · saved 85% | 359/399 · FA 0.57 · saved 87% | 392/399 · FA 0.47 · saved 93% | 345/399 · FA 0.58 · saved 86% | 392/399 · FA 0.48 · saved 93% |
| 3 | 379/399 · FA 0.76 · saved 89% | 366/399 · FA 0.59 · saved 87% | 391/399 · FA 0.52 · saved 91% | 363/399 · FA 0.57 · saved 88% | 392/399 · FA 0.49 · saved 91% |

## Reliability of the published schedule

| | rules | ewma | ewma_context | ml | ml_context |
|---|---|---|---|---|---|
| perfect {"announced":1,"cancelled":0,"maxDelay":0} | 336/399 · FA 0.53 · saved 84% | 355/399 · FA 0.57 · saved 87% | 393/399 · FA 0.47 · saved 93% | 340/399 · FA 0.59 · saved 86% | 393/399 · FA 0.49 · saved 93% |
| realistic {"announced":0.9,"cancelled":0.05,"maxDelay":1} | 337/399 · FA 0.55 · saved 85% | 359/399 · FA 0.57 · saved 87% | 392/399 · FA 0.47 · saved 93% | 345/399 · FA 0.58 · saved 86% | 392/399 · FA 0.48 · saved 93% |
| poor {"announced":0.75,"cancelled":0.1,"maxDelay":2} | 340/399 · FA 0.56 · saved 86% | 361/399 · FA 0.58 · saved 87% | 390/399 · FA 0.44 · saved 93% | 345/399 · FA 0.62 · saved 87% | 387/399 · FA 0.46 · saved 93% |
| unreliable {"announced":0.5,"cancelled":0.2,"maxDelay":2} | 341/399 · FA 0.58 · saved 86% | 361/399 · FA 0.58 · saved 87% | 388/399 · FA 0.41 · saved 92% | 344/399 · FA 0.59 · saved 87% | 382/399 · FA 0.43 · saved 92% |

## Simulator sensitivity

| | rules | ewma | ewma_context | ml | ml_context |
|---|---|---|---|---|---|
| base | 337/399 · FA 0.55 · saved 85% | 359/399 · FA 0.57 · saved 87% | 392/399 · FA 0.47 · saved 93% | 345/399 · FA 0.58 · saved 86% | 392/399 · FA 0.48 · saved 93% |
| noisier | 343/399 · FA 0.55 · saved 86% | 346/399 · FA 0.58 · saved 86% | 389/399 · FA 0.48 · saved 93% | 324/399 · FA 0.59 · saved 83% | 390/399 · FA 0.47 · saved 93% |
| smallerLeaks | 304/399 · FA 0.56 · saved 78% | 333/399 · FA 0.57 · saved 82% | 385/399 · FA 0.46 · saved 92% | 313/399 · FA 0.62 · saved 81% | 384/399 · FA 0.47 · saved 92% |
| moreLookAlikes | 251/408 · FA 0.48 · saved 70% | 343/408 · FA 0.53 · saved 84% | 395/408 · FA 0.52 · saved 92% | 298/408 · FA 0.60 · saved 78% | 384/408 · FA 0.53 · saved 91% |

(150 s)
