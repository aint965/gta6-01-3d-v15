// main.js — Palkon Auto, Stage B entrypoint: builds the city, starts the
// WebGL renderer, runs the driving sim (traffic, lights, collisions,
// on-foot walking, E enter/exit) and the HUD. Missions, police and the
// title screen arrive in later stages.

import { buildCity, districtAt, SEED } from './city.js';
import { createRenderer, PRESETS } from './render.js';
import { createHud } from './hud.js';
import { createDrive, PROFILES } from './drive.js';

const errorsEl = document.getElementById('game-errors');
window.addEventListener('error', (e) => {
  if (errorsEl) errorsEl.textContent += (e.message || 'error') + '; ';
});
window.addEventListener('unhandledrejection', (e) => {
  if (errorsEl) errorsEl.textContent += 'rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason) + '; ';
});

const params = new URLSearchParams(window.location.search);
const seed = parseInt(params.get('seed') || String(SEED), 10) || SEED;
const city = buildCity(seed);
const canvas = document.getElementById('game-canvas');
const renderer = createRenderer(canvas, city);
const hud = createHud(city);
const drive = createDrive(city, seed);
if (params.get('haze') === '0') renderer.setHaze(false);
if (params.get('lights') === '0') drive.headlightsOn = false;
const demoDrive = params.get('demo') === 'drive';

// --- camera ---------------------------------------------------------------
const SHOTS = {
  'boulevard-day': { preset: 'midday', eye: [400, 55, 520], target: [400, 40, -250] },
  sunset: { preset: 'sunset', eye: [720, 28, 90], target: [180, 30, -30] },
  night: { preset: 'night', eye: [400, 60, 430], target: [400, 45, -320] },
  plaza: { preset: 'midday', eye: [660, 190, 360], target: [400, 20, 0] },
  // Drive shots are set up from the player car (see below).
  'drive-day': { preset: 'midday', drive: true },
  'night-drive': { preset: 'night', drive: true },
};
const shotName = params.get('shot');
const shotMode = !!shotName && !!SHOTS[shotName];

const camera = {
  eye: [400, 220, 700],
  target: [400, 30, 0],
  yaw: 0,
  pitch: 0.42,
  dist: 520,
};
let presetName = 'midday';

function applyCamera() {
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  camera.eye = [
    camera.target[0] + Math.sin(camera.yaw) * cp * camera.dist,
    camera.target[1] + sp * camera.dist,
    camera.target[2] + Math.cos(camera.yaw) * cp * camera.dist,
  ];
}

function setCameraFromEyeTarget(eye, target) {
  camera.eye = [...eye];
  camera.target = [...target];
  // Yaw follows the applyCamera convention: the direction FROM the target
  // TO the eye (yaw 0 = eye south of the target, looking north).
  const dx = camera.eye[0] - camera.target[0];
  const dz = camera.eye[2] - camera.target[2];
  camera.yaw = Math.atan2(dx, dz);
  camera.dist = Math.hypot(dx, camera.eye[1] - camera.target[1], dz);
  camera.pitch = Math.asin((camera.eye[1] - camera.target[1]) / camera.dist);
}

function setPreset(name) {
  if (!PRESETS[name]) return;
  presetName = name;
  renderer.setPreset(name);
}

if (shotMode) {
  const s = SHOTS[shotName];
  setPreset(s.preset);
  if (s.drive) {
    // Player in a car on the boulevard heading north toward the clock
    // tower, traffic running for 30 s, one car ahead in the headlights.
    // Camera 32 behind the car, 24 up, looking 18 ahead: the car sits
    // fully visible in the lower third, the road and the tower ahead.
    drive.placeForShot();
    const [px, pz] = drive.playerPos();
    const angle = drive.player.angle; // PI: facing north (-z)
    const fx = Math.sin(angle), fz = Math.cos(angle);
    setCameraFromEyeTarget(
      [px - fx * 32, 24, pz - fz * 32],
      [px + fx * 18, 6, pz + fz * 18],
    );
  } else {
    setCameraFromEyeTarget(s.eye, s.target);
  }
} else {
  setPreset('midday');
  if (demoDrive) {
    // Demo auto-drive starts on the boulevard heading north (the same
    // setup as the drive shots): starting from the side street at (330, 70)
    // forces a 180-degree turn onto the boulevard that the simple
    // auto-driver cannot make reliably.
    drive.placeForShot();
    const [dx, dz] = drive.playerPos();
    camera.target = [dx, 6, dz];
  } else {
    // Mara starts on foot next to the first drivable car (330, 60), 10 units
    // away — inside the 14-unit E-interact radius, so the ENTER prompt
    // shows on load.
    drive.player.x = 330;
    drive.player.z = 70;
    drive.player.angle = 0;
    camera.target = [330, 6, 70];
  }
  applyCamera();
}

