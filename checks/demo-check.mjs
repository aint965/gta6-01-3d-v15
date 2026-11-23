// demo-check.mjs — one-off: load ?demo=drive, dump the DOM, print the HUD
// speed/fps/mode and the game-errors div. Usage: node checks/demo-check.mjs [port]
import { spawn, execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const port = parseInt(process.argv[2] || '8126', 10);
const CHROME = process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';

function run(cmd, args, timeout = 180000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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
try {
  if (!await waitForServer()) {
    console.error('server did not come up');
    process.exit(1);
  }
  const url = `http://localhost:${port}/?demo=drive&seed=20261123`;
  const res = await run(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-logging=stderr', '--v=0',
    '--window-size=1280,720', '--virtual-time-budget=9000',
    '--dump-dom', url,
  ]);
  const dom = res.stdout;
  const pick = (id) => {
    const m = dom.match(new RegExp(`<[^>]*id="${id}"[^>]*>([^<]*)<`));
    return m ? m[1] : '?';
  };
  const consoleErrors = res.stderr.split('\n').filter((l) => /CONSOLE\(\d+\)|ERROR:|\[ERROR/.test(l) && !/dbus|GPU|gpu|Vulkan|vulkan|swiftshader/i.test(l));
  console.log('game-errors:', JSON.stringify(pick('game-errors')));
  console.log('console errors:', consoleErrors.length, consoleErrors.slice(0, 3));
  console.log('speed:', pick('hud-speed'));
  console.log('fps:', pick('hud-fps'));
  console.log('mode:', pick('hud-mode'));
  console.log('prompt:', JSON.stringify(pick('hud-prompt')));
  console.log('damage:', JSON.stringify(pick('hud-damage')));
  const speed = parseInt(pick('hud-speed'), 10);
  const ok = pick('game-errors') === '' && consoleErrors.length === 0
    && Number.isFinite(speed) && speed > 0
    && /^\d+ fps$/.test(pick('hud-fps'))
    && /DRIVING/.test(pick('hud-mode'));
  console.log(ok ? 'DEMO DRIVE OK' : 'DEMO DRIVE: CHECK FAILED');
  process.exit(ok ? 0 : 1);
} finally {
  server.kill('SIGTERM');
}
