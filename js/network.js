/**
 * Synthetic SCADA for a small distribution network.
 *
 * Each zone reports hourly flow (L/s) and pressure (psi). Readings come from a demand model plus
 * events that persist over time:
 *   - leak                 hidden; starts at random (more often in cold weather), lasts until repaired
 *   - hydrant_test         scheduled in advance (appears in the maintenance schedule)
 *   - valve_work           scheduled in advance; flow/pressure signature resembles a leak
 *   - hydrant_use          unscheduled hydrant draw (e.g. fire fighting); short, large flow
 *   - sensor_drift         pressure transmitter drifts low; true flow and pressure unchanged
 *   - demand_surge         hot-afternoon demand peak
 * The truth (which events are active) is kept on each reading under `truth`; detectors and the
 * operator-facing context must not read it. Every random stream is seeded, so the same seed always
 * produces the same history, schedule and live continuation.
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
/** Monday 5 January 2026, 00:00 network time (UTC is used throughout so results never depend on the viewer's time zone). */
export const START_MS = Date.UTC(2026, 0, 5, 0, 0, 0);

const HEADLOSS = 0.06; // psi lost per L/s of demand flow
const NOISE_FLOW = 2.5; // L/s
const NOISE_PRESSURE = 0.7; // psi
const RATE = {
  leakPerHour: 0.0035, // ≈ one new leak per zone every 12 days in mild weather
  hydrantUsePerHour: 0.0012,
  driftPerHour: 0.0006,
  surgePerAfternoonHour: 0.08,
  hydrantTestPerDay: 0.05,
  valveWorkPerDay: 0.04,
};

/** Two-peak daily demand profile (morning ≈ 07:30, evening ≈ 19:30, night minimum ≈ 03:00), mean 1. */
const PROFILE = (() => {
  const raw = [];
  for (let h = 0; h < 24; h += 1) {
    const g = (mu, sd, a) => {
      const d = Math.min(Math.abs(h - mu), 24 - Math.abs(h - mu)); // the day wraps around midnight
      return a * Math.exp(-(d ** 2) / (2 * sd * sd));
    };
    raw.push(0.62 + g(7.5, 1.6, 0.5) + g(19.5, 2.0, 0.42) + g(13, 3, 0.2));
  }
  const mean = raw.reduce((a, b) => a + b, 0) / 24;
  return raw.map((v) => v / mean);
})();

export function demandFactor(hour) {
  return PROFILE[((hour % 24) + 24) % 24];
}

export function hourOfIndex(index) {
  return new Date(START_MS + index * HOUR_MS).getUTCHours();
}

export function dayOfIndex(index) {
  return Math.floor(index / 24);
}

/**
 * Create a simulator. `confounders: false` produces a network with leaks only (used to study a
 * model trained without the events that resemble leaks).
 */
