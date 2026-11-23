// drive.mjs — serves the game, loads each shot from shots.json in the
// headless Chromium (SwiftShader WebGL), saves the screenshot, and fails
// on any console error or any text in #game-errors. Usage:
//   node checks/drive.mjs [port]
// Screenshots land in screenshots/ inside the repo.
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const port = parseInt(process.argv[2] || '8126', 10);
const CHROME = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const shots = JSON.parse(readFileSync(join(repo, 'shots.json'), 'utf8'));
mkdirSync(join(repo, 'screenshots'), { recursive: true });

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 90000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const server = spawn('node', ['serve.ts', '--port', String(port)], { cwd: repo, stdio: 'ignore' });
let failures = 0;
try {
  if (!await waitForServer()) {
    console.error(`server did not come up on port ${port}`);
    process.exit(1);
  }
  console.log(`server up on port ${port}`);
  for (const shot of shots) {
    const url = `http://localhost:${port}/${shot.query}`;
    const out = join(repo, 'screenshots', shot.name);
    const shotRes = await run(CHROME, [
      '--headless', '--disable-gpu', '--no-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--enable-logging=stderr', '--v=0',
      '--window-size=1280,720', '--virtual-time-budget=9000',
      `--screenshot=${out}`, url,
    ]);
    const consoleErrors = shotRes.stderr.split('\n').filter((l) => /CONSOLE\(\d+\)|ERROR:|\[ERROR/.test(l) && !/dbus|GPU|gpu|Vulkan|vulkan|swiftshader/i.test(l));
    const domRes = await run(CHROME, [
      '--headless', '--disable-gpu', '--no-sandbox',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--virtual-time-budget=9000', '--dump-dom', url,
    ]);
    const m = domRes.stdout.match(/<div id="game-errors"[^>]*>([^<]*)<\/div>/);
    const gameErrors = m ? m[1].trim() : 'DOM-NOT-FOUND';
    let exists = existsSync(out);
    let size = exists ? statSync(out).size : 0;
    // The kit caps each screenshot at 256 KiB and accepts JPEG too: a busy
    // aerial PNG over the cap is converted to JPEG quality 85 instead.
    if (exists && size > 250000 && out.toLowerCase().endsWith('.png')) {
      const jpg = out.replace(/\.png$/i, '.jpg');
      const conv = await run('python3', ['-c', `from PIL import Image; im = Image.open(${JSON.stringify(out)}); im.convert('RGB').save(${JSON.stringify(jpg)}, quality=85)`]);
      if (!conv.err && existsSync(jpg)) {
        unlinkSync(out);
        shot.name = shot.name.replace(/\.png$/i, '.jpg');
        size = statSync(jpg).size;
        console.log(`  ${shot.name}: converted PNG ${size} -> JPEG`);
      } else {
        console.log('  JPEG conversion failed:', (conv.stderr || '').slice(0, 200));
      }
    }
    const ok = exists && size > 10000 && size <= 262144 && consoleErrors.length === 0 && gameErrors === '';
    console.log(`${shot.name}: exists=${exists} size=${size} consoleErrors=${consoleErrors.length} gameErrors=${gameErrors === '' ? 'none' : gameErrors} -> ${ok ? 'OK' : 'FAIL'}`);
    for (const l of consoleErrors.slice(0, 5)) console.log('  console:', l.slice(0, 300));
    if (!ok) failures++;
  }
} finally {
  server.kill('SIGTERM');
}
// Persist any PNG -> JPEG rename so shots.json stays the source of truth.
writeFileSync(join(repo, 'shots.json'), JSON.stringify(shots));
console.log(failures === 0 ? 'drive: all shots OK' : `drive: ${failures} shot(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
