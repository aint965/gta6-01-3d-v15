// render.js — handwritten WebGL 2 renderer for Palkon Auto. One shader
// program, one attribute layout, no vendor code. Static geometry (the city)
// is built once per lighting preset; cars and pedestrians live in a small
// dynamic buffer rebuilt on demand. The sky (band, top, sun, moon, stars)
// is rebuilt per preset too.

import { hexRgb } from './color.js';

export const PRESETS = {
  midday: {
    sunDir: [0.45, 0.85, 0.25], sunColor: [1.0, 0.95, 0.82], ambient: [0.42, 0.44, 0.46],
    fogColor: [0.78, 0.84, 0.90], fogDensity: 0.00042, skyTop: '#5b9bd5', horizon: '#bcd9e8',
    emissiveScale: 0.15, shadowLen: 0.35, sunPos: [0.45, 0.85, 0.25],
  },
  sunset: {
    sunDir: [0.92, 0.18, -0.28], sunColor: [1.0, 0.62, 0.32], ambient: [0.36, 0.28, 0.30],
    fogColor: [0.98, 0.62, 0.38], fogDensity: 0.00055, skyTop: '#4a3a6e', horizon: '#ff8a4a',
    emissiveScale: 0.6, shadowLen: 1.6, sunPos: [0.92, 0.18, -0.28],
  },
  night: {
    sunDir: [-0.35, 0.55, -0.45], sunColor: [0.30, 0.38, 0.62], ambient: [0.16, 0.18, 0.26],
    fogColor: [0.05, 0.07, 0.12], fogDensity: 0.00075, skyTop: '#060a18', horizon: '#141a2e',
    emissiveScale: 1.0, shadowLen: 0.5, sunPos: [-0.35, 0.55, -0.45],
  },
};

// --- small matrix helpers (column-major, like WebGL expects) -------------
export function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function lookAt(eye, target, up) {
  const zx = eye[0] - target[0];
  const zy = eye[1] - target[1];
  const zz = eye[2] - target[2];
  let zl = Math.hypot(zx, zy, zz) || 1;
  const z0 = zx / zl, z1 = zy / zl, z2 = zz / zl;
  let xx = up[1] * z2 - up[2] * z1;
  let xy = up[2] * z0 - up[0] * z2;
  let xz = up[0] * z1 - up[1] * z0;
  zl = Math.hypot(xx, xy, xz) || 1;
  xx /= zl; xy /= zl; xz /= zl;
  const yx = z1 * xz - z2 * xy;
  const yy = z2 * xx - z0 * xz;
  const yz = z0 * xy - z1 * xx;
  return new Float32Array([
    xx, yx, z0, 0,
    xy, yy, z1, 0,
    xz, yz, z2, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]),
    1,
  ]);
}

