/** Small seeded random-number helpers (deterministic across browsers and Node). */

export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal variate (Box–Muller). */
export function randn(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function uniform(rng, a, b) {
  return a + (b - a) * rng();
}

export function randint(rng, a, b) {
  return a + Math.floor(rng() * (b - a + 1));
}

/** Derive an independent stream from a seed and a label (FNV-1a mix). */
export function streamSeed(seed, label) {
  let h = 2166136261 ^ (seed >>> 0);
  for (const ch of String(label)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
