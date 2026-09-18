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
 * The whole table expanded to float32, plus a lookup from component name to
 * its offset within a row. The shipped catalogue may be float16 to reduce
 * transfer size; offline analysis keeps its existing float32 interface.
 */
export function readCatalogue() {
  const manifest = readManifest();
  const { components, strideBytes, type } = manifest.format;
  const stride = components.length;
  const componentBytes = type === 'float16' ? 2 : type === 'float32' ? 4 : 0;
  if (!componentBytes || strideBytes !== stride * componentBytes) {
    throw new Error(`unsupported catalogue format ${type} with stride ${strideBytes}`);
  }
  const buf = readFileSync(BIN_PATH);
  if (buf.byteLength % strideBytes !== 0) {
    throw new Error(`2mrs.bin is ${buf.byteLength} bytes, not a whole number of ${strideBytes}-byte rows`);
  }
  const n = buf.byteLength / strideBytes;
  if (manifest.count !== n) {
    throw new Error(`manifest says ${manifest.count} rows, file holds ${n}`);
  }
  const at = Object.fromEntries(components.map((c, i) => [c, i]));
  if (type === 'float32') {
    const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return { manifest, data, n, stride, at };
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const data = new Float32Array(n * stride);
  for (let i = 0; i < data.length; i++) data[i] = view.getFloat16(i * 2, true);
  return { manifest, data, n, stride, at };
}
