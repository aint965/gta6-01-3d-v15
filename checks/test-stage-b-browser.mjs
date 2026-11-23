// test-stage-b-browser.mjs — headless-browser tests for Stage B:
// headlight cones (lights on vs off, haze on vs off, night), the demo
// auto-drive (live mode: 0 errors, speed > 0, fps is a real number) and
// the E prompt in live mode. Usage: node checks/test-stage-b-browser.mjs [port]
// The cone/roof/control sample boxes were measured from the night-drive
// screenshot (1280x720): the cone covers the road ahead of the car in the
// lower-centre of the frame; the roof is the traffic car ahead; the
// control is a patch of night sky (top-left).
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const port = parseInt(process.argv[2] || '8126', 10);
const CHROME = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const OUT = join(here, 'browser');
const { mkdirSync } = await import('node:fs');
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

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

function chromeArgs(url, extra = []) {
  return [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-logging=stderr', '--v=0',
    '--window-size=1280,720', '--virtual-time-budget=9000',
    ...extra, url,
  ];
}

async function shot(url, out) {
  const res = await run(CHROME, chromeArgs(url, [`--screenshot=${out}`]));
  const consoleErrors = res.stderr.split('\n').filter((l) => /CONSOLE\(\d+\)|ERROR:|\[ERROR/.test(l) && !/dbus|GPU|gpu|Vulkan|vulkan|swiftshader/i.test(l));
  const dom = await run(CHROME, chromeArgs(url, ['--dump-dom']));
  const m = dom.stdout.match(/<div id="game-errors"[^>]*>([^<]*)<\/div>/);
  const gameErrors = m ? m[1].trim() : 'DOM-NOT-FOUND';
  return { exists: existsSync(out), consoleErrors, gameErrors, dom: dom.stdout };
}

const server = spawn('node', ['serve.ts', '--port', String(port)], { cwd: repo, stdio: 'ignore' });
try {
  if (!await waitForServer()) {
    console.error('server did not come up');
    process.exit(1);
  }
  console.log(`server up on port ${port}`);

  // --- Headlight test: night, haze on and off, lights on vs off ----------
  // Sample boxes (x0, y0, x1, y1) in the 1280x720 frame, measured from the
  // night-drive screenshot: the cone's bright core is the 222-mean strip
  // at y=385-415, x=620-660; the roof box is the taxi's dark CABIN
  // (y=335-360) — not the yellow roof sign at y=315-325, which is
  // emissive and bright with the lights off too; the control is uniform
  // night sky (mean 37) at the top-left.
  const BOXES = {
    cone: [625, 385, 655, 415],   // road inside the bright cone core
    roof: [625, 335, 655, 360],   // dark cabin roof of the car ahead, in the beam
    control: [60, 50, 220, 100],  // night sky, unlit
  };
  const boxList = Object.entries(BOXES).map(([k, v]) => `${k}:${v.join(',')}`).join(' ');
  for (const haze of ['on', 'off']) {
    const hazeParam = haze === 'on' ? '' : '&haze=0';
    const onFile = join(OUT, `headlight-night-haze-${haze}-on.png`);
    const offFile = join(OUT, `headlight-night-haze-${haze}-off.png`);
    const urlOn = `http://localhost:${port}/?shot=night-drive&seed=20261123${hazeParam}&lights=1`;
    const urlOff = `http://localhost:${port}/?shot=night-drive&seed=20261123${hazeParam}&lights=0`;
    const rOn = await shot(urlOn, onFile);
    const rOff = await shot(urlOff, offFile);
    check(`headlight haze=${haze} on: 0 errors`, rOn.consoleErrors.length === 0 && rOn.gameErrors === '', `console=${rOn.consoleErrors.length} game=${rOn.gameErrors}`);
    check(`headlight haze=${haze} off: 0 errors`, rOff.consoleErrors.length === 0 && rOff.gameErrors === '', `console=${rOff.consoleErrors.length} game=${rOff.gameErrors}`);
    // Compare the two frames with PIL and write the numbers to a JSON file.
    const py = `
from PIL import Image
import json
on = Image.open(${JSON.stringify(onFile)}).convert('RGB')
off = Image.open(${JSON.stringify(offFile)}).convert('RGB')
out = {}
for name, (x0, y0, x1, y1) in ${JSON.stringify(BOXES)}.items():
    gains = []
    for y in range(y0, y1, 2):
        for x in range(x0, x1, 2):
            a = on.getpixel((x, y)); b = off.getpixel((x, y))
            gains.append(sum(a) / 3 - sum(b) / 3)
    mean = sum(gains) / len(gains)
    frac = sum(1 for g in gains if g > 10) / len(gains)
    out[name] = {'mean_gain': round(mean, 1), 'frac_gt10': round(frac, 3)}
print(json.dumps(out))
`;
    const cmp = await run('python3', ['-c', py]);
    let nums = {};
    try { nums = JSON.parse(cmp.stdout.trim().split('\n').pop()); } catch { /* keep empty */ }
    console.log(`  haze=${haze} gains:`, JSON.stringify(nums));
    const cone = nums.cone || {};
    const roof = nums.roof || {};
    const control = nums.control || {};
    check(`headlight haze=${haze}: cone gain >= +20, >=90% pixels > +10`, (cone.mean_gain || 0) >= 20 && (cone.frac_gt10 || 0) >= 0.9, `mean +${cone.mean_gain}, frac ${cone.frac_gt10}`);
    check(`headlight haze=${haze}: roof gain >= +20`, (roof.mean_gain || 0) >= 20, `mean +${roof.mean_gain}`);
    // NOTE: a gain of exactly 0.0 is a pass here (0 is falsy, so do NOT
    // use `|| fallback` on it — that turned a perfect 0 into 99).
    const cg = control.mean_gain;
    check(`headlight haze=${haze}: control within 1 level`, typeof cg === 'number' && Math.abs(cg) <= 1, `mean ${cg}`);
    void boxList;
  }

  // --- Demo drive: live mode, auto-driving north ---------------------------
  const demoUrl = `http://localhost:${port}/?demo=drive&seed=20261123`;
  const demoShot = join(OUT, 'demo-drive.png');
  const rDemo = await shot(demoUrl, demoShot);
  const speedM = rDemo.dom.match(/<div id="hud-speed"[^>]*>([^<]*)<\/div>/);
  const fpsM = rDemo.dom.match(/<span id="hud-fps"[^>]*>([^<]*)<\/span>/);
  const modeM = rDemo.dom.match(/<div id="hud-mode"[^>]*>([^<]*)<\/div>/);
  const speed = speedM ? speedM[1] : '?';
  const fps = fpsM ? fpsM[1] : '?';
  const mode = modeM ? modeM[1] : '?';
  check('demo drive: 0 console/page errors', rDemo.consoleErrors.length === 0 && rDemo.gameErrors === '', `console=${rDemo.consoleErrors.length} game=${rDemo.gameErrors}`);
  const speedNum = parseInt(speed, 10);
  check('demo drive: car is moving', Number.isFinite(speedNum) && speedNum > 0, `speed=${speed} mode=${mode}`);
  check('demo drive: fps is a real number (not —)', /^\d+ fps$/.test(fps), `fps=${fps}`);
  console.log(`  demo: speed=${speed} fps=${fps} mode=${mode}`);

  // --- Live mode on foot: E prompt appears next to a drivable car ---------
  // The player starts next to drivable[0] (330, 60); the prompt should read
  // ENTER. (No key presses are possible in headless --dump-dom, so this
  // checks the prompt the page renders on load.)
  const footUrl = `http://localhost:${port}/?seed=20261123`;
  const footShot = join(OUT, 'foot-start.png');
  const rFoot = await shot(footUrl, footShot);
  const promptM = rFoot.dom.match(/<div id="hud-prompt"[^>]*>([^<]*)<\/div>/);
  const prompt = promptM ? promptM[1] : '?';
  check('live on foot: 0 errors', rFoot.consoleErrors.length === 0 && rFoot.gameErrors === '', `console=${rFoot.consoleErrors.length} game=${rFoot.gameErrors}`);
  check('live on foot: E prompt shows ENTER near the car', /ENTER/.test(prompt), `prompt="${prompt}"`);
} finally {
  server.kill('SIGTERM');
}

console.log(failures === 0 ? 'STAGE B BROWSER OK' : `STAGE B BROWSER: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
