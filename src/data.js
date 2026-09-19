import {
  DATA_URL, MANIFEST_URL, MAX_DISTANCE, MAG_BRIGHT, MAG_FAINT, DEG,
} from './constants.js';
import { makeRng } from './rng.js';

/**
 * The binary is observer-centred galactic cartesian float16, +x towards l=0,
 * +y towards l=90, +z galactic north. Which columns it holds, and in what
 * order, is whatever the manifest beside it says.
 *
 * Three.js wants +Y up, so the render frame is
 *   X = x (towards the galactic centre), Y = z (north), Z = -y.
 * That mapping is right-handed, so nothing else has to change.
 */
export function galacticToRender(x, y, z) {
  return [x, z, -y];
}

/** Unit vector in the render frame for galactic longitude/latitude in degrees. */
export function dirFromLB(lDeg, bDeg) {
  const l = lDeg * DEG;
  const b = bDeg * DEG;
  const cb = Math.cos(b);
  return [cb * Math.cos(l), Math.sin(b), -cb * Math.sin(l)];
}

/**
 * A galaxy is a disc or a spheroid seen at a random angle. For randomly
 * oriented thin discs cos(i) is uniform, and the apparent axis ratio of a
 * disc with intrinsic thickness q0 is sqrt(cos^2 i (1 - q0^2) + q0^2).
 * Ellipticals are rounder, so they get their own milder draw, and are
 * returned negative so the caller can tag them: they are drawn without a disc.
 */
function sampleAxisRatio(rng) {
  if (rng() < 0.28) return -(0.62 + 0.38 * rng()); // early type
  const q0 = 0.19;
  const cosi = rng();
  return Math.sqrt(cosi * cosi * (1 - q0 * q0) + q0 * q0);
}

function normaliseMag(mag) {
  const v = (MAG_FAINT - mag) / (MAG_FAINT - MAG_BRIGHT);
  return Math.min(1, Math.max(0, v));
}

/**
 * The survey's own mean density at a distance, from the table the density
 * script measured. It spans several decades, so it is interpolated in log.
 */
function meanDensityAt(table, r) {
  const { r: rs, n: ns } = table;
  if (r <= rs[0]) return ns[0];
  if (r >= rs[rs.length - 1]) return ns[ns.length - 1];
  const lo = Math.log(rs[0]);
  const f = ((Math.log(r) - lo) / (Math.log(rs[rs.length - 1]) - lo)) * (rs.length - 1);
  const i = Math.min(rs.length - 2, Math.floor(f));
  const w = f - i;
  return Math.exp(Math.log(ns[i]) * (1 - w) + Math.log(ns[i + 1]) * w);
}

export async function loadCatalogue() {
  const base = import.meta.env?.BASE_URL ?? '/';
  const [res, manifestRes] = await Promise.all([
    fetch(base + DATA_URL),
    fetch(base + MANIFEST_URL),
  ]);
  if (!res.ok) throw new Error(`catalogue request failed (${res.status})`);
  if (!manifestRes.ok) throw new Error(`catalogue manifest request failed (${manifestRes.status})`);
  const manifest = await manifestRes.json();
  const components = manifest.format.components;
  const stride = components.length;
  const at = Object.fromEntries(components.map((c, i) => [c, i]));

  const bytes = await res.arrayBuffer();
  const raw = new Uint16Array(bytes);
  if (raw.length % stride !== 0) throw new Error('catalogue does not match its manifest');
  const total = raw.length / stride;
  const values = new DataView(bytes);
  const valueAt = (index) => values.getFloat16(index * 2, true);

  // Local density is an optional channel: without it the map still draws,
  // it just has nothing to build clouds from.
  const densityTable = 'density' in at ? manifest.density?.meanDensity : null;
  const k = manifest.density?.k;

  const rng = makeRng(0x2a7b5);

  // First pass: how many survive the distance cut.
  const keep = new Uint8Array(total);
  let n = 0;
  for (let i = 0; i < total; i++) {
    const o = i * stride;
    const r = Math.hypot(valueAt(o + at.x), valueAt(o + at.y), valueAt(o + at.z));
    if (r > 0 && r <= MAX_DISTANCE) { keep[i] = 1; n++; }
  }
  if (n === 0) throw new Error('catalogue contained no galaxies inside the cut');

  const position = new Float32Array(n * 3);
  const shape = new Float32Array(n * 2);
  const bright = new Float32Array(n);
  const dist = new Float32Array(n);

  // Kept alongside for the deficit model: galactic l/b and the raw magnitude.
  const lon = new Float32Array(n);
  const lat = new Float32Array(n);
  const mags = new Float32Array(n);

  // Density over the survey's mean at that distance, and the neighbour
  // distance it came from. Both measured offline; see build-density.mjs.
  const overdensity = densityTable ? new Float32Array(n) : null;
  const neighbourDist = densityTable ? new Float32Array(n) : null;

  let j = 0;
  for (let i = 0; i < total; i++) {
    if (!keep[i]) continue;
    const o = i * stride;
    const x = valueAt(o + at.x), y = valueAt(o + at.y), z = valueAt(o + at.z), m = valueAt(o + at.mag);
    const r = Math.hypot(x, y, z);
    const [rx, ry, rz] = galacticToRender(x, y, z);

    position[j * 3] = rx; position[j * 3 + 1] = ry; position[j * 3 + 2] = rz;
    // An ellipse is the same shape turned by pi, so an early type's angle is
    // moved into [pi, 2 pi) to tag it for the shader at no cost.
    const angle = rng() * Math.PI;
    const q = sampleAxisRatio(rng);
    shape[j * 2] = q < 0 ? angle + Math.PI : angle;
    shape[j * 2 + 1] = Math.abs(q);
    bright[j] = normaliseMag(m);
    dist[j] = r;

    let l = Math.atan2(y, x) / DEG;
    if (l < 0) l += 360;
    lon[j] = l;
    lat[j] = Math.asin(z / r) / DEG;
    mags[j] = m;

    if (densityTable) {
      const rho = valueAt(o + at.density);
      overdensity[j] = rho / meanDensityAt(densityTable, r);
      neighbourDist[j] = Math.cbrt((3 * k) / (4 * Math.PI * rho));
    }
    j++;
  }

  return {
    count: n, position, shape, bright, dist, lon, lat, mags, rng,
    overdensity, neighbourDist,
  };
}
