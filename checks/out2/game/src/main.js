// main.js — Palkon Auto, Stage A entrypoint: builds the city, starts the
// WebGL renderer, runs the orbit camera and the HUD. Driving, missions,
// police and the title screen arrive in later stages; this stage is the
// renderer + the real-city Solmar + the living-city dressing.

import { buildCity, districtAt, SEED } from './city.js';
import { createRenderer, PRESETS } from './render.js';
import { createHud } from './hud.js';

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

// --- camera ---------------------------------------------------------------
const SHOTS = {
  'boulevard-day': { preset: 'midday', eye: [400, 55, 520], target: [400, 40, -250] },
  sunset: { preset: 'sunset', eye: [720, 28, 90], target: [180, 30, -30] },
  night: { preset: 'night', eye: [400, 60, 430], target: [400, 45, -320] },
  plaza: { preset: 'midday', eye: [660, 190, 360], target: [400, 20, 0] },
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

function setPreset(name) {
  if (!PRESETS[name]) return;
  presetName = name;
  renderer.setPreset(name);
}

if (shotMode) {
  const s = SHOTS[shotName];
  setPreset(s.preset);
  camera.eye = [...s.eye];
  camera.target = [...s.target];
  const dx = camera.target[0] - camera.eye[0];
  const dz = camera.target[2] - camera.eye[2];
  camera.yaw = Math.atan2(dx, dz);
  camera.dist = Math.hypot(dx, camera.eye[1] - camera.target[1], dz);
  camera.pitch = Math.asin((camera.eye[1] - camera.target[1]) / camera.dist);
} else {
  setPreset('midday');
  applyCamera();
}

// --- input: orbit + pan + zoom + preset keys ------------------------------
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

// --- frame loop -----------------------------------------------------------
const PRESET_LABELS = { midday: 'MIDDAY', sunset: 'SUNSET', night: 'NIGHT' };
const PRESET_CLOCKS = { midday: '12:00', sunset: '18:47', night: '23:30' };
let frames = 0;
let fpsText = shotMode ? '— fps' : '… fps';
let fpsWindowStart = performance.now();
let lastTime = performance.now();
let clockTime = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (!shotMode) {
    const speed = (keys['shift'] ? 260 : 120) * dt;
    const fx = Math.sin(camera.yaw);
    const fz = Math.cos(camera.yaw);
    const rx = Math.cos(camera.yaw);
    const rz = -Math.sin(camera.yaw);
    if (keys['w'] || keys['arrowup']) { camera.target[0] -= fx * speed; camera.target[2] -= fz * speed; }
    if (keys['s'] || keys['arrowdown']) { camera.target[0] += fx * speed; camera.target[2] += fz * speed; }
    if (keys['a'] || keys['arrowleft']) { camera.target[0] -= rx * speed; camera.target[2] -= rz * speed; }
    if (keys['d'] || keys['arrowright']) { camera.target[0] += rx * speed; camera.target[2] += rz * speed; }
    camera.target[0] = Math.max(-1900, Math.min(1900, camera.target[0]));
    camera.target[2] = Math.max(-1700, Math.min(1700, camera.target[2]));
    applyCamera();
    clockTime += dt;
    frames++;
    if (now - fpsWindowStart >= 1000) {
      fpsText = Math.round(frames * 1000 / (now - fpsWindowStart)) + ' fps';
      frames = 0;
      fpsWindowStart = now;
    }
  }
  const counts = renderer.render(camera, now);
  const district = districtAt(camera.target[0], camera.target[2]);
  const yawDeg = ((camera.yaw * 180) / Math.PI % 360 + 360) % 360;
  hud.update({
    district,
    clock: shotMode ? PRESET_CLOCKS[presetName] : PRESET_CLOCKS[presetName],
    presetLabel: PRESET_LABELS[presetName],
    fpsText,
    speedKmh: 0,
    shotMode,
    yawDeg,
    cameraTarget: [camera.target[0], camera.target[2]],
  });
  requestAnimationFrame(frame);
  window.__palkon = { city, renderer, camera, counts, presetName };
}

requestAnimationFrame(frame);
