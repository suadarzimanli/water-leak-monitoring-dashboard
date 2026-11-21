# Simulation study results

40 simulated networks (seeds 1001–1040) × 8 zones; train 28 days, test 14 days per network (107,520 test zone-hours). Leak hours: 14.2% of test zone-hours.
Means over networks with 95% bootstrap intervals. False alerts = alert episodes with no leak, per zone-week.

## Alert after 1 consecutive alarm hour

| Method | Precision | Recall (hours) | F1 | Leaks detected | Median hours to detect | False alerts / zone-week | AP |
|---|---|---|---|---|---|---|---|
| rules | 0.90 [0.88, 0.92] | 0.62 [0.57, 0.68] | 0.72 [0.68, 0.76] | 342/400 | 0.1 | 0.85 [0.75, 0.96] | 0.85 [0.83, 0.87] |
| ml_naive | 0.75 [0.72, 0.79] | 0.93 [0.91, 0.95] | 0.83 [0.80, 0.85] | 399/400 | 0.0 | 1.59 [1.38, 1.78] | 0.88 [0.86, 0.90] |
| ml | 0.76 [0.73, 0.80] | 0.88 [0.84, 0.91] | 0.81 [0.78, 0.83] | 384/400 | 0.1 | 1.53 [1.30, 1.77] | 0.85 [0.82, 0.88] |
| ml_context | 0.93 [0.91, 0.94] | 0.83 [0.79, 0.86] | 0.87 [0.85, 0.89] | 383/400 | 0.1 | 0.77 [0.65, 0.88] | 0.85 [0.82, 0.88] |

False alerts by what was happening (all networks):

- rules: {"hydrant_test":171,"sensor_drift":25,"valve_work":103,"demand_surge":123,"hydrant_use":105,"no event (heat day)":20}
- ml_naive: {"hydrant_test":171,"sensor_drift":67,"valve_work":137,"demand_surge":182,"no event (heat day)":256,"no event (clear day)":74,"hydrant_use":103,"no event (cold day)":25}
- ml: {"hydrant_test":158,"sensor_drift":109,"valve_work":133,"no event (heat day)":239,"demand_surge":180,"hydrant_use":100,"no event (clear day)":42,"no event (rain day)":7,"no event (cold day)":9}
- ml_context: {"no event (clear day)":115,"sensor_drift":129,"no event (heat day)":79,"hydrant_use":100,"no event (rain day)":27,"no event (cold day)":25,"demand_surge":15}

Paired differences (by network):

- ml_context − ml: F1 0.07 [0.05, 0.09]; precision 0.16 [0.14, 0.19]; false alerts/zone-week -0.76 [-0.95, -0.58]; leak recall -0.00 [-0.01, 0.00]
- ml − rules: F1 0.08 [0.04, 0.13]; precision -0.13 [-0.16, -0.11]; false alerts/zone-week 0.67 [0.49, 0.86]; leak recall 0.10 [0.06, 0.14]
- ml − ml_naive: F1 -0.02 [-0.04, -0.01]; precision 0.01 [-0.00, 0.03]; false alerts/zone-week -0.06 [-0.27, 0.15]; leak recall -0.04 [-0.06, -0.02]
- ml_context − rules: F1 0.15 [0.11, 0.18]; precision 0.03 [0.02, 0.04]; false alerts/zone-week -0.09 [-0.20, 0.04]; leak recall 0.10 [0.06, 0.14]

## Alert after 2 consecutive alarm hours

| Method | Precision | Recall (hours) | F1 | Leaks detected | Median hours to detect | False alerts / zone-week | AP |
|---|---|---|---|---|---|---|---|
| rules | 0.95 [0.94, 0.96] | 0.57 [0.52, 0.62] | 0.70 [0.65, 0.74] | 308/400 | 1.1 | 0.41 [0.35, 0.47] | 0.85 [0.83, 0.87] |
| ml_naive | 0.79 [0.76, 0.83] | 0.89 [0.86, 0.91] | 0.83 [0.81, 0.85] | 395/400 | 1.0 | 0.96 [0.84, 1.08] | 0.88 [0.86, 0.90] |
| ml | 0.81 [0.77, 0.84] | 0.84 [0.80, 0.87] | 0.81 [0.79, 0.83] | 376/400 | 1.1 | 1.02 [0.84, 1.22] | 0.85 [0.82, 0.88] |
| ml_context | 0.97 [0.96, 0.98] | 0.77 [0.73, 0.80] | 0.85 [0.82, 0.87] | 369/400 | 1.1 | 0.19 [0.14, 0.24] | 0.85 [0.82, 0.88] |

False alerts by what was happening (all networks):