export function createNetwork({ seed = 42, confounders = true, zones = PRESSURE_ZONES } = {}) {
  const weatherByDay = new Map();
  const scheduleByDay = new Map();
  const zoneState = new Map();
  let hourIndex = 0;
  let nextEventId = 1;

  for (const zone of zones) {
    zoneState.set(zone.id, {
      rng: mulberry32(streamSeed(seed, `events:${zone.id}`)),
      noise: mulberry32(streamSeed(seed, `noise:${zone.id}`)),
      active: [], // { id, type, start, end, dFlow, dPressureRatio, demandMult, driftRate, driftMax }
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

  /** Scheduled work for one day (published in advance, so operators can see it). */
  function scheduleForDay(day) {
    if (!scheduleByDay.has(day)) {
      const rng = mulberry32(streamSeed(seed, `schedule:${day}`));
      const items = [];
      if (confounders) {
        for (const zone of zones) {
          if (rng() < RATE.hydrantTestPerDay) {
            const startHour = randint(rng, 9, 14);
            const duration = randint(rng, 1, 2);
            items.push(scheduleItem(day, zone.id, EVENT.HYDRANT_TEST, startHour, duration, rng));
          }
          if (rng() < RATE.valveWorkPerDay) {
            const startHour = randint(rng, 9, 15);
            const duration = randint(rng, 2, 3);
            items.push(scheduleItem(day, zone.id, EVENT.VALVE_WORK, startHour, duration, rng));
          }
        }
      }
      scheduleByDay.set(day, items);
    }
    return scheduleByDay.get(day);
  }

  function scheduleItem(day, zoneId, type, startHour, duration, rng) {
    const start = day * 24 + startHour;
    return {
      id: `S${day}-${zoneId}-${type}`,
      zoneId,
      type,
      start,
      end: start + duration, // exclusive
      title: type === EVENT.HYDRANT_TEST ? "Fire hydrant flow test" : "Valve maintenance",
      note:
        type === EVENT.HYDRANT_TEST
          ? "High flow expected during the test; not a distribution leak."
          : "Valve operation; temporary flow and pressure changes expected.",
      dFlow: type === EVENT.HYDRANT_TEST ? uniform(rng, 35, 70) : uniform(rng, 10, 25),
      dPressureRatio: type === EVENT.HYDRANT_TEST ? uniform(rng, 0.1, 0.2) : uniform(rng, 0.25, 0.4),
    };
  }

  function startEvent(zoneId, type, now, rng, overrides = {}) {
    const st = zoneState.get(zoneId);
    let ev;
    switch (type) {
      case EVENT.LEAK: {
        const size = 6 + 40 * rng() ** 1.5; // small leaks are more common than large bursts
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
    const weather = weatherForDay(day);
    const scheduled = scheduleForDay(day).filter((s) => s.start <= now && now < s.end);
    const readings = [];

    for (const zone of zones) {
      const st = zoneState.get(zone.id);
      const rng = st.rng;
      st.active = st.active.filter((e) => e.end > now);

      if (!zoneHasActive(zone.id, EVENT.LEAK) && rng() < RATE.leakPerHour * weather.burstRisk) {
        startEvent(zone.id, EVENT.LEAK, now, rng);
      }
      if (confounders) {
        if (rng() < RATE.hydrantUsePerHour) startEvent(zone.id, EVENT.HYDRANT_USE, now, rng);
        if (!zoneHasActive(zone.id, EVENT.SENSOR_DRIFT) && rng() < RATE.driftPerHour) startEvent(zone.id, EVENT.SENSOR_DRIFT, now, rng);
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
      const truthEvents = [];
      for (const e of st.active) {
        truthEvents.push(e.type);
        if (e.type === EVENT.DEMAND_SURGE) demandMult *= e.demandMult;
        else if (e.type === EVENT.SENSOR_DRIFT) drift -= Math.min(e.driftMax, e.driftRate * (now - e.start + 1));
        else {
          extraFlow += e.dFlow;
          extraDrop += e.dFlow * e.dPressureRatio;
        }
      }
      for (const s of scheduled.filter((x) => x.zoneId === zone.id)) {
        truthEvents.push(s.type);
        extraFlow += s.dFlow;
        extraDrop += s.dFlow * s.dPressureRatio;
      }

      const demand = zone.baseFlow * demandFactor(hour) * demandMult;
      const trueFlow = demand + extraFlow;
      const p0 = zone.basePressure + HEADLOSS * zone.baseFlow;
      const truePressure = p0 - HEADLOSS * demand - extraDrop;
      const flow = Math.max(1, trueFlow + NOISE_FLOW * randn(st.noise));
      const pressure = Math.max(5, truePressure + NOISE_PRESSURE * randn(st.noise) + drift);

      readings.push({
        index: now,
        timestamp: new Date(START_MS + now * HOUR_MS),
        hour,
        day,
        zoneId: zone.id,
        zoneName: zone.name,
        flowLps: round(flow, 2),
        pressurePsi: round(pressure, 2),
        isLeak: truthEvents.includes(EVENT.LEAK) ? 1 : 0,
        truth: { events: truthEvents, leakId: st.active.find((e) => e.type === EVENT.LEAK)?.id ?? null },
      });
    }
    hourIndex += 1;
    return readings;
  }

  return {
    seed,
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
    /** Published schedule: items for the given days (operators know these in advance). */
    scheduleFor(days) {
      return days.flatMap((d) => scheduleForDay(d));
    },
    /** Scheduled items active in a zone at an hour index (± `margin` hours). */
    scheduledAt(zoneId, index, margin = 0) {
      return scheduleForDay(dayOfIndex(index)).filter((s) => s.zoneId === zoneId && s.start - margin <= index && index < s.end + margin);
    },
    /** Demo control: start an event in a zone at the current hour. */
    inject(zoneId, type) {
      const rng = mulberry32(streamSeed(seed, `inject:${hourIndex}:${zoneId}:${type}`));
      if (type === EVENT.VALVE_WORK || type === EVENT.HYDRANT_TEST) {
        const day = dayOfIndex(hourIndex);
        const item = scheduleItem(day, zoneId, type, hourOfIndex(hourIndex), type === EVENT.VALVE_WORK ? 3 : 2, rng);
        item.id = `${item.id}-added-${hourIndex}`;
        item.note += " (added to today's schedule)";
        scheduleForDay(day).push(item);
        return item;
      }
      if (type === EVENT.LEAK) {
        zoneState.get(zoneId).active = zoneState.get(zoneId).active.filter((e) => e.type !== EVENT.LEAK);
        return startEvent(zoneId, type, hourIndex, rng, { dFlow: uniform(rng, 25, 40), end: hourIndex + 72 });
      }
      return startEvent(zoneId, type, hourIndex, rng);
    },
    /** A crew repaired the zone: any leak there ends now. Returns true if a leak was active. */
    repairLeak(zoneId) {
      const st = zoneState.get(zoneId);
      const had = st.active.some((e) => e.type === EVENT.LEAK);
      st.active = st.active.filter((e) => e.type !== EVENT.LEAK);
      return had;
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