// --- geometry accumulator: 16 floats per vertex ------------------------
// pos(3) normal(3) color(3) emissive(3) uv(2) tex(1) spec(1)
export class Geo {
  constructor() {
    this.data = [];
  }
  vert(x, y, z, nx, ny, nz, color, emissive, uv, tex, spec) {
    this.data.push(x, y, z, nx, ny, nz, color[0], color[1], color[2],
      emissive[0], emissive[1], emissive[2], uv[0], uv[1], tex, spec);
  }
  tri(a, b, c) {
    this.vert(...a); this.vert(...b); this.vert(...c);
  }
  // p0..p3 corners (counter-clockwise seen from the normal side)
  quad(p0, p1, p2, p3, normal, color, emissive = [0, 0, 0], uv = null, tex = 0, spec = 0) {
    const uvs = uv || [[0, 0], [1, 0], [1, 1], [0, 1]];
    const mk = (p, i) => [p[0], p[1], p[2], normal[0], normal[1], normal[2], color, emissive, uvs[i], tex, spec];
    this.tri(mk(p0, 0), mk(p1, 1), mk(p2, 2));
    this.tri(mk(p0, 0), mk(p2, 2), mk(p3, 3));
  }
  // Axis-aligned or Y-rotated box, centred at (cx, cy, cz), height h.
  box(cx, cy, cz, w, h, d, angle, color, emissive = [0, 0, 0], spec = 0) {
    const hw = w / 2, hd = d / 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    const rot = (x, z) => [cx + x * c - z * s, cz + x * s + z * c];
    const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => rot(x, z));
    const y0 = cy, y1 = cy + h;
    const top = corners.map(([x, z]) => [x, y1, z]);
    const bot = corners.map(([x, z]) => [x, y0, z]);
    this.quad(top[0], top[3], top[2], top[1], [0, 1, 0], color, emissive, null, 0, spec);
    this.quad(bot[0], bot[1], bot[2], bot[3], [0, -1, 0], color, emissive, null, 0, spec);
    const sides = [[0, 1, [0, -1]], [1, 2, [1, 0]], [2, 3, [0, 1]], [3, 0, [-1, 0]]];
    for (const [i, j, n] of sides) {
      const nx = n[0] * c - n[1] * s;
      const nz = n[0] * s + n[1] * c;
      this.quad(bot[i], top[i], top[j], bot[j], [nx, 0, nz], color, emissive, null, 0, spec);
    }
  }
  // 4-sided pyramid (cone) with apex at (cx, cy + h, cz).
  pyramid(cx, cy, cz, r, h, angle, color, emissive = [0, 0, 0]) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const rot = (x, z) => [cx + x * c - z * s, cz + x * s + z * c];
    const base = [[-r, -r], [r, -r], [r, r], [-r, r]].map(([x, z]) => rot(x, z));
    const apex = [cx, cy + h, cz];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const p0 = [base[i][0], cy, base[i][1]];
      const p1 = [base[j][0], cy, base[j][1]];
      const mx = (base[i][0] + base[j][0]) / 2 - cx;
      const mz = (base[i][1] + base[j][1]) / 2 - cz;
      const n = [mx, r * 0.7, mz];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      this.tri(
        [p1[0], p1[1], p1[2], n[0] / nl, n[1] / nl, n[2] / nl, color, emissive, [1, 0], 0, 0],
        [p0[0], p0[1], p0[2], n[0] / nl, n[1] / nl, n[2] / nl, color, emissive, [0, 0], 0, 0],
        [apex[0], apex[1], apex[2], n[0] / nl, n[1] / nl, n[2] / nl, color, emissive, [0.5, 1], 0, 0],
      );
    }
    this.quad(
      [base[0][0], cy, base[0][1]], [base[1][0], cy, base[1][1]],
      [base[2][0], cy, base[2][1]], [base[3][0], cy, base[3][1]],
      [0, -1, 0], color, emissive,
    );
  }
  // Flat disc (fan) in the XZ plane. Faces +Y by default; pass down=true
  // for a disc seen from below (the sky top).
  disc(cx, cy, cz, r, color, emissive = [0, 0, 0], segments = 16, down = false) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r];
      const p1 = [cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r];
      const first = down ? p0 : p1;
      const second = down ? p1 : p0;
      this.tri(
        [cx, cy, cz, 0, 1, 0, color, emissive, [0.5, 0.5], 0, 0],
        [first[0], first[1], first[2], 0, 1, 0, color, emissive, [0, 0], 0, 0],
        [second[0], second[1], second[2], 0, 1, 0, color, emissive, [1, 1], 0, 0],
      );
    }
  }
  // Flat disc facing the origin: the sun/moon, seen from inside the city.
  // dir is the unit vector from the origin to the disc centre.
  discFacing(cx, cy, cz, r, color, emissive, dir, segments = 20) {
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    // right = d x up with up = (0,1,0) -> (-d[2], 0, d[0]).
    let right = [-d[2], 0, d[0]];
    if (Math.hypot(right[0], right[1], right[2]) < 0.01) right = [1, 0, 0];
    const rl = Math.hypot(right[0], right[1], right[2]);
    right = [right[0] / rl, right[1] / rl, right[2] / rl];
    const up2 = [
      right[1] * d[2] - right[2] * d[1],
      right[2] * d[0] - right[0] * d[2],
      right[0] * d[1] - right[1] * d[0],
    ];
    const n = [-d[0], -d[1], -d[2]];
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p = (a) => [
        cx + (right[0] * Math.cos(a) + up2[0] * Math.sin(a)) * r,
        cy + (right[1] * Math.cos(a) + up2[1] * Math.sin(a)) * r,
        cz + (right[2] * Math.cos(a) + up2[2] * Math.sin(a)) * r,
      ];
      const p0 = p(a0), p1 = p(a1);
      this.tri(
        [cx, cy, cz, n[0], n[1], n[2], color, emissive, [0.5, 0.5], 0, 0],
        [p0[0], p0[1], p0[2], n[0], n[1], n[2], color, emissive, [0, 0], 0, 0],
        [p1[0], p1[1], p1[2], n[0], n[1], n[2], color, emissive, [1, 1], 0, 0],
      );
    }
  }
  // Small square facing the origin (a star).
  starQuad(cx, cy, cz, s, dir, color) {
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    let right = [-d[2], 0, d[0]];
    if (Math.hypot(right[0], right[1], right[2]) < 0.01) right = [1, 0, 0];
    const rl = Math.hypot(right[0], right[1], right[2]);
    right = [right[0] / rl, right[1] / rl, right[2] / rl];
    const up2 = [
      right[1] * d[2] - right[2] * d[1],
      right[2] * d[0] - right[0] * d[2],
      right[0] * d[1] - right[1] * d[0],
    ];
    const n = [-d[0], -d[1], -d[2]];
    const p = (a, b) => [
      cx + right[0] * a + up2[0] * b,
      cy + right[1] * a + up2[1] * b,
      cz + right[2] * a + up2[2] * b,
    ];
    this.quad(p(-s, -s), p(s, -s), p(s, s), p(-s, s), n, color, color);
  }
  toFloat32() {
    return new Float32Array(this.data);
  }
  get vertexCount() {
    return this.data.length / 16;
  }
}

