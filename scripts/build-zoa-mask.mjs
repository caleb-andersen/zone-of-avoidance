/**
 * Measure where 2MRS stopped seeing, and write the boundary out as a contour.
 *
 * The Zone of Avoidance is usually drawn as a tidy wedge, because a wedge is
 * easy to describe: a few degrees wide at the anticentre, wider over the bulge.
 * That description is an idealisation of something that was actually measured,
 * and it is smooth in a way the sky is not. Dust does not lie in a cone. It
 * lies in clouds, and the boundary of what a survey could see through them is
 * ragged wherever the counts are good enough to show it.
 *
 * So the boundary here is not asserted, it is counted:
 *
 *   1. Bin the whole catalogue into equal-area cells in (l, b). Equal steps in
 *      longitude and in sin(b) give cells of identical solid angle, so a count
 *      per cell is a density with no further correction, and near the plane --
 *      the only place this is about -- those cells come out nearly square.
 *   2. For each ring of constant |b|, take the median count over the part of
 *      the ring that is not blocked. The median, not the mean: a ring that is
 *      a third obscured still has a perfectly good middle.
 *   3. Completeness is each cell's count over that reference.
 *   4. The mask is the contour where completeness falls through 50%.
 *
 * Step 2 has a bootstrapping problem -- which part of a ring is unblocked is
 * what we are trying to find out -- and a degenerate case: below |b| = 5 the
 * survey observed nothing at any longitude, so there is no unblocked sky at
 * that latitude to take a median of. Both are handled below, and neither is
 * papered over.
 *
 * Run: node scripts/build-zoa-mask.mjs [--report]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const IN_BIN = join(ROOT, 'public/data/2mrs.bin');
const OUT_JSON = join(ROOT, 'public/data/zoa-mask.json');

const DEG = Math.PI / 180;

/** 2 degrees of longitude per cell. */
const N_LON = 180;
/**
 * Equal-area bands in sin(b), about 0.83 degrees each near the plane. The count
 * is chosen so that a band *boundary* lands on |b| = 4.9885, which is 2MRS's
 * own edge to within a hundredth of a degree. Any other count leaves a band
 * straddling that edge, drawing its counts from a sliver of observed sky while
 * being scored as though it had the whole band -- and a straddling band is
 * uniformly starved right around the latitude the answer lives at.
 */
const N_SINB = 138;
/**
 * Gaussian smoothing in longitude, in degrees. Per-cell counts average barely
 * two galaxies, so a raw cell is mostly Poisson noise. Only about seventeen
 * galaxies per degree of longitude sit at the latitudes the boundary runs
 * through at all, and locating a 50% crossing to better than a degree takes a
 * few hundred of them, which is to say a few tens of degrees of longitude.
 * That is also roughly the size of the cloud complexes doing the blocking, so
 * the resolution this leaves is the resolution the question has.
 */
const SIGMA_L = 12;
/**
 * And a much smaller one across latitude. The survey's edge at |b| = 5 is a
 * step, and blurring a step drags the contour outward, so this stays near the
 * band width and the observed-sky floor below catches what leaks through.
 */
const SIGMA_B = 1;
/** The contour level. Half the galaxies that should be there, are. */
const LEVEL = 0.5;
/**
 * A crossing counts only if completeness stays above the level for this many
 * further bands. One lucky cell should not get to declare the sky open.
 */
const PERSIST = 2;
/** Give up looking for a crossing beyond here. Nothing should reach it. */
const B_SEARCH_MAX = 40;

/** A ring whose own median is this far below the open sky cannot define it. */
const RING_TRUST_FLOOR = 0.60;
/** Nor can one where this much of the ring has been eaten. */
const RING_TRUST_LIVE = 0.60;
/**
 * Width of the kernel, in sin(b), that turns trustworthy ring medians into a
 * reference defined at every latitude. Counts per equal-area cell are expected
 * to be flat in b -- the universe does not know where our dust is -- so this
 * mostly averages down the noise on each ring median, and carries a value into
 * the latitudes that have no unblocked sky of their own.
 */
const REF_SIGMA_SINB = 0.25;

// ---------------------------------------------------------------------------

function loadDirections() {
  const buf = readFileSync(IN_BIN);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = Math.floor(f.length / 4);
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = f[i * 4], y = f[i * 4 + 1], z = f[i * 4 + 2];
    const r = Math.hypot(x, y, z);
    let l = Math.atan2(y, x) / DEG;
    if (l < 0) l += 360;
    lon[i] = l;
    lat[i] = Math.asin(z / r) / DEG;
  }
  return { n, lon, lat };
}

