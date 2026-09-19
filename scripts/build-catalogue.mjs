/**
 * Download Huchra et al.'s 2MRS table 3 and make the binary catalogue used by
 * the map. The checked-in float16 file is the reproducible build output.
 *
 * Run: npm run catalogue
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const DATA = join(ROOT, 'public', 'data');
const URL = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=J/ApJS/199/26/table3&-out=GLON,GLAT,cz,Kcmag&-out.max=unlimited';
const C = 299792.458;
const H0 = 70;
const OMEGA_M = 0.3;
const OMEGA_L = 0.7;
const LINEAR_BELOW_CZ = 10000;

function comovingDistance(cz) {
  if (cz < LINEAR_BELOW_CZ) return cz / H0;
  const z = cz / C;
  const n = 256;
  const h = z / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const zi = i * h;
    const f = 1 / Math.sqrt(OMEGA_M * (1 + zi) ** 3 + OMEGA_L);
    sum += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * f;
  }
  return (C / H0) * h * sum / 3;
}

const raw = await (await fetch(URL)).text();
const rows = [];
let missing = 0;
let nonPositive = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line || line.startsWith('#') || line.startsWith('GLON')) continue;
  const [lText, bText, czText, magText] = line.split('\t').map((v) => v.trim());
  const l = Number(lText), b = Number(bText), cz = Number(czText), mag = Number(magText);
  if (![l, b, mag].every(Number.isFinite) || !Number.isFinite(cz)) { missing++; continue; }
  if (cz <= 0) { nonPositive++; continue; }
  const r = comovingDistance(cz);
  const lr = l * Math.PI / 180;
  const br = b * Math.PI / 180;
  rows.push([r * Math.cos(br) * Math.cos(lr), r * Math.cos(br) * Math.sin(lr), r * Math.sin(br), mag]);
}

await mkdir(DATA, { recursive: true });
const out = Buffer.alloc(rows.length * 16);
const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
for (let i = 0; i < rows.length; i++) for (let j = 0; j < 4; j++) view.setFloat32((i * 4 + j) * 4, rows[i][j], true);
const float32Path = join(DATA, '2mrs.float32.bin');
await writeFile(float32Path, out);
await writeFile(join(DATA, '2mrs.json'), JSON.stringify({
  count: rows.length,
  units: 'Mpc',
  magnitudeRange: {
    min: Math.min(...rows.map((row) => row[3])),
    max: Math.max(...rows.map((row) => row[3])),
    band: 'Ks',
    column: 'Kcmag',
  },
  format: {
    type: 'float32',
    endianness: 'little',
    components: ['x', 'y', 'z', 'mag'],
    strideBytes: 16,
    headerBytes: 0,
  },
  coordinates: 'observer-centered galactic; +x: l=0,b=0; +y: l=90,b=0; +z: galactic north',
  cosmology: { H0, omegaM: OMEGA_M, omegaLambda: OMEGA_L, linearBelowCz: LINEAR_BELOW_CZ },
  source: URL,
  citation: 'Huchra et al. 2012, ApJS 199, 26; VizieR J/ApJS/199/26/table3',
  dropped: { 'cz <= 0 (no positive redshift-derived distance)': nonPositive, 'missing cz': missing },
}, null, 2) + '\n');
console.log(`wrote ${rows.length} rows to ${float32Path}; missing=${missing}, nonPositive=${nonPositive}`);
console.log('Next: npm run density, npm run mask, then npm run pack-half -- public/data/2mrs.float32.bin public/data/2mrs.bin');