// --- static city geometry -------------------------------------------------
function windowQuads(geo, b, rng) {
  // Windows on the front and back faces only, rows of floors, some lit.
  const floors = Math.max(1, Math.floor(b.h / 14));
  const perRow = Math.max(1, Math.floor(b.w / 13));
  const winW = 3, winH = 4.5;
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  for (let f = 0; f < floors; f++) {
    const y = 5 + f * 14;
    if (y + winH > b.h - 2) break;
    for (let i = 0; i < perRow; i++) {
      const u = (i + 0.5) / perRow;
      const ox = (u - 0.5) * (b.w - 8);
      const oz = (u - 0.5) * (b.d - 8);
      const lit = rng() < 0.28;
      const col = lit ? [1.0, 0.82, 0.45] : [0.10, 0.14, 0.19];
      const emi = lit ? [0.95, 0.72, 0.35] : [0, 0, 0];
      for (const side of [1, -1]) {
        const dz = side * (b.d / 2 + 0.15);
        const corners = [
          [ox - winW / 2, y, dz], [ox + winW / 2, y, dz],
          [ox + winW / 2, y + winH, dz], [ox - winW / 2, y + winH, dz],
        ].map(([x, yy, z]) => [b.x + x * c - z * s, yy, b.z + x * s + z * c]);
        const nz = side * c;
        const nx = side * s;
        // The back face needs the reversed order, or it is culled.
        if (side === 1) geo.quad(corners[0], corners[1], corners[2], corners[3], [nx, 0, nz], col, emi);
        else geo.quad(corners[1], corners[0], corners[3], corners[2], [nx, 0, nz], col, emi);
      }
    }
  }
}

