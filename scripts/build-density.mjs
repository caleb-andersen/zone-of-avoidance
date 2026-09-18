/**
 * Give every galaxy in 2MRS a local density, and write it into the catalogue
 * as one more float32 per row.
 *
 * The estimator is the plainest one there is: the distance to the k-th nearest
 * other galaxy, r_k, and k galaxies spread through the sphere it encloses,
 *
 *     rho = k / (4/3 pi r_k^3)        galaxies per cubic megaparsec.
 *
 * k = 12 is small enough to resolve a group and large enough that one close
 * pair does not read as a cluster. Neighbours are searched over the whole
 * catalogue, not just the part the map draws, so a galaxy near the 160 Mpc cut
 * is not starved of the neighbours sitting just beyond it.
 *
 * That density is dominated by the survey rather than by the universe. 2MRS is
 * flux limited, so the number of galaxies per cubic megaparsec falls by two
 * orders of magnitude between 10 and 150 Mpc for no reason but distance. The
 * map uses density to say where structure is, which means dividing that out:
 * the manifest also carries the mean density the survey reaches at each
 * distance, and rho over that is the overdensity the map actually draws.
 *
 * The mean is measured from the same catalogue -- counts in radius, smoothed
 * with a gaussian in ln r, over the volume the survey footprint covers at that
 * radius. It is an average over shells, so structure that fills a whole shell
 * (the Local Supercluster does, close in) is partly absorbed into the mean.
 * That errs towards drawing less, which is the right direction to err.
 *
 * Two things this does not attempt. Redshift distances stretch clusters along
 * the line of sight, and the estimate inherits that stretch. And galaxies at
 * the edge of the survey's footprint have half their neighbours missing, so
 * their density reads low -- which near the Zone of Avoidance means less is
 * drawn, never more.
 *
 * Re-running is safe: an existing density channel is dropped and recomputed.
 *
 * Run: node scripts/build-density.mjs
 */

import { writeFileSync } from 'node:fs';
import { BIN_PATH, MANIFEST_PATH, readCatalogue } from './catalogue.mjs';

const K = 12;
const DEG = Math.PI / 180;

/**
 * The 2MRS footprint as the survey defines it: |b| > 5, widening to |b| > 8
 * for |l| < 30. The mean density is counts over the volume this covers.
 */
const SKY_FRACTION =
  1 - (Math.sin(5 * DEG) * (300 / 360) + Math.sin(8 * DEG) * (60 / 360));

/** Mean-density table: log-spaced radii, and the kernel that smooths counts. */
const TABLE_R_MIN = 2;
const TABLE_R_MAX = 720;
const TABLE_N = 72;
const SIGMA_LN_R = 0.12;
/**
 * Inside this radius there are too few galaxies for a shell average to mean
 * anything -- the whole Local Group is one of them -- so the table is held
 * flat at its value here.
 */
const R_FLOOR = 8;
/** Coincident positions happen; do not divide by zero volume. */
const MIN_RK = 0.05;

/** The map's distance cut, only for the summary printed at the end. */
const MAP_CUT = 160;

// ---------------------------------------------------------------------------
// A static k-d tree over flat coordinate arrays.

