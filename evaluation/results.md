# Simulation study results

40 networks (seeds 2001–2040), 8 zones, train 28 days, test 14 days. Thresholds calibrated on training to 0.5 false alerts per zone-week; alert after 2 alarm hours; realistic schedule (90% of planned jobs announced, 5% of announced jobs cancelled, up to 1 h late).

## Main comparison

| Method | Leaks detected | False alerts / zone-week | Water saved | Median hours to detect |
|---|---:|---:|---:|---:|
| rules | 337/393 | 0.56 [0.48, 0.65] | 86% [83%, 89%] | 1.1 |
| ewma | 353/393 | 0.53 [0.45, 0.62] | 88% [86%, 90%] | 1.8 |
| ewma_context | 382/393 | 0.52 [0.45, 0.60] | 93% [93%, 94%] | 1.0 |
| ml | 328/393 | 0.55 [0.47, 0.63] | 86% [83%, 89%] | 1.3 |
| ml_context | 381/393 | 0.52 [0.44, 0.60] | 93% [93%, 94%] | 1.0 |
| ml_records | 142/393 | 0.29 [0.23, 0.34] | 31% [24%, 39%] | 10.8 |
| ml_records_context | 282/393 | 0.12 [0.07, 0.17] | 68% [59%, 77%] | 3.9 |
| ml_naive | 383/393 | 1.49 [1.31, 1.68] | 94% [94%, 95%] | 1.0 |

Paired differences (by network):

- ml_context − ml | leakRecall: 0.130 [0.090, 0.170]
- ml_context − ml | falseAlertsPerZoneWeek: -0.034 [-0.125, 0.056]
- ml_context − ml | waterSavedShare: 0.068 [0.045, 0.096]
- ewma_context − ewma | leakRecall: 0.069 [0.039, 0.105]
- ewma_context − ewma | falseAlertsPerZoneWeek: -0.011 [-0.103, 0.084]
- ewma_context − ewma | waterSavedShare: 0.051 [0.034, 0.071]
- ewma_context − ml_context | leakRecall: 0.002 [0.000, 0.006]
- ewma_context − ml_context | falseAlertsPerZoneWeek: 0.005 [-0.047, 0.059]
- ewma_context − ml_context | waterSavedShare: -0.000 [-0.002, 0.002]
- ml − rules | leakRecall: -0.012 [-0.048, 0.025]
- ml − rules | falseAlertsPerZoneWeek: -0.011 [-0.078, 0.058]
- ml − rules | waterSavedShare: 0.000 [-0.016, 0.018]
- ewma − rules | leakRecall: 0.050 [0.023, 0.080]
- ewma − rules | falseAlertsPerZoneWeek: -0.030 [-0.091, 0.036]
- ewma − rules | waterSavedShare: 0.017 [0.002, 0.033]
- ml_records − ml | leakRecall: -0.481 [-0.554, -0.405]
- ml_records − ml | falseAlertsPerZoneWeek: -0.264 [-0.338, -0.194]
- ml_records − ml | waterSavedShare: -0.550 [-0.624, -0.471]
- ml − ml_naive | leakRecall: -0.138 [-0.179, -0.096]
- ml − ml_naive | falseAlertsPerZoneWeek: -0.944 [-1.120, -0.781]
- ml − ml_naive | waterSavedShare: -0.077 [-0.104, -0.053]
- ewma_context − rules | leakRecall: 0.120 [0.081, 0.167]
- ewma_context − rules | falseAlertsPerZoneWeek: -0.041 [-0.144, 0.063]
- ewma_context − rules | waterSavedShare: 0.068 [0.042, 0.098]

False alerts by cause:

- rules: {"hydrant_test":83,"demand_surge":72,"hydrant_use":49,"valve_work":93,"sensor_drift":15,"no event (heat day)":26,"valve_work (unannounced)":9,"hydrant_test (unannounced)":12}
- ewma: {"demand_surge":88,"no event (heat day)":29,"no event (cold day)":4,"hydrant_test":50,"valve_work":51,"hydrant_use":22,"no event (clear day)":25,"no event (rain day)":11,"sensor_drift":50,"valve_work (unannounced)":6,"hydrant_test (unannounced)":4}
- ewma_context: {"sensor_drift":73,"hydrant_use":47,"no event (clear day)":115,"valve_work (unannounced)":12,"no event (cold day)":60,"no event (rain day)":12,"hydrant_test (unannounced)":11,"no event (heat day)":3}
- ml: {"hydrant_test":62,"no event (cold day)":6,"no event (heat day)":20,"hydrant_use":28,"demand_surge":58,"valve_work":74,"no event (clear day)":22,"sensor_drift":60,"valve_work (unannounced)":10,"no event (rain day)":5,"hydrant_test (unannounced)":7}
- ml_context: {"no event (cold day)":49,"sensor_drift":79,"hydrant_use":48,"no event (clear day)":110,"valve_work (unannounced)":12,"no event (rain day)":15,"hydrant_test (unannounced)":12,"no event (heat day)":5}
- ml_records: {"demand_surge":64,"valve_work":17,"sensor_drift":93,"hydrant_test":3,"no event (cold day)":1,"valve_work (unannounced)":1,"hydrant_test (unannounced)":1,"hydrant_use":1,"no event (heat day)":2}
- ml_records_context: {"no event (clear day)":23,"hydrant_use":8,"sensor_drift":27,"no event (rain day)":3,"hydrant_test (unannounced)":4,"no event (cold day)":3,"valve_work (unannounced)":5,"no event (heat day)":1}
- ml_naive: {"hydrant_test":81,"no event (clear day)":133,"demand_surge":133,"no event (heat day)":303,"no event (cold day)":39,"sensor_drift":66,"hydrant_use":51,"valve_work":109,"valve_work (unannounced)":13,"no event (rain day)":18,"hydrant_test (unannounced)":10}

