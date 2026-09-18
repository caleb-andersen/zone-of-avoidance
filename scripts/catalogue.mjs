/**
 * Reading public/data/2mrs.bin the way its manifest says to, rather than
 * assuming a stride. The binary has grown a channel once already; anything
 * that reads it goes through here so that the next one does not break it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const BIN_PATH = join(ROOT, 'public/data/2mrs.bin');
export const MANIFEST_PATH = join(ROOT, 'public/data/2mrs.json');

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/**
 * The whole table as float32, plus a lookup from component name to its offset
 * within a row. Throws if the file and the manifest disagree about its size.
 */
export function readCatalogue() {
  const manifest = readManifest();
  const { components, strideBytes } = manifest.format;
  const stride = components.length;
  if (strideBytes !== stride * 4) {
    throw new Error(`manifest stride ${strideBytes} does not match ${stride} float32 components`);
  }
  const buf = readFileSync(BIN_PATH);
  if (buf.byteLength % strideBytes !== 0) {
    throw new Error(`2mrs.bin is ${buf.byteLength} bytes, not a whole number of ${strideBytes}-byte rows`);
  }
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const n = data.length / stride;
  if (manifest.count !== n) {
    throw new Error(`manifest says ${manifest.count} rows, file holds ${n}`);
  }
  const at = Object.fromEntries(components.map((c, i) => [c, i]));
  return { manifest, data, n, stride, at };
}
