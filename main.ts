// Palkon Auto entry program (written for this entry, not copied from the
// kit starter): copies game/ and screenshots/ into the output directory
// and writes dossier.json. It refuses to build a bad dossier: it needs
// exactly 3 or 4 screenshots, each under the 256 KiB cap, and the game
// must carry an index.html. Run from the repo root:
//   node main.ts   (with MAKEFUN_OUTPUT_DIR set by the packager)
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const shotsDir = join(here, 'screenshots');

if (!existsSync(join(here, 'game', 'index.html'))) {
  throw new Error('game/index.html is missing — the game cannot be packaged');
}
const shots = existsSync(shotsDir)
  ? readdirSync(shotsDir).filter((n) => !n.startsWith('.')).sort()
  : [];
if (shots.length < 3 || shots.length > 4) {
  throw new Error(`screenshots/: need 3 or 4 images, found ${shots.length}`);
}
for (const name of shots) {
  const bytes = statSync(join(shotsDir, name)).size;
  if (bytes > 262144) {
    throw new Error(`screenshots/${name}: ${bytes} bytes, over the 256 KiB cap`);
  }
}
mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(shotsDir)) {
  cpSync(shotsDir, join(out, 'screenshots'), { recursive: true });
}
const dossierBytes = buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
});
writeFileSync(join(out, 'dossier.json'), dossierBytes);
// Verify the output, not just the input: the dossier must carry exactly
// the screenshots we packed, with a valid cover index. (buildDossier
// returns bytes, not a string, so decode before parsing.)
const dossier = JSON.parse(Buffer.from(dossierBytes).toString('utf8'));
if (!Array.isArray(dossier.images) || dossier.images.length !== shots.length) {
  throw new Error(`dossier.json carries ${dossier.images?.length ?? 0} images, expected ${shots.length}`);
}
if (typeof dossier.cover !== 'number' || dossier.cover < 0 || dossier.cover >= dossier.images.length) {
  throw new Error(`dossier.json cover index ${dossier.cover} is out of range`);
}