## False-alert budget (per zone-week, set on training)

| | rules | ewma | ewma_context | ml | ml_context |
|---|---|---|---|---|---|
| 0.25 | 254/393 · FA 0.31 · saved 73% | 325/393 · FA 0.30 · saved 83% | 370/393 · FA 0.27 · saved 92% | 300/393 · FA 0.33 · saved 81% | 359/393 · FA 0.25 · saved 91% |
| 0.5 | 337/393 · FA 0.56 · saved 86% | 353/393 · FA 0.53 · saved 88% | 382/393 · FA 0.52 · saved 93% | 328/393 · FA 0.55 · saved 86% | 381/393 · FA 0.52 · saved 93% |
| 1 | 373/393 · FA 1.21 · saved 93% | 374/393 · FA 1.05 · saved 92% | 382/393 · FA 1.04 · saved 94% | 365/393 · FA 1.11 · saved 92% | 383/393 · FA 1.01 · saved 94% |
| 2 | 381/393 · FA 2.25 · saved 94% | 385/393 · FA 1.93 · saved 94% | 386/393 · FA 2.04 · saved 94% | 381/393 · FA 2.13 · saved 94% | 384/393 · FA 2.16 · saved 94% |

## Persistence (alarm hours before an alert)

| | rules | ewma | ewma_context | ml | ml_context |
|---|---|---|---|---|---|
| 1 | 259/393 · FA 0.54 · saved 74% | 329/393 · FA 0.52 · saved 86% | 381/393 · FA 0.52 · saved 95% | 299/393 · FA 0.55 · saved 83% | 358/393 · FA 0.58 · saved 92% |
| 2 | 337/393 · FA 0.56 · saved 86% | 353/393 · FA 0.53 · saved 88% | 382/393 · FA 0.52 · saved 93% | 328/393 · FA 0.55 · saved 86% | 381/393 · FA 0.52 · saved 93% |
| 3 | 370/393 · FA 0.62 · saved 90% | 359/393 · FA 0.55 · saved 87% | 381/393 · FA 0.55 · saved 91% | 357/393 · FA 0.58 · saved 88% | 382/393 · FA 0.60 · saved 91% |

## Reliability of the published schedule

| | rules | ewma | ewma_context | ml | ml_context |
|---|---|---|---|---|---|
| perfect {"announced":1,"cancelled":0,"maxDelay":0} | 340/393 · FA 0.57 · saved 87% | 353/393 · FA 0.52 · saved 88% | 382/393 · FA 0.52 · saved 93% | 325/393 · FA 0.57 · saved 86% | 381/393 · FA 0.52 · saved 93% |
| realistic {"announced":0.9,"cancelled":0.05,"maxDelay":1} | 337/393 · FA 0.56 · saved 86% | 353/393 · FA 0.53 · saved 88% | 382/393 · FA 0.52 · saved 93% | 328/393 · FA 0.55 · saved 86% | 381/393 · FA 0.52 · saved 93% |
| poor {"announced":0.75,"cancelled":0.1,"maxDelay":2} | 342/393 · FA 0.56 · saved 87% | 355/393 · FA 0.54 · saved 88% | 379/393 · FA 0.55 · saved 93% | 329/393 · FA 0.56 · saved 87% | 378/393 · FA 0.51 · saved 93% |
| unreliable {"announced":0.5,"cancelled":0.2,"maxDelay":2} | 348/393 · FA 0.56 · saved 88% | 355/393 · FA 0.54 · saved 88% | 377/393 · FA 0.53 · saved 93% | 330/393 · FA 0.55 · saved 87% | 374/393 · FA 0.53 · saved 92% |

## Simulator sensitivity

| | rules | ewma | ewma_context | ml | ml_context |
|---|---|---|---|---|---|
| base | 337/393 · FA 0.56 · saved 86% | 353/393 · FA 0.53 · saved 88% | 382/393 · FA 0.52 · saved 93% | 328/393 · FA 0.55 · saved 86% | 381/393 · FA 0.52 · saved 93% |
| noisier | 349/393 · FA 0.60 · saved 89% | 348/393 · FA 0.54 · saved 87% | 379/393 · FA 0.60 · saved 93% | 319/393 · FA 0.55 · saved 84% | 378/393 · FA 0.56 · saved 93% |
| smallerLeaks | 299/393 · FA 0.56 · saved 81% | 316/393 · FA 0.53 · saved 82% | 378/393 · FA 0.53 · saved 92% | 301/393 · FA 0.55 · saved 81% | 374/393 · FA 0.53 · saved 92% |
| moreLookAlikes | 275/418 · FA 0.53 · saved 74% | 345/418 · FA 0.54 · saved 84% | 400/418 · FA 0.49 · saved 92% | 308/418 · FA 0.63 · saved 80% | 389/418 · FA 0.49 · saved 91% |

(152 s)
