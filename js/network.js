/**
 * Synthetic SCADA for a small distribution network.
 *
 * Each zone reports hourly flow (L/s) and pressure (psi): a weekday/weekend demand profile, weather,
 * head loss and sensor noise, plus events that persist over time:
 *   - leak                 hidden; starts at random (more often in cold weather) and runs until it is
 *                          repaired — after an operator dispatch, or else when customers report it
 *   - hydrant_test         planned work; usually announced in the published schedule
 *   - valve_work           planned work; its flow/pressure signature resembles a leak
 *   - hydrant_use          unscheduled hydrant draw (e.g. fire fighting); short, large flow
 *   - sensor_drift         pressure transmitter drifts low; true flow and pressure unchanged
 *   - demand_surge         hot-afternoon demand peak
 * Planned work follows a realistic schedule: some jobs are never announced, some announced jobs are
 * cancelled, and jobs may start up to `maxDelay` hours late.
 *
 * The truth (active events, leak size and timing) is kept on each reading under `truth`;
 * detectors and the operator-facing context must not read it. Every random stream is seeded, so
 * the same seed always produces the same history, schedule and live continuation.
 */
import { PRESSURE_ZONES } from "./zones.js";
import { mulberry32, randn, randint, streamSeed, uniform } from "./rng.js";

export const EVENT = {
  LEAK: "leak",
  HYDRANT_TEST: "hydrant_test",
  VALVE_WORK: "valve_work",
  HYDRANT_USE: "hydrant_use",
  SENSOR_DRIFT: "sensor_drift",
  DEMAND_SURGE: "demand_surge",
};

export const WEATHER = {
  clear: { id: "clear", label: "Clear", demand: 1.0, burstRisk: 1.0, impact: "Normal demand" },
  rain: { id: "rain", label: "Rain", demand: 0.94, burstRisk: 1.0, impact: "Slightly lower demand (less outdoor water use)" },
  heat: { id: "heat", label: "Heat", demand: 1.08, burstRisk: 1.0, impact: "Higher demand; afternoon peaks are likely" },
  cold: { id: "cold", label: "Cold snap", demand: 1.02, burstRisk: 2.2, impact: "Higher risk of main breaks" },
};

export const HOUR_MS = 3600 * 1000;
/** Monday 5 January 2026, 00:00 network time (UTC throughout, so results never depend on the viewer's time zone). */
export const START_MS = Date.UTC(2026, 0, 5, 0, 0, 0);
/** m³ of water per L/s sustained for one hour. */
export const M3_PER_LPS_HOUR = 3.6;

const HEADLOSS = 0.06; // psi lost per L/s of demand flow
export const DEFAULTS = {
  noiseFlow: 2.5, // L/s
  noisePressure: 0.7, // psi
  leakScale: 1.0, // multiplies leak sizes
  eventRateScale: 1.0, // multiplies look-alike event rates
  schedule: { announced: 0.9, cancelled: 0.05, maxDelay: 1 },
};
const RATE = {
  leakPerHour: 0.0035, // ≈ one new leak per zone every 12 days in mild weather
  hydrantUsePerHour: 0.0012,
  driftPerHour: 0.0006,
  surgePerAfternoonHour: 0.08,
  hydrantTestPerDay: 0.05,
  valveWorkPerDay: 0.04,
};

/** Daily demand profiles with mean 1 on weekdays; weekends have a later, flatter morning. */
function profile(peaks, scale) {
  const raw = [];
  for (let h = 0; h < 24; h += 1) {
    let v = 0.62;
    for (const [mu, sd, a] of peaks) {
      const d = Math.min(Math.abs(h - mu), 24 - Math.abs(h - mu)); // the day wraps around midnight
      v += a * Math.exp(-(d ** 2) / (2 * sd * sd));
    }
    raw.push(v);
  }
  const mean = raw.reduce((a, b) => a + b, 0) / 24;
  return raw.map((v) => (v / mean) * scale);
}
const WEEKDAY = profile([[7.5, 1.6, 0.5], [19.5, 2.0, 0.42], [13, 3, 0.2]], 1.0);
const WEEKEND = profile([[10, 2.4, 0.42], [19, 2.2, 0.4], [14, 3, 0.25]], 0.95);

