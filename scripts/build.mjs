//   node scripts/build.mjs [--out dist]
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = resolve(ROOT, outIndex >= 0 ? args[outIndex + 1] : 'dist');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(ROOT, 'index.html'), join(out, 'index.html'));
cpSync(join(ROOT, 'src'), join(out, 'src'), { recursive: true });
console.log(`built ${out}`);