// --- input: drive/walk + orbit + pan + zoom + preset keys ------------------
const keys = {};
let dragging = false;
let lastX = 0;
let lastY = 0;
window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === '1') setPreset('midday');
  if (e.key === '2') setPreset('sunset');
  if (e.key === '3') setPreset('night');
  if (e.key.toLowerCase() === 't') {
    const order = ['midday', 'sunset', 'night'];
    setPreset(order[(order.indexOf(presetName) + 1) % 3]);
  }
  if (e.key.toLowerCase() === 'e' && !e.repeat && !shotMode) drive.interact();
  if (e.key === ' ') e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mouseup', () => { dragging = false; });
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  camera.yaw -= (e.clientX - lastX) * 0.005;
  camera.pitch = Math.max(0.08, Math.min(1.35, camera.pitch + (e.clientY - lastY) * 0.004));
  lastX = e.clientX;
  lastY = e.clientY;
  applyCamera();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.dist = Math.max(40, Math.min(900, camera.dist * (1 + Math.sign(e.deltaY) * 0.09)));
  applyCamera();
}, { passive: false });

// --- demo auto-driver (headless drive test): enter a car, follow the ----
// --- boulevard north, pass east of the tower and fountain, brake for -----
// --- red lights and for the car ahead. ------------------------------------
function demoInput() {
  if (drive.player.mode === 'foot') drive.interact();
  const input = { up: true, down: false, left: false, right: false, handbrake: false, run: false };
  const [px, pz] = drive.playerPos();
  // Pass east of the tower (400,0) and fountain (400,120) on the plaza.
  const targetX = (pz < 170 && pz > -60) ? 442 : 400;
  const wantHeading = Math.PI + Math.max(-0.25, Math.min(0.25, (px - targetX) * 0.005));
  let dh = wantHeading - drive.player.angle;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  if (dh > 0.08) input.left = true;
  else if (dh < -0.08) input.right = true;
  if (drive.redLightAhead(45) || drive.carAhead(25)) {
    input.up = false;
    input.down = true;
  }
  return input;
}

// --- frame loop -----------------------------------------------------------
const PRESET_LABELS = { midday: 'MIDDAY', sunset: 'SUNSET', night: 'NIGHT' };
const PRESET_CLOCKS = { midday: '12:00', sunset: '18:47', night: '23:30' };
const HEADLIGHT_LEVELS = { midday: 0.8, sunset: 0.9, night: 1.0 };
let frames = 0;
let fpsText = shotMode ? '— fps' : '… fps';
let fpsWindowStart = performance.now();
let lastTime = performance.now();
let shotDynamicDone = false;

function frame(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (!shotMode) {
    const input = demoDrive ? demoInput() : {
      up: !!(keys['w'] || keys['arrowup']),
      down: !!(keys['s'] || keys['arrowdown']),
      left: !!(keys['a'] || keys['arrowleft']),
      right: !!(keys['d'] || keys['arrowright']),
      handbrake: !!keys[' '],
      run: !!keys['shift'],
    };
    drive.update(dt, input, camera.yaw);
    // Camera follows the player; while driving it settles behind the car.
    const [px, pz] = drive.playerPos();
    camera.target[0] = px;
    camera.target[2] = pz;
    camera.target[1] = 6;
    if (drive.player.mode === 'drive') {
      const want = drive.player.angle + Math.PI;
      let d = want - camera.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      camera.yaw += d * (1 - Math.exp(-2.5 * dt));
    }
    applyCamera();
    // Collision shake: a decaying random offset on the eye.
    const shake = drive.player.shake;
    if (shake > 0.01) {
      camera.eye[0] += (Math.random() - 0.5) * shake * 3;
      camera.eye[1] += (Math.random() - 0.5) * shake * 2;
    }
    frames++;
    if (now - fpsWindowStart >= 1000) {
      fpsText = Math.round(frames * 1000 / (now - fpsWindowStart)) + ' fps';
      frames = 0;
      fpsWindowStart = now;
    }
  }
  // Dynamic geometry every frame in live mode (traffic moves); in shot
  // mode the scene is static, so build it once — rebuilding it every frame
  // makes the headless screenshot run time out on SwiftShader.
  if (shotMode) {
    if (!shotDynamicDone) {
      const opts = drive.renderOpts(now);
      opts.headlightLevel = HEADLIGHT_LEVELS[presetName] ?? 1;
      renderer.setDynamicOpts(opts);
      shotDynamicDone = true;
    }
  } else {
    const opts = drive.renderOpts(now);
    opts.headlightLevel = HEADLIGHT_LEVELS[presetName] ?? 1;
    renderer.setDynamicOpts(opts);
  }
  const counts = renderer.render(camera, now);
  const district = districtAt(camera.target[0], camera.target[2]);
  const yawDeg = ((camera.yaw * 180) / Math.PI % 360 + 360) % 360;
  hud.update({
    district,
    clock: PRESET_CLOCKS[presetName],
    presetLabel: PRESET_LABELS[presetName],
    fpsText,
    speedKmh: drive.playerSpeedKmh(),
    shotMode,
    yawDeg,
    cameraTarget: [camera.target[0], camera.target[2]],
    modeLabel: shotMode
      ? 'SHOT VIEW'
      : (drive.player.mode === 'drive'
        ? `DRIVING · ${PROFILES[drive.player.profile].name}`
        : 'ON FOOT'),
    prompt: shotMode ? '' : drive.prompt().text,
    damage: drive.player.damage,
  });
  requestAnimationFrame(frame);
  window.__palkon = { city, renderer, camera, counts, presetName, drive };
}

requestAnimationFrame(frame);