- rules: {"hydrant_test":75,"sensor_drift":13,"demand_surge":49,"valve_work":80,"hydrant_use":44}
- ml_naive: {"hydrant_test":75,"sensor_drift":58,"valve_work":132,"no event (heat day)":81,"demand_surge":128,"no event (clear day)":64,"no event (rain day)":13,"hydrant_use":45,"no event (cold day)":17}
- ml: {"hydrant_test":71,"sensor_drift":75,"valve_work":118,"demand_surge":167,"no event (heat day)":109,"no event (clear day)":41,"hydrant_use":43,"no event (rain day)":16,"no event (cold day)":12}
- ml_context: {"sensor_drift":44,"no event (clear day)":19,"hydrant_use":44,"no event (rain day)":6,"no event (cold day)":4,"demand_surge":2,"no event (heat day)":1}

Paired differences (by network):

- ml_context − ml: F1 0.04 [0.02, 0.06]; precision 0.16 [0.13, 0.19]; false alerts/zone-week -0.83 [-1.01, -0.67]; leak recall -0.02 [-0.03, -0.00]
- ml − rules: F1 0.11 [0.07, 0.16]; precision -0.14 [-0.18, -0.12]; false alerts/zone-week 0.61 [0.45, 0.78]; leak recall 0.16 [0.12, 0.21]
- ml − ml_naive: F1 -0.02 [-0.04, -0.01]; precision 0.02 [-0.00, 0.03]; false alerts/zone-week 0.06 [-0.07, 0.20]; leak recall -0.05 [-0.07, -0.02]
- ml_context − rules: F1 0.15 [0.12, 0.19]; precision 0.01 [0.01, 0.02]; false alerts/zone-week -0.22 [-0.28, -0.16]; leak recall 0.15 [0.10, 0.20]

## Alert after 3 consecutive alarm hours

| Method | Precision | Recall (hours) | F1 | Leaks detected | Median hours to detect | False alerts / zone-week | AP |
|---|---|---|---|---|---|---|---|
| rules | 0.99 [0.98, 0.99] | 0.53 [0.48, 0.59] | 0.68 [0.63, 0.72] | 282/400 | 2.0 | 0.10 [0.07, 0.13] | 0.85 [0.83, 0.87] |
| ml_naive | 0.82 [0.79, 0.85] | 0.85 [0.82, 0.88] | 0.83 [0.81, 0.85] | 386/400 | 2.0 | 0.50 [0.42, 0.58] | 0.88 [0.86, 0.90] |
| ml | 0.84 [0.81, 0.87] | 0.80 [0.76, 0.83] | 0.81 [0.79, 0.83] | 368/400 | 2.0 | 0.54 [0.43, 0.66] | 0.85 [0.82, 0.88] |
| ml_context | 0.98 [0.97, 0.98] | 0.72 [0.68, 0.75] | 0.82 [0.80, 0.85] | 360/400 | 2.1 | 0.08 [0.05, 0.11] | 0.85 [0.82, 0.88] |

False alerts by what was happening (all networks):

- rules: {"sensor_drift":6,"valve_work":39,"demand_surge":15,"hydrant_use":1,"hydrant_test":2}
- ml_naive: {"no event (clear day)":67,"sensor_drift":51,"valve_work":64,"no event (cold day)":8,"demand_surge":70,"no event (rain day)":18,"no event (heat day)":36,"hydrant_use":2,"hydrant_test":2}
- ml: {"no event (clear day)":53,"sensor_drift":57,"valve_work":53,"demand_surge":99,"no event (rain day)":11,"no event (cold day)":6,"no event (heat day)":62,"hydrant_use":1,"hydrant_test":3}
- ml_context: {"sensor_drift":26,"no event (rain day)":5,"no event (clear day)":17,"no event (cold day)":2}

Paired differences (by network):

- ml_context − ml: F1 0.01 [-0.01, 0.03]; precision 0.13 [0.11, 0.16]; false alerts/zone-week -0.46 [-0.57, -0.36]; leak recall -0.02 [-0.03, -0.01]
- ml − rules: F1 0.13 [0.09, 0.18]; precision -0.14 [-0.18, -0.11]; false alerts/zone-week 0.44 [0.33, 0.56]; leak recall 0.21 [0.16, 0.26]
- ml − ml_naive: F1 -0.02 [-0.03, -0.00]; precision 0.02 [0.00, 0.04]; false alerts/zone-week 0.04 [-0.05, 0.13]; leak recall -0.04 [-0.07, -0.01]
- ml_context − rules: F1 0.14 [0.11, 0.18]; precision -0.01 [-0.02, -0.00]; false alerts/zone-week -0.02 [-0.05, 0.01]; leak recall 0.19 [0.14, 0.24]