export function buildStaticGeometry(city, presetName) {
  const geo = new Geo();
  const preset = PRESETS[presetName];
  const up = [0, 1, 0];
  const rng = { v: 1234567 };
  const rnd = () => {
    rng.v = (rng.v * 1664525 + 1013904223) >>> 0;
    return rng.v / 4294967296;
  };

  // Ground: one big grass plane, then beach sand, plaza stone, water.
  geo.quad([-5000, 0, -5000], [-5000, 0, 5000], [5000, 0, 5000], [5000, 0, -5000], up, hexRgb('#5d8a52'));
  const B = city.beach;
  geo.quad([B.x0, 0.02, B.z0], [B.x0, 0.02, B.z1], [B.x1, 0.02, B.z1], [B.x1, 0.02, B.z0], up, hexRgb('#e8d9a8'));
  const P = city.plaza;
  geo.quad([P.x0, 0.02, P.z0], [P.x0, 0.02, P.z1], [P.x1, 0.02, P.z1], [P.x1, 0.02, P.z0], up, hexRgb('#d9cdb4'));
  const water = hexRgb('#398e99');
  geo.quad([-1920, 0.05, city.canal.z0], [-1920, 0.05, city.canal.z1], [1920, 0.05, city.canal.z1], [1920, 0.05, city.canal.z0], up, water, [0, 0, 0], null, 0, 0.7);
  const H = city.harbour;
  geo.quad([H.x0, 0.05, H.z0], [H.x0, 0.05, H.z1], [H.x1, 0.05, H.z1], [H.x1, 0.05, H.z0], up, water, [0, 0, 0], null, 0, 0.7);
  // Park lawn.
  const K = city.park;
  geo.quad([K.x0, 0.02, K.z0], [K.x0, 0.02, K.z1], [K.x1, 0.02, K.z1], [K.x1, 0.02, K.z0], up, hexRgb('#6fae5f'));

  // Roads: asphalt, pale sidewalks on the big ones, centre dashes.
  const asphalt = hexRgb('#565a60');
  const sidewalk = hexRgb('#d8cfc0');
  const dash = hexRgb('#e8d27a');
  for (const r of city.roads) {
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const hw = r.w / 2;
    const p = (x, z) => [x, 0.03, z];
    geo.quad(p(r.x1 + nx * hw, r.z1 + nz * hw), p(r.x2 + nx * hw, r.z2 + nz * hw), p(r.x2 - nx * hw, r.z2 - nz * hw), p(r.x1 - nx * hw, r.z1 - nz * hw), up, asphalt);
    if (r.kind === 'boulevard' || r.kind === 'avenue' || r.kind === 'secondary') {
      const sw = 6;
      for (const side of [1, -1]) {
        const a = hw + (side === 1 ? 0 : -sw);
        const b2 = hw + (side === 1 ? sw : 0);
        geo.quad(
          p(r.x1 + nx * b2, r.z1 + nz * b2), p(r.x2 + nx * b2, r.z2 + nz * b2),
          p(r.x2 + nx * a, r.z2 + nz * a), p(r.x1 + nx * a, r.z1 + nz * a),
          up, sidewalk,
        );
      }
      // Centre dashes every 24 units.
      for (let d = 12; d < len - 6; d += 24) {
        const t = d / len;
        const cx = r.x1 + dx * t, cz = r.z1 + dz * t;
        const ux = dx / len, uz = dz / len;
        const L = 7, W = 1.2;
        geo.quad(
          [cx - ux * L + nx * W, 0.05, cz - uz * L + nz * W],
          [cx + ux * L + nx * W, 0.05, cz + uz * L + nz * W],
          [cx + ux * L - nx * W, 0.05, cz + uz * L - nz * W],
          [cx - ux * L - nx * W, 0.05, cz - uz * L - nz * W],
          up, dash,
        );
      }
    }
    // Bridges: a raised deck + two edge rails where a road crosses the canal.
    if ((r.z1 < city.canal.z0 && r.z2 > city.canal.z1) || (r.z1 > city.canal.z1 && r.z2 < city.canal.z0)) {
      const t0 = (city.canal.z0 - r.z1) / dz;
      const t1 = (city.canal.z1 - r.z1) / dz;
      const at = (t, side) => [r.x1 + dx * t + nx * side * hw, 0.6, r.z1 + dz * t + nz * side * hw];
      geo.quad(at(t0, -1), at(t0, 1), at(t1, 1), at(t1, -1), up, hexRgb('#8a7f6a'));
      const rail = hexRgb('#c9b98a');
      const span = Math.abs(t1 - t0) * len;
      const midT = (t0 + t1) / 2;
      const midX = r.x1 + dx * midT;
      const midZ = r.z1 + dz * midT;
      const angle = Math.atan2(dx, dz);
      for (const side of [-1, 1]) {
        geo.box(midX + nx * side * (hw - 0.6), 0.6, midZ + nz * side * (hw - 0.6), 1.2, 1.6, span, angle, rail);
      }
    }
  }

  // Plaza landmark: clock tower + fountain.
  const tower = hexRgb('#ead8b2');
  geo.box(400, 0, 0, 18, 90, 18, 0, tower);
  geo.pyramid(400, 90, 0, 13, 16, 0, hexRgb('#d77f69'));
  const clockFace = [1, 1, 1];
  geo.quad([394, 78, 9.2], [406, 78, 9.2], [406, 90, 9.2], [394, 90, 9.2], [0, 0, 1], clockFace);
  geo.quad([406, 78, -9.2], [394, 78, -9.2], [394, 90, -9.2], [406, 90, -9.2], [0, 0, -1], clockFace);
  const hand = [0.1, 0.1, 0.1];
  geo.box(400, 83.5, 9.4, 0.8, 5, 0.3, 0, hand);
  geo.box(402, 83, 9.4, 4, 0.8, 0.3, 0, hand);
  geo.disc(400, 0.4, 120, 22, hexRgb('#8a7f6a'));
  geo.disc(400, 0.7, 120, 18, hexRgb('#398e99'), [0, 0, 0], 20);
  geo.box(400, 0.7, 120, 3, 10, 3, 0, hexRgb('#d9cdb4'));
  geo.disc(400, 10.6, 120, 5, hexRgb('#a8d8e0'));

  // Buildings: walls, roof cap, windows, and a ground shadow that leans
  // away from the sun (length depends on the preset).
  const shadow = hexRgb('#262b30');
  const roofDark = (col) => [col[0] * 0.55, col[1] * 0.55, col[2] * 0.55];
  const sunA = Math.atan2(preset.sunDir[0], preset.sunDir[2]);
  const shx = -Math.sin(sunA) * preset.shadowLen;
  const shz = -Math.cos(sunA) * preset.shadowLen;
  for (const b of city.buildings) {
    const wall = hexRgb(b.wall);
    const spec = b.glass ? 0.55 : 0.08;
    geo.box(b.x, 0, b.z, b.w, b.h, b.d, b.angle, wall, [0, 0, 0], spec);
    // Roof cap: a thin darker slab on top.
    geo.box(b.x, b.h, b.z, b.w * 0.92, 1.2, b.d * 0.92, b.angle, roofDark(wall));
    // Brick trim on the street-facing base for non-glass buildings.
    if (!b.glass && b.h >= 16) {
      geo.box(b.x, 0, b.z, b.w * 1.02, 3, b.d * 1.02, b.angle, hexRgb(b.brick));
    }
    windowQuads(geo, b, rnd);
    // Ground shadow: offset quad, stretched with height.
    const L = b.h * preset.shadowLen * 0.6;
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const hw = b.w / 2 + L * 0.4, hd = b.d / 2;
    const ox = shx * L * 0.5, oz = shz * L * 0.5;
    const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => [b.x + ox + x * c - z * s, 0.04, b.z + oz + x * s + z * c]);
    geo.quad(pts[0], pts[3], pts[2], pts[1], up, shadow);
  }

  // Trees: trunk + two foliage cones (palm variant: taller, one cone).
  const trunkCol = hexRgb('#6a4a2e');
  const leafCol = hexRgb('#3d7a44');
  const leafCol2 = hexRgb('#4c8a3f');
  for (const t of city.trees) {
    const s = t.s;
    geo.box(t.x, 0, t.z, 1.6 * s, 5 * s, 1.6 * s, 0, trunkCol);
    if (t.palm) {
      geo.pyramid(t.x, 4.5 * s, t.z, 7 * s, 7 * s, 0.4, leafCol2);
    } else {
      geo.pyramid(t.x, 4 * s, t.z, 6 * s, 8 * s, 0, leafCol);
      geo.pyramid(t.x, 8 * s, t.z, 4.2 * s, 6 * s, 0.5, leafCol2);
    }
  }

  // Lamps: pole + glowing head + light pool on the pavement.
  const poleCol = hexRgb('#2e3440');
  const headCol = [1.0, 0.85, 0.55];
  const poolCol = [0.85, 0.7, 0.4];
  for (const l of city.lamps) {
    geo.box(l.x, 0, l.z, 0.7, l.h, 0.7, 0, poleCol);
    geo.box(l.x, l.h, l.z, 2.2, 1.2, 2.2, 0, headCol, [0.9, 0.72, 0.35]);
    geo.disc(l.x, 0.04, l.z, 6, poolCol, [0.35, 0.28, 0.12], 12);
  }

  // Boats: hull + cabin + mast.
  for (const b of city.boats) {
    geo.box(b.x, 0.1, b.z, 6 * b.s, 3, 14 * b.s, b.angle, hexRgb('#e8e4d8'));
    geo.box(b.x, 3, b.z, 4 * b.s, 3.5, 6 * b.s, b.angle, hexRgb('#3d6ec9'));
    geo.box(b.x, 3, b.z, 0.5, 12 * b.s, 0.5, b.angle, trunkCol);
    geo.quad([b.x - 3 * b.s, 12 * b.s, b.z], [b.x - 3 * b.s, 4 * b.s, b.z], [b.x + 3 * b.s, 4 * b.s, b.z], [b.x + 3 * b.s, 12 * b.s, b.z], [0, 0, 1], hexRgb('#f2f2f2'));
  }

  // Traffic lights: pole + head + red lamp lit.
  for (const tl of city.trafficLights) {
    geo.box(tl.x, 0, tl.z, 0.8, 12, 0.8, 0, poleCol);
    geo.box(tl.x, 12, tl.z, 3, 7, 3, 0, [0.12, 0.12, 0.14]);
    geo.box(tl.x, 17, tl.z, 1.6, 1.6, 0.4, 0, [1, 0.15, 0.1], [0.9, 0.1, 0.05]);
    geo.box(tl.x, 15, tl.z, 1.6, 1.6, 0.4, 0, [0.2, 0.12, 0.08]);
    geo.box(tl.x, 13, tl.z, 1.6, 1.6, 0.4, 0, [0.1, 0.2, 0.1]);
  }

  // Neon signs are textured quads; the atlas is built by the renderer.
  return geo;
}