function buildTree(pos, n) {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const axis = new Uint8Array(n);

  function select(lo, hi, k, ax) {
    // Quickselect: idx[k] ends up holding the k-th smallest along ax.
    while (hi - lo > 1) {
      const pivot = pos[idx[(lo + hi) >> 1] * 3 + ax];
      let i = lo, j = hi - 1;
      while (i <= j) {
        while (pos[idx[i] * 3 + ax] < pivot) i++;
        while (pos[idx[j] * 3 + ax] > pivot) j--;
        if (i <= j) {
          const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
          i++; j--;
        }
      }
      if (k <= j) hi = j + 1;
      else if (k >= i) lo = i;
      else return;
    }
  }

  function build(lo, hi) {
    if (hi - lo <= 8) return;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      for (let a = 0; a < 3; a++) {
        const v = pos[idx[i] * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    const spans = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const ax = spans.indexOf(Math.max(...spans));
    const m = (lo + hi) >> 1;
    select(lo, hi, m, ax);
    axis[m] = ax;
    build(lo, m);
    build(m + 1, hi);
  }

  build(0, n);
  return { idx, axis };
}

/** Squared distance to the k-th nearest point other than `self`. */
function kthNearest(tree, pos, n, self, k) {
  const { idx, axis } = tree;
  const qx = pos[self * 3], qy = pos[self * 3 + 1], qz = pos[self * 3 + 2];
  // A max-heap of the k best squared distances so far.
  const heap = new Float64Array(k).fill(Infinity);

  const offer = (d2) => {
    if (d2 >= heap[0]) return;
    heap[0] = d2;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let big = i;
      if (l < k && heap[l] > heap[big]) big = l;
      if (r < k && heap[r] > heap[big]) big = r;
      if (big === i) break;
      const t = heap[i]; heap[i] = heap[big]; heap[big] = t;
      i = big;
    }
  };

  const consider = (j) => {
    if (j === self) return;
    const dx = pos[j * 3] - qx, dy = pos[j * 3 + 1] - qy, dz = pos[j * 3 + 2] - qz;
    offer(dx * dx + dy * dy + dz * dz);
  };

  function visit(lo, hi) {
    if (hi - lo <= 8) {
      for (let i = lo; i < hi; i++) consider(idx[i]);
      return;
    }
    const m = (lo + hi) >> 1;
    const j = idx[m];
    consider(j);
    const ax = axis[m];
    const diff = (ax === 0 ? qx : ax === 1 ? qy : qz) - pos[j * 3 + ax];
    const [near, far] = diff < 0 ? [[lo, m], [m + 1, hi]] : [[m + 1, hi], [lo, m]];
    visit(near[0], near[1]);
    if (diff * diff < heap[0]) visit(far[0], far[1]);
  }

  visit(0, n);
  return heap[0];
}

// ---------------------------------------------------------------------------

function meanDensityTable(radii) {
  const lnMin = Math.log(TABLE_R_MIN);
  const lnMax = Math.log(TABLE_R_MAX);
  const norm = 1 / (SIGMA_LN_R * Math.sqrt(2 * Math.PI));
  const lnRadii = Array.from(radii, (v) => Math.log(v));

  // Galaxies per unit ln r, then per unit volume: dV = 4 pi r^3 f dln r.
  const meanAt = (rr) => {
    const lnr = Math.log(rr);
    let perLn = 0;
    for (const v of lnRadii) {
      const u = (v - lnr) / SIGMA_LN_R;
      if (u > -5 && u < 5) perLn += Math.exp(-0.5 * u * u);
    }
    return (perLn * norm) / (4 * Math.PI * rr ** 3 * SKY_FRACTION);
  };

  const floorValue = meanAt(R_FLOOR);
  const r = [];
  const n = [];
  for (let j = 0; j < TABLE_N; j++) {
    const rr = Math.exp(lnMin + (lnMax - lnMin) * (j / (TABLE_N - 1)));
    r.push(+rr.toPrecision(5));
    n.push(+(rr <= R_FLOOR ? floorValue : meanAt(rr)).toPrecision(5));
  }
  return { r, n };
}

function interpolate(table, rr) {
  const { r, n } = table;
  if (rr <= r[0]) return n[0];
  if (rr >= r[r.length - 1]) return n[n.length - 1];
  const lnMin = Math.log(r[0]);
  const f = ((Math.log(rr) - lnMin) / (Math.log(r[r.length - 1]) - lnMin)) * (r.length - 1);
  const i = Math.min(r.length - 2, Math.floor(f));
  const w = f - i;
  // Interpolate in log density; it spans several decades.
  return Math.exp(Math.log(n[i]) * (1 - w) + Math.log(n[i + 1]) * w);
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// ---------------------------------------------------------------------------

const t0 = Date.now();
const { manifest, data, n, stride, at } = readCatalogue();
const KEEP = ['x', 'y', 'z', 'mag'];
for (const c of KEEP) {
  if (!(c in at)) throw new Error(`catalogue has no ${c} component`);
}

const pos = new Float64Array(n * 3);
const radii = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const x = data[i * stride + at.x];
  const y = data[i * stride + at.y];
  const z = data[i * stride + at.z];
  pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
  radii[i] = Math.hypot(x, y, z);
}

const tree = buildTree(pos, n);
const density = new Float32Array(n);
let clamped = 0;
for (let i = 0; i < n; i++) {
  let rk = Math.sqrt(kthNearest(tree, pos, n, i, K));
  if (rk < MIN_RK) { rk = MIN_RK; clamped++; }
  density[i] = K / ((4 / 3) * Math.PI * rk ** 3);
}

const table = meanDensityTable(radii);

// Write the table back out with the density channel appended.
const components = [...KEEP, 'density'];
const out = new Float32Array(n * components.length);
for (let i = 0; i < n; i++) {
  for (let c = 0; c < KEEP.length; c++) {
    out[i * components.length + c] = data[i * stride + at[KEEP[c]]];
  }
  out[i * components.length + KEEP.length] = density[i];
}
writeFileSync(BIN_PATH, Buffer.from(out.buffer));

manifest.format.components = components;
manifest.format.strideBytes = components.length * 4;
manifest.density = {
  what:
    'Local number density from the distance to the k-th nearest other galaxy in the whole catalogue: k / (4/3 pi r_k^3). Dominated by the flux limit; divide by meanDensity at the galaxy\'s distance for overdensity.',
  generatedBy: 'scripts/build-density.mjs',
  k: K,
  units: 'galaxies per cubic megaparsec',
  minNeighbourDistanceMpc: MIN_RK,
  meanDensity: {
    what:
      'Mean number density the survey reaches at each distance: counts smoothed with a gaussian in ln r, over the volume inside the 2MRS footprint. Held flat inside floorMpc. Interpolate in ln r and ln n.',
    skyFraction: +SKY_FRACTION.toFixed(4),
    sigmaLnR: SIGMA_LN_R,
    floorMpc: R_FLOOR,
    r: table.r,
    n: table.n,
  },
};
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

// ---------------------------------------------------------------------------
// What came out, for the galaxies the map actually draws.

const over = [];
for (let i = 0; i < n; i++) {
  if (radii[i] > 0 && radii[i] <= MAP_CUT) over.push(density[i] / interpolate(table, radii[i]));
}
over.sort((a, b) => a - b);
const frac = (v) => (over.length - over.findIndex((x) => x > v)) / over.length;
const pct = (v) => `${(100 * frac(v)).toFixed(1)}%`;

console.log(`k = ${K}, ${n} galaxies, ${Date.now() - t0} ms`);
if (clamped) console.log(`${clamped} galaxies had ${K} neighbours closer than ${MIN_RK} Mpc`);
console.log(`footprint sky fraction ${SKY_FRACTION.toFixed(4)}`);
console.log(
  'mean density, galaxies per Mpc^3: ' +
  [10, 20, 40, 80, 120, 160].map((r) => `${r} Mpc ${interpolate(table, r).toExponential(2)}`).join(', ')
);
console.log(
  `overdensity within ${MAP_CUT} Mpc (${over.length} galaxies): ` +
  [0.1, 0.25, 0.5, 0.75, 0.9, 0.99].map((p) => `p${Math.round(p * 100)} ${percentile(over, p).toFixed(2)}`).join(', ')
);
console.log(`above 3x mean: ${pct(3)}, above 10x: ${pct(10)}, above 30x: ${pct(30)}`);
console.log(`wrote ${BIN_PATH} (${(out.byteLength / 1024).toFixed(0)} kB) and its manifest`);
