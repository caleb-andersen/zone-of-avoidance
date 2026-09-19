/** Convert the browser catalogue to IEEE-754 binary16, without changing rows. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: node pack-half.mjs input.bin output.bin');

const source = readFileSync(input);
if (source.byteLength % 4 !== 0) throw new Error('input is not float32-aligned');
const floats = new Float32Array(source.buffer, source.byteOffset, source.byteLength / 4);
const packed = new Uint16Array(floats.length);
const view = new DataView(packed.buffer);
for (let i = 0; i < floats.length; i++) view.setFloat16(i * 2, floats[i], true);
writeFileSync(output, packed);
const manifestPath = join(process.cwd(), 'public/data/2mrs.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.format.type = 'float16';
manifest.format.strideBytes = manifest.format.components.length * 2;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