export function isWeekend(day) {
  return day % 7 >= 5; // day 0 is a Monday
}

export function demandFactor(hour, weekend = false) {
  return (weekend ? WEEKEND : WEEKDAY)[((hour % 24) + 24) % 24];
}

export function hourOfIndex(index) {
  return new Date(START_MS + index * HOUR_MS).getUTCHours();
}

export function dayOfIndex(index) {
  return Math.floor(index / 24);
}

/**
 * Create a simulator.
 *   confounders: false   leaks only (to study a model trained without leak-like events)
 *   schedule             { announced, cancelled, maxDelay } — reliability of the published schedule
 *   noiseFlow, noisePressure, leakScale, eventRateScale — sensitivity analysis
 */
export function createNetwork({ seed = 42, confounders = true, zones = PRESSURE_ZONES, ...options } = {}) {
  const cfg = { ...DEFAULTS, ...options, schedule: { ...DEFAULTS.schedule, ...(options.schedule ?? {}) } };
  const weatherByDay = new Map();
  const jobsByDay = new Map();
  const zoneState = new Map();
  const ended = []; // leaks that ended since the last drain: { zoneId, leakId, reason }
  let hourIndex = 0;
  let nextEventId = 1;

  for (const zone of zones) {
    zoneState.set(zone.id, {
      rng: mulberry32(streamSeed(seed, `events:${zone.id}`)),
      noise: mulberry32(streamSeed(seed, `noise:${zone.id}`)),
      active: [],
    });
  }

  function weatherForDay(day) {
    if (!weatherByDay.has(day)) {
      const r = mulberry32(streamSeed(seed, `weather:${day}`))();
      const w = r < 0.55 ? WEATHER.clear : r < 0.75 ? WEATHER.rain : r < 0.9 ? WEATHER.heat : WEATHER.cold;
      weatherByDay.set(day, w);
    }
    return weatherByDay.get(day);
  }

  /** All planned jobs of a day, with what was announced and what actually happened. */
  function jobsForDay(day) {
    if (!jobsByDay.has(day)) {
      const rng = mulberry32(streamSeed(seed, `schedule:${day}`));
      const jobs = [];
      if (confounders) {
        for (const zone of zones) {
          if (rng() < RATE.hydrantTestPerDay * cfg.eventRateScale) jobs.push(makeJob(day, zone.id, EVENT.HYDRANT_TEST, randint(rng, 9, 14), randint(rng, 1, 2), rng));
          if (rng() < RATE.valveWorkPerDay * cfg.eventRateScale) jobs.push(makeJob(day, zone.id, EVENT.VALVE_WORK, randint(rng, 9, 15), randint(rng, 2, 3), rng));
        }
      }
      jobsByDay.set(day, jobs);
    }
    return jobsByDay.get(day);
  }

  function makeJob(day, zoneId, type, startHour, duration, rng, overrides = {}) {
    const start = day * 24 + startHour;
    const delay = randint(rng, 0, cfg.schedule.maxDelay);
    const job = {
      id: `S${day}-${zoneId}-${type}`,
      zoneId,
      type,
      start, // announced window
      end: start + duration,
      actualStart: start + delay, // what happens on site
      actualEnd: start + delay + duration,
      announced: rng() < cfg.schedule.announced,
      cancelled: rng() < cfg.schedule.cancelled,
      title: type === EVENT.HYDRANT_TEST ? "Fire hydrant flow test" : "Valve maintenance",
      note: type === EVENT.HYDRANT_TEST ? "High flow expected during the test; not a distribution leak." : "Valve operation; temporary flow and pressure changes expected.",
      dFlow: (type === EVENT.HYDRANT_TEST ? uniform(rng, 35, 70) : uniform(rng, 10, 25)),
      dPressureRatio: type === EVENT.HYDRANT_TEST ? uniform(rng, 0.1, 0.2) : uniform(rng, 0.25, 0.4),
    };
    return Object.assign(job, overrides);
  }

  function startEvent(zoneId, type, now, rng, overrides = {}) {
    const st = zoneState.get(zoneId);
    let ev;
    switch (type) {
      case EVENT.LEAK: {
        const size = (6 + 40 * rng() ** 1.5) * cfg.leakScale; // small leaks are more common than large bursts
        // without detection, customers report the leak after 12–72 h and it is repaired then
        ev = { type, dFlow: size, dPressureRatio: uniform(rng, 0.22, 0.38), end: now + randint(rng, 12, 72) };
        break;
      }
      case EVENT.HYDRANT_USE:
        ev = { type, dFlow: uniform(rng, 25, 70), dPressureRatio: uniform(rng, 0.1, 0.22), end: now + randint(rng, 1, 2) };
        break;
      case EVENT.SENSOR_DRIFT:
        ev = { type, dFlow: 0, driftRate: uniform(rng, 0.2, 0.4), driftMax: uniform(rng, 6, 10), end: now + randint(rng, 24, 72) };
        break;
      case EVENT.DEMAND_SURGE:
        ev = { type, dFlow: 0, demandMult: uniform(rng, 1.15, 1.3), end: now + randint(rng, 2, 4) };
        break;
      default:
        throw new Error(`Unknown event type ${type}`);
    }
    Object.assign(ev, { id: nextEventId++, start: now }, overrides);
    st.active.push(ev);
    return ev;
  }

  function zoneHasActive(zoneId, type) {
    return zoneState.get(zoneId).active.some((e) => e.type === type);
  }

  /** Advance one hour and return one reading per zone. */
  function step() {
    const now = hourIndex;
    const day = dayOfIndex(now);
    const hour = hourOfIndex(now);
    const weekend = isWeekend(day);
    const weather = weatherForDay(day);
    const onSite = jobsForDay(day).filter((j) => !j.cancelled && j.actualStart <= now && now < j.actualEnd);
    const readings = [];

    for (const zone of zones) {
      const st = zoneState.get(zone.id);
      const rng = st.rng;
      for (const e of st.active) if (e.type === EVENT.LEAK && e.end <= now) ended.push({ zoneId: zone.id, leakId: e.id, reason: "customer report" });
      st.active = st.active.filter((e) => e.end > now);

      if (!zoneHasActive(zone.id, EVENT.LEAK) && rng() < RATE.leakPerHour * weather.burstRisk) startEvent(zone.id, EVENT.LEAK, now, rng);
      if (confounders) {
        if (rng() < RATE.hydrantUsePerHour * cfg.eventRateScale) startEvent(zone.id, EVENT.HYDRANT_USE, now, rng);
        if (!zoneHasActive(zone.id, EVENT.SENSOR_DRIFT) && rng() < RATE.driftPerHour * cfg.eventRateScale) startEvent(zone.id, EVENT.SENSOR_DRIFT, now, rng);
        if (weather.id === "heat" && hour >= 12 && hour <= 17 && !zoneHasActive(zone.id, EVENT.DEMAND_SURGE) && rng() < RATE.surgePerAfternoonHour) {
          startEvent(zone.id, EVENT.DEMAND_SURGE, now, rng);
        }
      } else {
        rng(); rng(); rng(); // consume draws so leak timing stays close to the full network's
      }

      let demandMult = weather.demand;
      let extraFlow = 0;
      let extraDrop = 0;
      let drift = 0;
      let leak = null;
      const truthEvents = [];
      for (const e of st.active) {
        truthEvents.push(e.type);
        if (e.type === EVENT.DEMAND_SURGE) demandMult *= e.demandMult;
        else if (e.type === EVENT.SENSOR_DRIFT) drift -= Math.min(e.driftMax, e.driftRate * (now - e.start + 1));
        else {
          extraFlow += e.dFlow;
          extraDrop += e.dFlow * e.dPressureRatio;
          if (e.type === EVENT.LEAK) leak = e;
        }
      }
      for (const j of onSite.filter((x) => x.zoneId === zone.id)) {
        truthEvents.push(j.type);
        extraFlow += j.dFlow;
        extraDrop += j.dFlow * j.dPressureRatio;
      }

      const demand = zone.baseFlow * demandFactor(hour, weekend) * demandMult;
      const p0 = zone.basePressure + HEADLOSS * zone.baseFlow;
      const flow = Math.max(1, demand + extraFlow + cfg.noiseFlow * randn(st.noise));
      const pressure = Math.max(5, p0 - HEADLOSS * demand - extraDrop + cfg.noisePressure * randn(st.noise) + drift);

      readings.push({
        index: now,
        timestamp: new Date(START_MS + now * HOUR_MS),
        hour,
        day,
        weekend,
        zoneId: zone.id,
        zoneName: zone.name,
        flowLps: round(flow, 2),
        pressurePsi: round(pressure, 2),
        isLeak: leak ? 1 : 0,
        truth: {
          events: truthEvents,
          leakId: leak?.id ?? null,
          leakFlow: leak ? leak.dFlow : 0,
          leakStart: leak?.start ?? null,
          leakReportedAt: leak?.end ?? null, // when customers would report it
        },
      });
    }
    hourIndex += 1;
    return readings;
  }

  return {
    seed,
    config: cfg,
    get hourIndex() {
      return hourIndex;
    },
    step,
    /** Run `hours` steps and return all readings (zone-major order within each hour). */
    run(hours) {
      const all = [];
      for (let i = 0; i < hours; i += 1) all.push(...step());
      return all;
    },
    weatherForDay,
    /** Published schedule for the given days: announced jobs, at their announced times (cancelled ones included). */
    scheduleFor(days) {
      return days.flatMap((d) => jobsForDay(d).filter((j) => j.announced));
    },
    /** Announced jobs in a zone whose announced window, widened by `margin` hours, contains `index`. */
    scheduledAt(zoneId, index, margin = 0) {
      const days = [dayOfIndex(index) - 1, dayOfIndex(index)];
      return days.flatMap((d) => jobsForDay(d)).filter((j) => j.announced && j.zoneId === zoneId && j.start - margin <= index && index < j.end + margin);
    },
    /** Demo control: start an event in a zone at the current hour (planned work is announced and on time). */
    inject(zoneId, type) {
      const rng = mulberry32(streamSeed(seed, `inject:${hourIndex}:${zoneId}:${type}`));
      if (type === EVENT.VALVE_WORK || type === EVENT.HYDRANT_TEST) {
        const day = dayOfIndex(hourIndex);
        const job = makeJob(day, zoneId, type, hourOfIndex(hourIndex), type === EVENT.VALVE_WORK ? 3 : 2, rng, { announced: true, cancelled: false });
        job.actualStart = job.start;
        job.actualEnd = job.end;
        job.id = `${job.id}-added-${hourIndex}`;
        job.note += " (added to today's schedule)";
        jobsForDay(day).push(job);
        return job;
      }
      if (type === EVENT.LEAK) {
        zoneState.get(zoneId).active = zoneState.get(zoneId).active.filter((e) => e.type !== EVENT.LEAK);
        return startEvent(zoneId, type, hourIndex, rng, { dFlow: uniform(rng, 25, 40), end: hourIndex + 72 });
      }
      return startEvent(zoneId, type, hourIndex, rng);
    },
    /** A crew repaired the zone: any leak there ends now. Returns the leak (or null). */
    repairLeak(zoneId) {
      const st = zoneState.get(zoneId);
      const leak = st.active.find((e) => e.type === EVENT.LEAK) ?? null;
      st.active = st.active.filter((e) => e.type !== EVENT.LEAK);
      return leak;
    },
    /** Is a leak active in the zone right now? (used only to simulate what a crew finds on site) */
    leakAt(zoneId) {
      return zoneState.get(zoneId).active.find((e) => e.type === EVENT.LEAK) ?? null;
    },
    /** Leaks that ended by customer report since the last call. */
    drainEnded() {
      return ended.splice(0, ended.length);
    },
  };
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function formatNetworkTime(date, withDay = true) {
  return date.toLocaleString("en-GB", {
    timeZone: "UTC",
    weekday: withDay ? "short" : undefined,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
