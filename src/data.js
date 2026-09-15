import { DATA_URL, MAX_DISTANCE, MAG_BRIGHT, MAG_FAINT, DEG } from './constants.js';
import { makeRng } from './rng.js';

/**
 * The binary is observer-centred galactic cartesian, float32 x/y/z/mag,
 * +x towards l=0, +y towards l=90, +z galactic north.
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
 * Ellipticals are rounder, so they get their own milder draw.
 */
function sampleAxisRatio(rng) {
  if (rng() < 0.28) return 0.62 + 0.38 * rng(); // early type
  const q0 = 0.19;
  const cosi = rng();
  return Math.sqrt(cosi * cosi * (1 - q0 * q0) + q0 * q0);
}

function normaliseMag(mag) {
  const v = (MAG_FAINT - mag) / (MAG_FAINT - MAG_BRIGHT);
  return Math.min(1, Math.max(0, v));
}

export async function loadCatalogue() {
  const base = import.meta.env?.BASE_URL ?? '/';
  const res = await fetch(base + DATA_URL);
  if (!res.ok) throw new Error(`catalogue request failed (${res.status})`);
  const raw = new Float32Array(await res.arrayBuffer());
  const total = Math.floor(raw.length / 4);

  const rng = makeRng(0x2a7b5);

  // First pass: how many survive the distance cut.
  const keep = new Uint8Array(total);
  let n = 0;
  for (let i = 0; i < total; i++) {
    const x = raw[i * 4], y = raw[i * 4 + 1], z = raw[i * 4 + 2];
    const r = Math.hypot(x, y, z);
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

  let k = 0;
  for (let i = 0; i < total; i++) {
    if (!keep[i]) continue;
    const x = raw[i * 4], y = raw[i * 4 + 1], z = raw[i * 4 + 2], m = raw[i * 4 + 3];
    const r = Math.hypot(x, y, z);
    const [rx, ry, rz] = galacticToRender(x, y, z);

    position[k * 3] = rx; position[k * 3 + 1] = ry; position[k * 3 + 2] = rz;
    shape[k * 2] = rng() * Math.PI;
    shape[k * 2 + 1] = sampleAxisRatio(rng);
    bright[k] = normaliseMag(m);
    dist[k] = r;

    let l = Math.atan2(y, x) / DEG;
    if (l < 0) l += 360;
    lon[k] = l;
    lat[k] = Math.asin(z / r) / DEG;
    mags[k] = m;
    k++;
  }

  return { count: n, position, shape, bright, dist, lon, lat, mags, rng };
}
