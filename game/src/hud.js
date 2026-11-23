// hud.js — the DOM heads-up display: district line with standing bar,
// compass strip, clock + preset + fps, minimap, speedometer and controls.
// Pure DOM/canvas-2d; the game logic never touches it directly.

import { hexRgb } from './color.js';

export function createHud(city) {
  const el = (id) => document.getElementById(id);
  const districtName = el('hud-district');
  const districtTag = el('hud-tagline');
  const districtBar = el('hud-standing');
  const districtPct = el('hud-standing-pct');
  const compassCanvas = el('hud-compass');
  const clockEl = el('hud-clock');
  const presetEl = el('hud-preset');
  const fpsEl = el('hud-fps');
  const speedEl = el('hud-speed');
  const modeEl = el('hud-mode');
  const mini = el('hud-minimap');
  const mctx = mini.getContext('2d');
  const cctx = compassCanvas.getContext('2d');

  const S = 220 / 3840; // minimap scale: city x -1920..1920 -> 0..220
  const mx = (x) => (x + 1920) * S;
  const mz = (z) => (z + 1728) * (220 / 3456);

  function drawMinimap(cameraTarget) {
    mctx.clearRect(0, 0, 220, 220);
    mctx.fillStyle = '#1d2b26';
    mctx.fillRect(0, 0, 220, 220);
    // Water: canal band + harbour.
    mctx.fillStyle = '#398e99';
    mctx.fillRect(0, mz(city.canal.z0), 220, (city.canal.z1 - city.canal.z0) * (220 / 3456));
    mctx.fillRect(mx(city.harbour.x0), mz(city.harbour.z0), 220 - mx(city.harbour.x0), (city.harbour.z1 - city.harbour.z0) * (220 / 3456));
    // Beach sand.
    mctx.fillStyle = '#e8d9a8';
    mctx.fillRect(mx(city.beach.x0), mz(city.beach.z0), 220 - mx(city.beach.x0), 220 - mz(city.beach.z0));
    // Roads.
    mctx.strokeStyle = '#565a60';
    for (const r of city.roads) {
      mctx.lineWidth = Math.max(1, r.w * S);
      mctx.beginPath();
      mctx.moveTo(mx(r.x1), mz(r.z1));
      mctx.lineTo(mx(r.x2), mz(r.z2));
      mctx.stroke();
    }
    // Boulevard highlight.
    mctx.strokeStyle = '#d77f69';
    mctx.lineWidth = 3;
    mctx.beginPath();
    mctx.moveTo(mx(400), 0);
    mctx.lineTo(mx(400), 220);
    mctx.stroke();
    // Buildings as small rects coloured by district.
    const colByDistrict = {};
    for (const d of city.districts) colByDistrict[d.id] = d.palette[0];
    for (const b of city.buildings) {
      mctx.fillStyle = colByDistrict[b.district] || '#888';
      mctx.fillRect(mx(b.x - b.w / 2), mz(b.z - b.d / 2), Math.max(1.5, b.w * S), Math.max(1.5, b.d * (220 / 3456)));
    }
    // Plaza + park markers.
    mctx.fillStyle = '#d9cdb4';
    mctx.fillRect(mx(city.plaza.x0), mz(city.plaza.z0), (city.plaza.x1 - city.plaza.x0) * S, (city.plaza.z1 - city.plaza.z0) * (220 / 3456));
    mctx.fillStyle = '#6fae5f';
    mctx.fillRect(mx(city.park.x0), mz(city.park.z0), (city.park.x1 - city.park.x0) * S, (city.park.z1 - city.park.z0) * (220 / 3456));
    // Camera target arrow.
    const cx = mx(cameraTarget[0]);
    const cz = mz(cameraTarget[1]);
    mctx.fillStyle = '#ffd23d';
    mctx.beginPath();
    mctx.arc(cx, cz, 4, 0, Math.PI * 2);
    mctx.fill();
    mctx.strokeStyle = '#142d38';
    mctx.lineWidth = 1.5;
    mctx.stroke();
  }

  function drawCompass(yawDeg) {
    const W = compassCanvas.width;
    const H = compassCanvas.height;
    cctx.clearRect(0, 0, W, H);
    cctx.fillStyle = 'rgba(20, 45, 56, 0.75)';
    cctx.fillRect(0, 0, W, H);
    cctx.fillStyle = '#f2f2f2';
    cctx.font = 'bold 13px Georgia, serif';
    cctx.textAlign = 'center';
    cctx.textBaseline = 'middle';
    const points = [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'], [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW']];
    for (const [deg, label] of points) {
      let d = ((deg - yawDeg) % 360 + 540) % 360 - 180;
      if (Math.abs(d) > 90) continue;
      const x = W / 2 + (d / 90) * (W / 2 - 8);
      cctx.fillStyle = label === 'N' ? '#ffd23d' : '#f2f2f2';
      cctx.fillText(label, x, H / 2);
    }
    cctx.fillStyle = '#e8604a';
    cctx.beginPath();
    cctx.moveTo(W / 2, 2);
    cctx.lineTo(W / 2 - 5, 9);
    cctx.lineTo(W / 2 + 5, 9);
    cctx.closePath();
    cctx.fill();
  }

  function update(state) {
    districtName.textContent = state.district.name;
    districtTag.textContent = state.district.tagline;
    districtBar.style.width = state.district.standing + '%';
    districtPct.textContent = state.district.standing + '/100';
    clockEl.textContent = state.clock;
    presetEl.textContent = state.presetLabel;
    fpsEl.textContent = state.fpsText;
    speedEl.textContent = state.speedKmh + ' km/h';
    modeEl.textContent = state.shotMode ? 'SHOT VIEW' : 'STAGE A · FREE CAMERA';
    drawCompass(state.yawDeg);
    drawMinimap(state.cameraTarget);
  }

  return { update };
}
