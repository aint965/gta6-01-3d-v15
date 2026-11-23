// pack-verify.mjs — runs main.ts twice into two output dirs and requires
// byte-identical dossier.json files (same sha256), so the packaging is
// deterministic. Usage: node checks/pack-verify.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const out1 = join(here, 'out1');
const out2 = join(here, 'out2');
for (const out of [out1, out2]) {
  execFileSync('node', ['main.ts'], { cwd: repo, env: { ...process.env, MAKEFUN_OUTPUT_DIR: out }, stdio: 'inherit' });
}
const d1 = readFileSync(join(out1, 'dossier.json'));
const d2 = readFileSync(join(out2, 'dossier.json'));
const h1 = createHash('sha256').update(d1).digest('hex');
const h2 = createHash('sha256').update(d2).digest('hex');
console.log(`dossier bytes: ${d1.length}, sha256 ${h1}`);
console.log(`dossier bytes: ${d2.length}, sha256 ${h2}`);
console.log(h1 === h2 ? 'packaging: byte-identical (2x)' : 'packaging: MISMATCH');
process.exit(h1 === h2 ? 0 : 1);