const lonIndex = (lDeg) => Math.min(N_LON - 1, Math.floor(lDeg / 360 * N_LON));
const bandIndex = (bDeg) =>
  Math.min(N_SINB - 1, Math.floor((Math.sin(bDeg * DEG) + 1) / 2 * N_SINB));

/** Centre of a band, in sin(b) and in degrees; and its lower edge. */
const bandSin = (jb) => -1 + (2 * jb + 1) / N_SINB;
const bandLat = (jb) => Math.asin(bandSin(jb)) / DEG;
const bandEdgeLat = (jb) => Math.asin(-1 + 2 * jb / N_SINB) / DEG;

const BAND_LAT = Array.from({ length: N_SINB }, (_, jb) => bandLat(jb));
const FIRST_NORTH = BAND_LAT.findIndex((v) => v >= 0);

function median(values) {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function gaussianWeights(sigma, step) {
  const half = Math.ceil(3 * sigma / step);
  const w = [];
  for (let k = -half; k <= half; k++) w.push(Math.exp(-0.5 * Math.pow(k * step / sigma, 2)));
  return { w, half };
}

function countCells(cat, pick) {
  const c = new Float64Array(N_LON * N_SINB);
  for (let i = 0; i < cat.n; i++) {
    if (pick && !pick(i)) continue;
    c[bandIndex(cat.lat[i]) * N_LON + lonIndex(cat.lon[i])]++;
  }
  return c;
}

/** Wrapped gaussian blur along longitude, band by band. */
function smoothAlongLongitude(cells) {
  const step = 360 / N_LON;
  const { w, half } = gaussianWeights(SIGMA_L, step);
  const wsum = w.reduce((s, v) => s + v, 0);
  const out = new Float64Array(cells.length);
  for (let jb = 0; jb < N_SINB; jb++) {
    for (let jl = 0; jl < N_LON; jl++) {
      let s = 0;
      for (let k = -half; k <= half; k++) {
        s += w[k + half] * cells[jb * N_LON + (((jl + k) % N_LON) + N_LON) % N_LON];
      }
      out[jb * N_LON + jl] = s / wsum;
    }
  }
  return out;
}

/** And a narrow one across latitude, in sin(b), renormalised at the poles. */
function smoothAcrossLatitude(cells) {
  const step = 2 / N_SINB;
  const { w, half } = gaussianWeights(Math.sin(SIGMA_B * DEG), step);
  const out = new Float64Array(cells.length);
  for (let jb = 0; jb < N_SINB; jb++) {
    for (let jl = 0; jl < N_LON; jl++) {
      let s = 0, wsum = 0;
      for (let k = -half; k <= half; k++) {
        const j = jb + k;
        if (j < 0 || j >= N_SINB) continue;
        s += w[k + half] * cells[j * N_LON + jl];
        wsum += w[k + half];
      }
      out[jb * N_LON + jl] = s / wsum;
    }
  }
  return out;
}

/**
 * The median over the unblocked part of a ring, found by iterating: take the
 * median of everything, throw away whatever sits below half of it, take the
 * median again. Two or three passes settle it, because blocked cells are far
 * below the level rather than just under it.
 */
function ringMedian(field, jb) {
  const row = [];
  for (let jl = 0; jl < N_LON; jl++) row.push(field[jb * N_LON + jl]);
  let live = row;
  let r = median(row);
  for (let pass = 0; pass < 8; pass++) {
    const next = row.filter((v) => v >= LEVEL * r);
    if (next.length < 6) break;
    const nr = median(next);
    live = next;
    if (Math.abs(nr - r) < 1e-9) { r = nr; break; }
    r = nr;
  }
  return { value: r, liveFraction: live.length / N_LON };
}

/**
 * Ring medians into a reference defined at every latitude.
 *
 * A ring can only speak for itself if it has unblocked sky on it, and below
 * |b| = 5 none of them do. Those rings are recognised by sitting far below the
 * level the open sky settles at, and are then handed the reference the
 * surrounding latitudes measured instead of the one they would claim for
 * themselves. A ring allowed to define its own reference out of its own
 * deficit reports itself complete, and the contour comes back inside the edge
 * of a survey that observed nothing there at all.
 */
function referenceProfile(field) {
  const rings = [];
  for (let jb = 0; jb < N_SINB; jb++) {
    const { value, liveFraction } = ringMedian(field, jb);
    rings.push({ jb, b: BAND_LAT[jb], s: bandSin(jb), value, liveFraction });
  }

  const openLevel = median(rings.filter((r) => Math.abs(r.b) > 25).map((r) => r.value));
  for (const r of rings) {
    r.trusted =
      r.liveFraction >= RING_TRUST_LIVE && r.value >= RING_TRUST_FLOOR * openLevel;
  }
  const trusted = rings.filter((r) => r.trusted);
  if (trusted.length < 10) throw new Error('too few rings to build a reference');

  const ref = new Float64Array(N_SINB);
  for (let jb = 0; jb < N_SINB; jb++) {
    const s = bandSin(jb);
    let num = 0, den = 0;
    for (const r of trusted) {
      const w = Math.exp(-0.5 * Math.pow((s - r.s) / REF_SIGMA_SINB, 2));
      num += w * r.value;
      den += w;
    }
    ref[jb] = num / den;
  }
  return { ref, rings, openLevel };
}

function completeness(cat, pick) {
  const counts = countCells(cat, pick);
  const field = smoothAcrossLatitude(smoothAlongLongitude(counts));
  const { ref, rings, openLevel } = referenceProfile(field);
  const comp = new Float64Array(field.length);
  for (let jb = 0; jb < N_SINB; jb++) {
    for (let jl = 0; jl < N_LON; jl++) {
      comp[jb * N_LON + jl] = field[jb * N_LON + jl] / ref[jb];
    }
  }
  return { comp, ref, rings, openLevel, counts };
}

/**
 * The innermost latitude, per longitude, at which anything was observed at
 * all. This recovers 2MRS's own mask from the counts -- |b| > 5, opening to
 * |b| > 8 towards the bulge -- and the contour is never allowed inside it.
 * Completeness below that edge is zero, not low, and interpolating a crossing
 * across a step would otherwise place the boundary inside sky the survey never
 * looked at.
 */
function observedEdge(cat, pick) {
  const field = smoothAlongLongitude(countCells(cat, pick));
  const upper = new Float64Array(N_LON);
  const lower = new Float64Array(N_LON);
  for (let jl = 0; jl < N_LON; jl++) {
    for (let jb = FIRST_NORTH; jb < N_SINB; jb++) {
      if (field[jb * N_LON + jl] > 0.02) { upper[jl] = bandEdgeLat(jb); break; }
    }
    for (let jb = FIRST_NORTH - 1; jb >= 0; jb--) {
      if (field[jb * N_LON + jl] > 0.02) { lower[jl] = bandEdgeLat(jb + 1); break; }
    }
  }
  return { upper, lower };
}

/**
 * Walk outward from the plane in each longitude column until completeness
 * crosses the level and stays crossed, then place the boundary by linear
 * interpolation between the two band centres that straddle it.
 */
function traceContour(comp) {
  const upper = new Float64Array(N_LON);
  const lower = new Float64Array(N_LON);

  const holds = (jl, from, step) => {
    for (let k = 1; k <= PERSIST; k++) {
      const jb = from + k * step;
      if (jb < 0 || jb >= N_SINB) return true;
      if (Math.abs(BAND_LAT[jb]) > B_SEARCH_MAX) return true;
      if (comp[jb * N_LON + jl] < LEVEL) return false;
    }
    return true;
  };

  for (let jl = 0; jl < N_LON; jl++) {
    for (const [step, out] of [[1, upper], [-1, lower]]) {
      let hit = step * B_SEARCH_MAX;
      for (
        let jb = step > 0 ? FIRST_NORTH : FIRST_NORTH - 1;
        jb > 0 && jb < N_SINB - 1 && Math.abs(BAND_LAT[jb]) <= B_SEARCH_MAX;
        jb += step
      ) {
        const c0 = comp[jb * N_LON + jl];
        const c1 = comp[(jb + step) * N_LON + jl];
        if (c0 < LEVEL && c1 >= LEVEL && holds(jl, jb + step, step)) {
          hit = BAND_LAT[jb] + (LEVEL - c0) / (c1 - c0) * (BAND_LAT[jb + step] - BAND_LAT[jb]);
          break;
        }
      }
      out[jl] = hit;
    }
  }
  return { upper, lower };
}

/** The 50% contour, or the edge of the observed sky, whichever is further out. */
function measure(cat, pick) {
  const { comp, ref, rings, openLevel, counts } = completeness(cat, pick);
  const contour = traceContour(comp);
  const edge = observedEdge(cat, pick);
  for (let jl = 0; jl < N_LON; jl++) {
    contour.upper[jl] = Math.max(contour.upper[jl], edge.upper[jl]);
    contour.lower[jl] = Math.min(contour.lower[jl], edge.lower[jl]);
  }
  return { contour, edge, comp, ref, rings, openLevel, counts };
}

// ---------------------------------------------------------------------------

/**
 * How much of the contour's raggedness is dust and how much is Poisson. Split
 * the catalogue in two at random, measure both halves independently, and the
 * scatter between them is noise by construction: two halves of the same sky
 * have the same dust in them. A half has twice the variance of the whole and a
 * difference of two halves twice that again, so the full-sample noise is the
 * spread of that difference over two.
 *
 * Both the rms and the median are worth having. A half-sample occasionally
 * fails to find a crossing at all and runs a long way out before it stops, and
 * one such column dominates an rms; the median says what a typical column is
 * worth. The truth is between them, and the honest thing is to quote the
 * pessimistic one.
 */
function noiseEstimate(cat, runs = 10) {
  let seed = 0x5bd1e995;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const diffs = [];
  for (let run = 0; run < runs; run++) {
    const side = new Uint8Array(cat.n);
    for (let i = 0; i < cat.n; i++) side[i] = rnd() < 0.5 ? 1 : 0;
    const a = measure(cat, (i) => side[i] === 1).contour;
    const b = measure(cat, (i) => side[i] === 0).contour;
    for (let jl = 0; jl < N_LON; jl++) {
      diffs.push(Math.abs(a.upper[jl] - b.upper[jl]));
      diffs.push(Math.abs(a.lower[jl] - b.lower[jl]));
    }
  }
  const rms = Math.sqrt(diffs.reduce((s, v) => s + v * v, 0) / diffs.length) / 2;
  const typical = median(diffs) / 0.6745 / 2;
  return { rms, typical };
}

/** Cells below the level that fall outside the traced boundary. */
function islandFraction(comp, contour) {
  let out = 0, total = 0;
  for (let jb = 0; jb < N_SINB; jb++) {
    const b = BAND_LAT[jb];
    if (Math.abs(b) > 25) continue;
    for (let jl = 0; jl < N_LON; jl++) {
      total++;
      if (comp[jb * N_LON + jl] < LEVEL && (b > contour.upper[jl] || b < contour.lower[jl])) {
        out++;
      }
    }
  }
  return out / total;
}

const round2 = (v) => Math.round(v * 100) / 100;

function main() {
  const report = process.argv.includes('--report');
  const cat = loadDirections();
  const { contour, edge, comp, ref, rings, openLevel } = measure(cat);

  const halfWidths = [];
  for (let jl = 0; jl < N_LON; jl++) halfWidths.push(contour.upper[jl], -contour.lower[jl]);
  const mean = halfWidths.reduce((s, v) => s + v, 0) / halfWidths.length;
  const scatter = Math.sqrt(
    halfWidths.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / halfWidths.length
  );
  const noise = noiseEstimate(cat);
  const structure = Math.sqrt(Math.max(0, scatter * scatter - noise.rms * noise.rms));

  // Solid angle inside the contour, and inside the survey's own mask, as
  // fractions of the whole sky.
  let blocked = 0, unobserved = 0;
  for (let jl = 0; jl < N_LON; jl++) {
    blocked +=
      (Math.sin(contour.upper[jl] * DEG) - Math.sin(contour.lower[jl] * DEG)) / 2 / N_LON;
    unobserved +=
      (Math.sin(edge.upper[jl] * DEG) - Math.sin(edge.lower[jl] * DEG)) / 2 / N_LON;
  }
  let onEdge = 0;
  for (let jl = 0; jl < N_LON; jl++) {
    if (contour.upper[jl] - edge.upper[jl] < 0.05) onEdge++;
    if (edge.lower[jl] - contour.lower[jl] < 0.05) onEdge++;
  }

  const payload = {
    what:
      'Contour of 50 per cent completeness in the 2MRS catalogue: the boundary of the sky ' +
      'the survey could not see through. Sampled at cell centres in galactic longitude, ' +
      'b in degrees, north in upper and south in lower.',
    generatedBy: 'scripts/build-zoa-mask.mjs',
    source:
      'Huchra et al. 2012, ApJS 199, 26 (VizieR J/ApJS/199/26/table3), via public/data/2mrs.bin',
    level: LEVEL,
    galaxies: cat.n,
    lon0: 360 / N_LON / 2,
    dLon: 360 / N_LON,
    nLon: N_LON,
    upper: Array.from(contour.upper, round2),
    lower: Array.from(contour.lower, round2),
    binning: {
      cellsInLongitude: N_LON,
      equalAreaBandsInSinB: N_SINB,
      cellSolidAngleSr: 4 * Math.PI / (N_LON * N_SINB),
      bandEdgeOnSurveyCutDeg: round2(bandEdgeLat(FIRST_NORTH)),
      smoothingSigmaLonDeg: SIGMA_L,
      smoothingSigmaLatDeg: SIGMA_B,
      persistenceBands: PERSIST,
      floor: 'the contour is never drawn inside the innermost latitude observed at that longitude',
    },
    measured: {
      meanHalfWidthDeg: round2(mean),
      minHalfWidthDeg: round2(Math.min(...halfWidths)),
      maxHalfWidthDeg: round2(Math.max(...halfWidths)),
      scatterDeg: round2(scatter),
      poissonNoiseDeg: round2(noise.rms),
      poissonNoiseTypicalDeg: round2(noise.typical),
      structureDeg: round2(structure),
      structureOverNoise: round2(structure / noise.rms),
      skyFractionBelowLevel: Math.round(blocked * 1e4) / 1e4,
      skyFractionNeverObserved: Math.round(unobserved * 1e4) / 1e4,
      fractionOfContourOnSurveyEdge: Math.round((onEdge / (2 * N_LON)) * 1e3) / 1e3,
      openSkyCountsPerCell: round2(openLevel),
    },
  };

  const text = JSON.stringify(payload) + '\n';
  writeFileSync(OUT_JSON, text);

  console.log(`${cat.n} galaxies into ${N_LON} x ${N_SINB} equal-area cells`);
  console.log(`open sky: ${openLevel.toFixed(2)} galaxies per cell`);
  console.log(
    `contour: |b| from ${Math.min(...halfWidths).toFixed(1)} to ` +
    `${Math.max(...halfWidths).toFixed(1)} deg, mean ${mean.toFixed(2)}, scatter ${scatter.toFixed(2)}`
  );
  console.log(
    `  structure ${structure.toFixed(2)} deg against Poisson ` +
    `${noise.rms.toFixed(2)} (typical ${noise.typical.toFixed(2)}), so ` +
    `${(structure / noise.rms).toFixed(1)} to ${(structure / noise.typical).toFixed(1)}`
  );
  console.log(
    `sky below 50 per cent: ${(blocked * 100).toFixed(1)} per cent; ` +
    `never observed at all: ${(unobserved * 100).toFixed(1)} per cent`
  );
  console.log(
    `${((onEdge / (2 * N_LON)) * 100).toFixed(0)} per cent of the contour sits on the survey edge`
  );
  console.log(`wrote ${OUT_JSON} (${(text.length / 1024).toFixed(1)} kB)`);

  if (report) {
    console.log(
      `\nislands below the level outside the contour: ` +
      `${(islandFraction(comp, contour) * 100).toFixed(1)} per cent ` +
      `(pure Poisson would give about 10)`
    );
    console.log('\n reference profile');
    console.log('     b     ring    live  trusted      ref');
    for (const r of rings) {
      if (Math.abs(r.b) > 14) continue;
      console.log(
        `${r.b.toFixed(1).padStart(6)} ${r.value.toFixed(3).padStart(8)} ` +
        `${r.liveFraction.toFixed(2).padStart(7)} ${(r.trusted ? 'yes' : 'no').padStart(8)} ` +
        `${ref[r.jb].toFixed(3).padStart(8)}`
      );
    }
    console.log('\n contour against the survey edge');
    console.log('     l    edge+  contour+     edge-  contour-');
    for (let jl = 0; jl < N_LON; jl += 3) {
      console.log(
        `${(jl * 360 / N_LON + 180 / N_LON).toFixed(0).padStart(6)} ` +
        `${edge.upper[jl].toFixed(1).padStart(8)} ${contour.upper[jl].toFixed(1).padStart(9)}  ` +
        `${edge.lower[jl].toFixed(1).padStart(8)} ${contour.lower[jl].toFixed(1).padStart(9)}`
      );
    }
  }
}

main();
