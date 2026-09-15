/** Deterministic PRNG, so every run of the film is the same run. */
export function makeRng(seed = 0x5eed1e) {
  let s = seed >>> 0;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Box-Muller, one value at a time. */
export function gaussian(rng) {
  const u = Math.max(rng(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