// --- sky geometry (rebuilt per preset) -----------------------------------
export function buildSkyGeometry(presetName, atlasRects) {
  const geo = new Geo();
  const preset = PRESETS[presetName];
  const horizon = hexRgb(preset.horizon);
  const top = hexRgb(preset.skyTop);
  const R = 4600;
  // Horizon band: a 24-sided cylinder, y -100..700, flat colour.
  const segs = 24;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = [Math.cos(a0) * R, -100, Math.sin(a0) * R];
    const p1 = [Math.cos(a1) * R, -100, Math.sin(a1) * R];
    const p2 = [Math.cos(a1) * R, 700, Math.sin(a1) * R];
    const p3 = [Math.cos(a0) * R, 700, Math.sin(a0) * R];
    const n = [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)];
    geo.quad(p0, p1, p2, p3, n, horizon, horizon);
  }
  // Sky top: a disc at y = 700, seen from below.
  geo.disc(0, 700, 0, R, top, top, 24, true);
  // Sun disc at the preset sun direction, facing the city.
  const sd = preset.sunPos;
  const sl = Math.hypot(sd[0], sd[1], sd[2]);
  const sun = [sd[0] / sl * 4200, sd[1] / sl * 4200, sd[2] / sl * 4200];
  const sunCol = presetName === 'night' ? [0.9, 0.92, 1.0] : [1.0, 0.9, 0.6];
  geo.discFacing(sun[0], sun[1], sun[2], presetName === 'night' ? 160 : 240, sunCol, sunCol, sun);
  // Stars at night: small quads facing the centre, high up.
  if (presetName === 'night') {
    let v = 987654321;
    const rnd = () => {
      v = (v * 1664525 + 1013904223) >>> 0;
      return v / 4294967296;
    };
    for (let i = 0; i < 260; i++) {
      const a = rnd() * Math.PI * 2;
      const e = 0.25 + rnd() * 1.1;
      const r = 4300;
      const x = Math.cos(a) * Math.cos(e) * r;
      const y = Math.sin(e) * r;
      const z = Math.sin(a) * Math.cos(e) * r;
      const s = 6 + rnd() * 10;
      geo.starQuad(x, y, z, s, [x, y, z], [1, 1, 1]);
    }
  }
  return geo;
}

