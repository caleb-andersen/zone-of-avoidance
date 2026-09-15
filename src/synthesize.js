import { DEG } from './constants.js';
import { galacticToRender } from './data.js';

const SECTORS = 12; // 30 degrees of longitude each
const SECTOR_W = 360 / SECTORS;
const B_LIMIT = 21; // degrees: beyond this there is no deficit left to find
const B_BINS = 28; // 1.5 degrees per bin
const B_STEP = (2 * B_LIMIT) / B_BINS;

/** Sectors covering |l| < 30, where the survey mask widens over the bulge. */
const BULGE_SECTORS = new Set([0, SECTORS - 1]);

/** Solid angle of one longitude sector between two latitudes, steradians. */
function cellOmega(b0, b1) {
  return Math.abs((SECTOR_W * DEG) * (Math.sin(b1 * DEG) - Math.sin(b0 * DEG)));
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-9)));
  return t * t * (3 - 2 * t);
}

/**
 * 2MRS contains only what was observed: |b| < 5 is empty everywhere and
 * |b| < 8 is empty towards the bulge, with counts still thin out to roughly
 * ten degrees. The blocked sky is empty by construction, not because the
 * universe is.
 *
 * Two scales are used deliberately. The *shape* of the deficit -- what
 * fraction of the expected galaxies is missing at each latitude -- is measured
 * over whole longitude groups, because per-cell Poisson noise is as large as
 * the real thinning at five to ten degrees and would drown it. The *amplitude*
 * comes from each sector's own ambient density, so genuine large-scale
 * structure is inherited rather than averaged away. Each synthesised galaxy
 * then borrows a distance and a magnitude from a real galaxy in the same
 * sector, which gives it the radial structure of that direction.
 *
 * Everything here is an estimate of a number, never of an object.
 */
export function synthesizeDeficit(cat, rng) {
  const { count, lon, lat, dist, mags } = cat;

  const sectorOf = (l) => Math.min(SECTORS - 1, Math.floor(l / SECTOR_W));
  const groupOf = (s) => (BULGE_SECTORS.has(s) ? 1 : 0);

  const ambientN = new Float64Array(SECTORS);
  const donors = Array.from({ length: SECTORS }, () => []);
  const observed = Array.from({ length: SECTORS }, () => new Float64Array(B_BINS));

  // 20 < |b| < 70, both hemispheres: the sky the survey saw properly.
  const ambientOmega = cellOmega(20, 70) + cellOmega(-70, -20);

  for (let i = 0; i < count; i++) {
    const b = lat[i];
    const ab = Math.abs(b);
    const s = sectorOf(lon[i]);
    if (ab > 20 && ab < 70) ambientN[s]++;
    if (ab > 10) donors[s].push(i);
    if (ab < B_LIMIT) {
      observed[s][Math.min(B_BINS - 1, Math.floor((b + B_LIMIT) / B_STEP))]++;
    }
  }

  // Smooth density across neighbouring sectors: structure varies with
  // longitude, shot noise should not.
  const raw = new Float64Array(SECTORS);
  for (let s = 0; s < SECTORS; s++) raw[s] = ambientN[s] / ambientOmega;
  const density = new Float64Array(SECTORS);
  for (let s = 0; s < SECTORS; s++) {
    density[s] =
      0.25 * raw[(s - 1 + SECTORS) % SECTORS] +
      0.5 * raw[s] +
      0.25 * raw[(s + 1) % SECTORS];
  }

  // Expected count per (sector, bin), and the group totals used for the shape.
  const expected = Array.from({ length: SECTORS }, () => new Float64Array(B_BINS));
  const groupExp = [new Float64Array(B_BINS), new Float64Array(B_BINS)];
  const groupObs = [new Float64Array(B_BINS), new Float64Array(B_BINS)];

  for (let s = 0; s < SECTORS; s++) {
    const g = groupOf(s);
    for (let bin = 0; bin < B_BINS; bin++) {
      const b0 = -B_LIMIT + bin * B_STEP;
      const e = density[s] * cellOmega(b0, b0 + B_STEP);
      expected[s][bin] = e;
      groupExp[g][bin] += e;
      groupObs[g][bin] += observed[s][bin];
    }
  }

  // Missing fraction per latitude bin, gated by its own noise level so that a
  // bin which is merely unlucky contributes nothing.
  const missing = [new Float64Array(B_BINS), new Float64Array(B_BINS)];
  for (let g = 0; g < 2; g++) {
    for (let bin = 0; bin < B_BINS; bin++) {
      const e = groupExp[g][bin];
      if (e <= 0) continue;
      const f = Math.max(0, 1 - groupObs[g][bin] / e);
      const sigma = Math.sqrt(e) / e; // fractional Poisson noise on this bin
      missing[g][bin] = f * smoothstep(1.2 * sigma, 3.0 * sigma, f);
    }
  }

  const allDonors = [];
  for (let s = 0; s < SECTORS; s++) allDonors.push(...donors[s]);

  const scratch = [];
  let generated = 0;

  for (let s = 0; s < SECTORS; s++) {
    const g = groupOf(s);
    const pool = donors[s].length > 250 ? donors[s] : allDonors;
    for (let bin = 0; bin < B_BINS; bin++) {
      const want = missing[g][bin] * expected[s][bin];
      if (want < 0.05) continue;

      let nGen = Math.floor(want);
      if (rng() < want - nGen) nGen++; // resolve the fraction stochastically

      const b0 = -B_LIMIT + bin * B_STEP;
      const sin0 = Math.sin(b0 * DEG);
      const sin1 = Math.sin((b0 + B_STEP) * DEG);

      for (let j = 0; j < nGen; j++) {
        const donor = pool[(rng() * pool.length) | 0];
        const r = dist[donor];
        const l = (s * SECTOR_W + rng() * SECTOR_W) * DEG;
        const b = Math.asin(sin0 + rng() * (sin1 - sin0));
        const cb = Math.cos(b);
        const p = galacticToRender(
          r * cb * Math.cos(l),
          r * cb * Math.sin(l),
          r * Math.sin(b)
        );
        scratch.push(p[0], p[1], p[2], r, mags[donor]);
        generated++;
      }
    }
  }

  const position = new Float32Array(generated * 3);
  const shape = new Float32Array(generated * 2);
  const bright = new Float32Array(generated);
  const distance = new Float32Array(generated);

  for (let i = 0; i < generated; i++) {
    position[i * 3] = scratch[i * 5];
    position[i * 3 + 1] = scratch[i * 5 + 1];
    position[i * 3 + 2] = scratch[i * 5 + 2];
    distance[i] = scratch[i * 5 + 3];
    // Ring sprites still get an orientation and a squash, so they read as
    // objects rather than as interface markers.
    shape[i * 2] = rng() * Math.PI;
    shape[i * 2 + 1] = 0.5 + 0.5 * rng();
    const m = scratch[i * 5 + 4];
    bright[i] = Math.min(1, Math.max(0, (11.754 - m) / (11.754 - 3.815)));
  }

  return { count: generated, position, shape, bright, dist: distance };
}