// --- dynamic geometry: cars + pedestrians (rebuilt on demand) -----------
export function buildDynamicGeometry(city) {
  const geo = new Geo();
  const body = (c, w, h, d, color) => {
    geo.box(c.x, 0, c.z, w, h, d, c.angle, hexRgb(color));
  };
  const all = [...city.cars.parked, ...city.cars.drivable, ...city.cars.traffic];
  for (const c of all) {
    body(c, 4.6, 2.2, 9, c.color);
    geo.box(c.x, 2.2, c.z, 4.0, 1.8, 5.2, c.angle, hexRgb('#1c2733'), [0, 0, 0], 0.25);
    // Headlights (front) and taillights (rear).
    const fx = Math.sin(c.angle), fz = Math.cos(c.angle);
    const px = Math.cos(c.angle), pz = -Math.sin(c.angle);
    for (const side of [-1, 1]) {
      geo.box(c.x + fx * 4.4 + px * side * 1.5, 1.2, c.z + fz * 4.4 + pz * side * 1.5, 0.9, 0.7, 0.3, c.angle, [1, 0.95, 0.8], [0.9, 0.85, 0.6]);
      geo.box(c.x - fx * 4.4 + px * side * 1.5, 1.2, c.z - fz * 4.4 + pz * side * 1.5, 0.9, 0.7, 0.3, c.angle, [1, 0.1, 0.1], [0.7, 0.05, 0.05]);
    }
    if (c.taxi || c.kind === 'drivable') {
      geo.box(c.x, 4.0, c.z, 3.2, 0.9, 1.4, c.angle, hexRgb(c.taxi ? '#f2c230' : '#e8604a'), [0.6, 0.5, 0.1]);
    }
  }
  for (const p of city.pedestrians) {
    geo.box(p.x, 0, p.z, 1.4, 3.2, 1.4, p.angle, hexRgb('#2e3440'));
    geo.box(p.x, 3.2, p.z, 1.5, 2.6, 1.5, p.angle, hexRgb(p.jacket));
    geo.box(p.x, 5.8, p.z, 1.3, 1.3, 1.3, p.angle, hexRgb('#d8a880'));
  }
  return geo;
}

// --- sign atlas (canvas 2D, built once) ----------------------------------
export function buildSignAtlas(city) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 1024, 256);
  const rects = [];
  let x = 0;
  for (const s of city.signs) {
    const w = 256;
    ctx.fillStyle = '#111';
    ctx.fillRect(x, 0, w, 128);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 6;
    ctx.strokeRect(x + 8, 8, w - 16, 112);
    ctx.fillStyle = s.color;
    ctx.font = 'bold 64px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.text, x + w / 2, 68);
    rects.push({ x: x / 1024, y: 0, w: w / 1024, h: 128 / 256, sign: s });
    x += w;
  }
  return { canvas, rects };
}

// --- renderer --------------------------------------------------------------
const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec3 aEmissive;
layout(location=4) in vec2 aUv;
layout(location=5) in float aTex;
layout(location=6) in float aSpec;
uniform mat4 uProj;
uniform mat4 uView;
out vec3 vColor;
out vec3 vEmissive;
out vec3 vNormal;
out vec3 vWorld;
out vec2 vUv;
out float vTex;
out float vSpec;
void main() {
  vColor = aColor;
  vEmissive = aEmissive;
  vNormal = aNormal;
  vWorld = aPos;
  vUv = aUv;
  vTex = aTex;
  vSpec = aSpec;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uCamPos;
uniform float uFlat;
uniform float uEmissiveScale;
uniform sampler2D uAtlas;
in vec3 vColor;
in vec3 vEmissive;
in vec3 vNormal;
in vec3 vWorld;
in vec2 vUv;
in float vTex;
in float vSpec;
out vec4 outColor;
void main() {
  if (uFlat > 0.5) {
    outColor = vec4(vEmissive, 1.0);
    return;
  }
  vec3 base = vTex > 0.5 ? texture(uAtlas, vUv).rgb : vColor;
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, uSunDir), 0.0);
  vec3 col = base * (uAmbient + uSunColor * diff);
  if (vSpec > 0.01) {
    vec3 viewDir = normalize(uCamPos - vWorld);
    vec3 h = normalize(uSunDir + viewDir);
    float s = pow(max(dot(n, h), 0.0), 24.0) * vSpec;
    col += uSunColor * s;
  }
  col += vEmissive * uEmissiveScale;
  float dist = distance(uCamPos, vWorld);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  outColor = vec4(col, 1.0);
}`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function createRenderer(canvas, city) {
  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) throw new Error('WebGL2 is not available in this browser');
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('program link failed: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);
  const uni = {};
  for (const name of ['uProj', 'uView', 'uSunDir', 'uSunColor', 'uAmbient', 'uFogColor', 'uFogDensity', 'uCamPos', 'uFlat', 'uEmissiveScale', 'uAtlas']) {
    uni[name] = gl.getUniformLocation(prog, name);
  }
  gl.uniform1i(uni.uAtlas, 0);

  // Sign atlas texture.
  const atlas = buildSignAtlas(city);
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const stride = 16 * 4;
  const setupAttr = (loc, size, offset) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
  };
  setupAttr(0, 3, 0);
  setupAttr(1, 3, 3);
  setupAttr(2, 3, 6);
  setupAttr(3, 3, 9);
  setupAttr(4, 2, 12);
  setupAttr(5, 1, 14);
  setupAttr(6, 1, 15);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);

  let presetName = 'midday';
  let staticData = null;
  let staticCount = 0;
  let skyData = null;
  let skyCount = 0;
  let dynData = null;
  let dynCount = 0;

  function rebuildStatic() {
    const sg = buildStaticGeometry(city, presetName);
    staticData = sg.toFloat32();
    staticCount = sg.vertexCount;
    const kg = buildSkyGeometry(presetName, atlas.rects);
    skyData = kg.toFloat32();
    skyCount = kg.vertexCount;
  }
  function rebuildDynamic() {
    const dg = buildDynamicGeometry(city);
    dynData = dg.toFloat32();
    dynCount = dg.vertexCount;
  }
  rebuildStatic();
  rebuildDynamic();

  // Sign quads: one textured quad per sign, placed in the static buffer is
  // awkward (the atlas rects are known only here), so they are drawn as a
  // tiny separate draw from a small dedicated buffer.
  const signGeo = new Geo();
  for (const r of atlas.rects) {
    const s = r.sign;
    const c = Math.cos(s.angle), sn = Math.sin(s.angle);
    // Quad facing along the sign angle, centred at (x, y, z).
    const w2 = s.w / 2, h2 = s.h / 2;
    const right = [c, 0, sn];
    const upV = [0, 1, 0];
    const centre = [s.x, s.y, s.z];
    const p = (a, b) => [centre[0] + right[0] * a + upV[0] * b, centre[1] + right[1] * a + upV[1] * b, centre[2] + right[2] * a + upV[2] * b];
    const n = [-sn, 0, c];
    const uv = [[r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w, r.y], [r.x, r.y]];
    signGeo.quad(p(-w2, -h2), p(w2, -h2), p(w2, h2), p(-w2, h2), n, [1, 1, 1], [0.55, 0.55, 0.55], uv, 1, 0);
    // Light pool on the pavement in front of the sign.
    const fx = -sn, fz = c;
    signGeo.disc(s.x + fx * 14, 0.04, s.z + fz * 14, 12, [0.85, 0.7, 0.4], [0.3, 0.24, 0.12], 12);
  }
  const signCount = signGeo.vertexCount;
  const signData = signGeo.toFloat32();

  function drawGeo(data, count) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, count);
  }

  function setPreset(name) {
    if (!PRESETS[name]) return;
    presetName = name;
    rebuildStatic();
  }

  function render(camera, timeMs) {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    const preset = PRESETS[presetName];
    gl.clearColor(preset.fogColor[0], preset.fogColor[1], preset.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const proj = perspective(60, canvas.width / canvas.height, 0.5, 12000);
    const view = lookAt(camera.eye, camera.target, [0, 1, 0]);
    gl.uniformMatrix4fv(uni.uProj, false, proj);
    gl.uniformMatrix4fv(uni.uView, false, view);
    gl.uniform3fv(uni.uSunDir, preset.sunDir);
    gl.uniform3fv(uni.uSunColor, preset.sunColor);
    gl.uniform3fv(uni.uAmbient, preset.ambient);
    gl.uniform3fv(uni.uFogColor, preset.fogColor);
    gl.uniform1f(uni.uFogDensity, preset.fogDensity);
    gl.uniform3fv(uni.uCamPos, camera.eye);
    gl.uniform1f(uni.uEmissiveScale, preset.emissiveScale);
    // Sky first, flat-shaded (no fog, no lighting).
    gl.uniform1f(uni.uFlat, 1);
    gl.depthMask(false);
    drawGeo(skyData, skyCount);
    gl.depthMask(true);
    gl.uniform1f(uni.uFlat, 0);
    drawGeo(staticData, staticCount);
    drawGeo(signData, signCount);
    drawGeo(dynData, dynCount);
    return { staticVerts: staticCount, skyVerts: skyCount, dynVerts: dynCount, signVerts: signCount };
  }

  return {
    gl, setPreset, render, rebuildDynamic,
    get presetName() { return presetName; },
    get vertexCounts() {
      return { staticVerts: staticCount, skyVerts: skyCount, dynVerts: dynCount, signVerts: signCount };
    },
  };
}
