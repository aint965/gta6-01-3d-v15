// city.js — Solmar, the city of Palkon Auto, as data. No DOM, no WebGL:
// buildCity(seed) returns districts, roads, buildings, trees, lamps, boats,
// traffic lights, cars (parked / drivable / traffic), pedestrians and neon
// signs, plus the canal, harbour, beach, park and plaza. Deterministic:
// the same seed builds the same city on every load.
//
// Layout (x east, z south, ground y = 0; city x -1920..1920, z -1728..1728):
// one wide boulevard runs north-south at x = 400 through the centre, a
// main avenue crosses it east-west at z = 0, and their meeting is the
// central plaza with the clock tower and fountain. A canal runs east-west
// at z = 650..730 with three drivable bridges; the harbour sits on the
// east edge, the beach on the south-east edge, the park just south of the
// plaza. Old Solmar, the north-west quarter, is off-grid: its avenue runs
// diagonal and its streets jog, unlike the planned newer districts.

import { mulberry32, pick, range, intRange } from './rng.js';

export const SEED = 20261123;
export const CITY = { x0: -1920, x1: 1920, z0: -1728, z1: 1728 };

export const DISTRICTS = [
  { id: 'old-solmar', name: 'Old Solmar', tagline: 'Old stone lanes by the canal', standing: 55, palette: ['#d8c49a', '#c9a876', '#b98d5f'], brick: '#b0704f', minH: 14, maxH: 34, glass: false },
  { id: 'canal-ward', name: 'Canal Ward', tagline: 'Bridges, boats and morning markets', standing: 48, palette: ['#7fa8a0', '#6b9791', '#8fb5ac'], brick: '#7a6a58', minH: 16, maxH: 40, glass: false },
  { id: 'south-market', name: 'South Market', tagline: 'Spice stalls and shouting traders', standing: 62, palette: ['#d77f69', '#c96a55', '#e08a70'], brick: '#a8543c', minH: 14, maxH: 36, glass: false },
  { id: 'citrus-quarter', name: 'Citrus Quarter', tagline: 'Citrus groves and glass shops', standing: 51, palette: ['#e8c87a', '#dfb45e', '#f0d48a'], brick: '#b08a4a', minH: 16, maxH: 44, glass: false },
  { id: 'pearl-marina', name: 'Pearl Marina', tagline: 'Yachts, gulls and salt air', standing: 58, palette: ['#e8e4d8', '#cfd8dc', '#dfe8ea'], brick: '#8a7f6a', minH: 18, maxH: 52, glass: false },
  { id: 'glasspoint', name: 'Glasspoint', tagline: 'Glass towers over the bay', standing: 44, palette: ['#8fa8b8', '#7a97a8', '#a3b8c4'], brick: '#5f7484', minH: 50, maxH: 130, glass: true },
  { id: 'sunstrand', name: 'Sunstrand Beach', tagline: 'Sand, surf and sunset bars', standing: 66, palette: ['#efe0b8', '#e5d3a0', '#f4e8c4'], brick: '#c2a878', minH: 12, maxH: 28, glass: false },
];

export const CANAL = { z0: 650, z1: 730 };
export const HARBOUR = { x0: 1700, x1: 1920, z0: -600, z1: 650 };
export const BEACH = { x0: 1200, x1: 1920, z0: 1400, z1: 1728 };
export const PARK = { x0: -100, x1: 300, z0: 350, z1: 600 };
export const PLAZA = { x0: 250, x1: 550, z0: -150, z1: 150, cx: 400, cz: 0 };
export const BOULEVARD = { x: 400, w: 64 };
export const AVENUE = { z: 0, w: 64 };

function road(x1, z1, x2, z2, w, kind) {
  return { x1, z1, x2, z2, w, kind };
}

export const ROADS = [
  road(400, -1728, 400, 1728, 64, 'boulevard'),
  road(-1920, 0, 1920, 0, 64, 'avenue'),
  road(-1400, -1728, -1400, 1728, 28, 'secondary'),
  road(-800, -1728, -800, 1728, 28, 'secondary'),
  road(-200, -1728, -200, 1728, 28, 'secondary'),
  road(1000, -1728, 1000, 1728, 28, 'secondary'),
  road(1600, -1728, 1600, 1728, 28, 'secondary'),
  road(-1920, -1200, 1920, -1200, 28, 'secondary'),
  road(-1920, -600, 1920, -600, 28, 'secondary'),
  road(-1920, 300, 1920, 300, 28, 'secondary'),
  road(-1920, 1000, 1920, 1000, 28, 'secondary'),
  road(-1920, 1400, 1920, 1400, 28, 'secondary'),
  // Old Solmar: one diagonal avenue and two jogged streets, off the grid.
  road(-1500, -1500, -150, -450, 28, 'diagonal'),
  road(-1200, -900, -900, -1150, 18, 'diagonal'),
  road(-1000, -1450, -600, -1250, 18, 'diagonal'),
  // Local streets: varied blocks, never identical rectangles in a row.
  road(700, 730, 700, 1728, 18, 'local'),
  road(900, 730, 900, 1728, 18, 'local'),
  road(432, 850, 1200, 850, 18, 'local'),
  road(432, 1150, 1200, 1150, 18, 'local'),
  road(-1700, 730, -1700, 1728, 18, 'local'),
  road(-1100, 730, -1100, 1728, 18, 'local'),
  road(-500, 730, -500, 1728, 18, 'local'),
  road(-1920, 900, 368, 900, 18, 'local'),
  road(-1920, 1200, 368, 1200, 18, 'local'),
  road(-1920, 1550, 368, 1550, 18, 'local'),
  road(800, -1728, 800, -300, 18, 'local'),
  road(1200, -1728, 1200, -300, 18, 'local'),
  road(432, -900, 1920, -900, 18, 'local'),
  road(432, -1500, 1920, -1500, 18, 'local'),
];

// Distance from a point to a road segment (x/z plane).
export function distToRoad(x, z, r) {
  const dx = r.x2 - r.x1;
  const dz = r.z2 - r.z1;
  const len2 = dx * dx + dz * dz;
  let t = len2 === 0 ? 0 : ((x - r.x1) * dx + (z - r.z1) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = r.x1 + dx * t;
  const pz = r.z1 + dz * t;
  return Math.hypot(x - px, z - pz);
}

export function inRect(x, z, r, margin = 0) {
  return x >= r.x0 - margin && x <= r.x1 + margin && z >= r.z0 - margin && z <= r.z1 + margin;
}

export function inCanal(x, z, margin = 0) {
  return z >= CANAL.z0 - margin && z <= CANAL.z1 + margin;
}

// Which district a ground point belongs to (for the HUD district line).
export function districtAt(x, z) {
  if (inRect(x, z, PLAZA)) {
    if (z < 0) return x < 400 ? DISTRICTS[0] : DISTRICTS[5];
    return x < 400 ? DISTRICTS[1] : DISTRICTS[4];
  }
  if (inCanal(x, z)) return x < 400 ? DISTRICTS[1] : DISTRICTS[4];
  if (inRect(x, z, HARBOUR)) return DISTRICTS[4];
  if (inRect(x, z, BEACH)) return DISTRICTS[6];
  if (x < 368) {
    if (z < -300) return DISTRICTS[0];
    if (z < 650) return DISTRICTS[1];
    return DISTRICTS[2];
  }
  if (x > 432) {
    if (z < -300) return DISTRICTS[5];
    if (z < 650) return DISTRICTS[4];
    if (x > 1200) return DISTRICTS[6];
    return DISTRICTS[3];
  }
  // On the boulevard itself: take the side the camera leans to.
  if (z < -300) return DISTRICTS[0];
  if (z < 650) return DISTRICTS[1];
  return DISTRICTS[2];
}

const CAR_COLORS = ['#c94f3d', '#3d6ec9', '#3d9e6e', '#d8d8d8', '#2e3440', '#e8b13d', '#7a4a9e', '#c97a3d'];
const JACKET_COLORS = ['#e84a3d', '#f2c230', '#3d9e6e', '#3d6ec9', '#e87ab0', '#f28c28', '#7a4a9e', '#e8e4d8'];

export function buildCity(seed = SEED) {
  const rng = mulberry32(seed);
  const buildings = [];
  const trees = [];
  const lamps = [];
  const boats = [];
  const trafficLights = [];
  const pedestrians = [];
  const signs = [];
  const parked = [];
  const drivable = [];
  const traffic = [];

  // --- Buildings: jittered lots on a coarse grid, skipped when they would
  // touch a road, the canal, harbour, beach, park or plaza, or another
  // building. Old Solmar lots are rotated 15 degrees, off the grid.
  const placed = [];
  for (let gx = CITY.x0 + 60; gx < CITY.x1 - 40; gx += 100) {
    for (let gz = CITY.z0 + 60; gz < CITY.z1 - 40; gz += 90) {
      const cx = gx + range(rng, -28, 28);
      const cz = gz + range(rng, -24, 24);
      const d = districtAt(cx, cz);
      const w = range(rng, 26, 64);
      const dep = range(rng, 22, 52);
      const r = 0.5 * Math.hypot(w, dep) + 8;
      if (cx < CITY.x0 + 30 || cx > CITY.x1 - 30 || cz < CITY.z0 + 30 || cz > CITY.z1 - 30) continue;
      const angle0 = d.id === 'old-solmar' ? 0.26 + range(rng, -0.05, 0.05) : 0;
      // Test the rotated corners, not just the centre: a lot whose centre
      // clears a road can still have a corner in it. Margins are one step
      // wider than the verifier's, so a lot that passes here passes there.
      const cc = Math.cos(angle0), ss = Math.sin(angle0);
      const corners = [[-w / 2, -dep / 2], [w / 2, -dep / 2], [w / 2, dep / 2], [-w / 2, dep / 2]]
        .map(([x, z]) => [cx + x * cc - z * ss, cz + x * ss + z * cc]);
      corners.push([cx, cz]);
      let blocked = false;
      for (const [x, z] of corners) {
        if (inRect(x, z, PLAZA, 10) || inRect(x, z, PARK, 8) || inRect(x, z, HARBOUR, 8) || inRect(x, z, BEACH, 8) || inCanal(x, z, 10)) { blocked = true; break; }
        for (const rd of ROADS) {
          if (distToRoad(x, z, rd) < rd.w / 2 + 6) { blocked = true; break; }
        }
        if (blocked) break;
      }
      if (blocked) continue;
      for (const p of placed) {
        const dx = cx - p.x;
        const dz = cz - p.z;
        if (dx * dx + dz * dz < (r + p.r) * (r + p.r)) { blocked = true; break; }
      }
      if (blocked) continue;
      let h = range(rng, d.minH, d.maxH);
      const distCentre = Math.hypot(cx - 400, cz - 0);
      if (Math.abs(cx - 400) < 160) h *= 1.35; // tallest along the boulevard
      if (distCentre > 1250) h *= 0.72; // height falls away to the edges
      h = Math.min(h, 132);
      const glass = d.glass ? rng() < 0.85 : (d.id === 'pearl-marina' ? rng() < 0.25 : false);
      const angle = angle0;
      buildings.push({ x: cx, z: cz, w, d: dep, h, angle, district: d.id, wall: pick(rng, d.palette), brick: d.brick, glass });
      placed.push({ x: cx, z: cz, r });
    }
  }

  // --- Trees: park cluster, boulevard rows, canal promenade, beach palms.
  // Every tree is checked against ALL roads, not just the one it was
  // placed next to: a tree beside the boulevard can still sit on a cross
  // street near an intersection.
  const clearOfRoads = (x, z) => !ROADS.some((rd) => distToRoad(x, z, rd) < rd.w / 2 + 3);
  for (let i = 0; i < 46; i++) {
    const t = { x: range(rng, PARK.x0 + 12, PARK.x1 - 12), z: range(rng, PARK.z0 + 12, PARK.z1 - 12), s: range(rng, 0.8, 1.3), palm: false };
    if (clearOfRoads(t.x, t.z)) trees.push(t);
  }
  for (let z = -1600; z <= 1600; z += 95) {
    const t1 = { x: 400 - 44 + range(rng, -3, 3), z: z + range(rng, -8, 8), s: range(rng, 0.9, 1.2), palm: false };
    const t2 = { x: 400 + 44 + range(rng, -3, 3), z: z + 46 + range(rng, -8, 8), s: range(rng, 0.9, 1.2), palm: false };
    if (clearOfRoads(t1.x, t1.z)) trees.push(t1);
    if (clearOfRoads(t2.x, t2.z)) trees.push(t2);
  }
  for (let x = -1800; x <= 1800; x += 70) {
    if (Math.abs(x - 400) < 60) continue; // bridge gap
    const t = { x: x + range(rng, -6, 6), z: CANAL.z0 - 14 + range(rng, -3, 3), s: range(rng, 0.85, 1.15), palm: false };
    if (clearOfRoads(t.x, t.z)) trees.push(t);
  }
  for (let i = 0; i < 16; i++) {
    const t = { x: range(rng, 1250, 1880), z: range(rng, 1420, 1500), s: range(rng, 1.0, 1.4), palm: true };
    if (clearOfRoads(t.x, t.z)) trees.push(t);
  }
  for (let i = 0; i < 70; i++) {
    const rd = pick(rng, ROADS.filter((r) => r.kind === 'secondary' || r.kind === 'local'));
    const t = rng();
    const x = rd.x1 + (rd.x2 - rd.x1) * t;
    const z = rd.z1 + (rd.z2 - rd.z1) * t;
    const nx = -(rd.z2 - rd.z1);
    const nz = rd.x2 - rd.x1;
    const len = Math.hypot(nx, nz) || 1;
    const side = rng() < 0.5 ? -1 : 1;
    const tx = x + (nx / len) * side * (rd.w / 2 + 7);
    const tz = z + (nz / len) * side * (rd.w / 2 + 7);
    if (inCanal(tx, tz, 4) || inRect(tx, tz, PLAZA, 4) || inRect(tx, tz, PARK, 4)) continue;
    if (!clearOfRoads(tx, tz)) continue;
    trees.push({ x: tx, z: tz, s: range(rng, 0.8, 1.2), palm: false });
  }

  // --- Lamps: boulevard rows, cross avenue, canal promenade, plaza ring.
  for (let z = -1680; z <= 1680; z += 120) {
    lamps.push({ x: 400 - 36, z, h: 11 });
    lamps.push({ x: 400 + 36, z: z + 60, h: 11 });
  }
  for (let x = -1860; x <= 1860; x += 140) {
    lamps.push({ x, z: -40, h: 10 });
  }
  for (let x = -1800; x <= 1800; x += 110) {
    if (Math.abs(x - 400) < 60) continue;
    lamps.push({ x, z: CANAL.z0 - 8, h: 10 });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    lamps.push({ x: 400 + Math.cos(a) * 150, z: Math.sin(a) * 150, h: 10 });
  }

  // --- Boats: three in the harbour, two on the canal.
  boats.push({ x: 1780, z: -380, angle: 0.4, s: 1.4 });
  boats.push({ x: 1830, z: -40, angle: -0.3, s: 1.1 });
  boats.push({ x: 1770, z: 330, angle: 1.2, s: 1.6 });
  boats.push({ x: -1000, z: 690, angle: 0, s: 0.9 });
  boats.push({ x: 800, z: 690, angle: 0.1, s: 0.9 });

  // --- Traffic lights at the main intersections (timing is a later stage).
  const lightSpots = [
    [400, -1200], [400, -600], [400, 0], [400, 300], [400, 1000], [400, 1400],
    [-1400, 0], [-800, 0], [-200, 0], [1000, 0], [1600, 0],
    [-800, 690], [1200, 690],
  ];
  for (const [x, z] of lightSpots) trafficLights.push({ x, z });

  // --- Cars. Parked along road edges; drivable ones stand out (coral paint
  // + roof sign) on the plaza stone and the boulevard; traffic cars run
  // the roads, three of them yellow taxis.
  function carOnRoad(rd, side, t) {
    const x = rd.x1 + (rd.x2 - rd.x1) * t;
    const z = rd.z1 + (rd.z2 - rd.z1) * t;
    const nx = -(rd.z2 - rd.z1);
    const nz = rd.x2 - rd.x1;
    const len = Math.hypot(nx, nz) || 1;
    const angle = Math.atan2(rd.x2 - rd.x1, rd.z2 - rd.z1);
    return { x: x + (nx / len) * side * (rd.w / 2 - 5), z: z + (nz / len) * side * (rd.w / 2 - 5), angle };
  }
  const roadPool = ROADS.filter((r) => r.kind !== 'diagonal');
  for (let i = 0; i < 54; i++) {
    const rd = pick(rng, roadPool);
    const c = carOnRoad(rd, rng() < 0.5 ? -1 : 1, rng());
    if (inCanal(c.x, c.z, 6) || inRect(c.x, c.z, PLAZA, 6)) continue;
    parked.push({ ...c, color: pick(rng, CAR_COLORS), kind: 'parked', taxi: false });
  }
  const driveSpots = [
    { x: 330, z: 60, angle: 0.2 }, { x: 470, z: -70, angle: -0.4 },
    { x: 300, z: -100, angle: 0.9 }, { x: 500, z: 110, angle: 2.6 },
    { x: 400, z: -500, angle: 0 }, { x: 400, z: 500, angle: 0 },
    { x: 400, z: -1100, angle: 0 }, { x: 400, z: 1100, angle: 0 },
  ];
  for (const s of driveSpots) drivable.push({ ...s, color: '#e8604a', kind: 'drivable', taxi: false });
  for (let i = 0; i < 40; i++) {
    const rd = pick(rng, roadPool);
    const c = carOnRoad(rd, rng() < 0.5 ? -1 : 1, rng());
    if (inCanal(c.x, c.z, 6) || inRect(c.x, c.z, PLAZA, 6)) continue;
    traffic.push({ ...c, color: i < 3 ? '#f2c230' : pick(rng, CAR_COLORS), kind: 'traffic', taxi: i < 3 });
  }

  // --- Pedestrians on sidewalks, the plaza and the park, bright jackets.
  for (let i = 0; i < 40; i++) {
    let x, z;
    if (i < 12) {
      x = range(rng, PLAZA.x0 + 20, PLAZA.x1 - 20);
      z = range(rng, PLAZA.z0 + 20, PLAZA.z1 - 20);
    } else if (i < 18) {
      x = range(rng, PARK.x0 + 10, PARK.x1 - 10);
      z = range(rng, PARK.z0 + 10, PARK.z1 - 10);
    } else {
      const rd = pick(rng, roadPool);
      const t = rng();
      const px = rd.x1 + (rd.x2 - rd.x1) * t;
      const pz = rd.z1 + (rd.z2 - rd.z1) * t;
      const nx = -(rd.z2 - rd.z1);
      const nz = rd.x2 - rd.x1;
      const len = Math.hypot(nx, nz) || 1;
      const side = rng() < 0.5 ? -1 : 1;
      x = px + (nx / len) * side * (rd.w / 2 + 5);
      z = pz + (nz / len) * side * (rd.w / 2 + 5);
    }
    if (inCanal(x, z, 4) || inRect(x, z, HARBOUR, 4)) continue;
    pedestrians.push({ x, z, angle: range(rng, 0, Math.PI * 2), jacket: pick(rng, JACKET_COLORS) });
  }

  // --- Neon signs on landmark spots, each with a light pool on the pavement.
  signs.push({ text: 'SOLMAR', x: 470, z: -120, y: 42, angle: Math.PI, color: '#ff5f7a', w: 64, h: 14 });
  signs.push({ text: 'PALKO', x: 900, z: -820, y: 55, angle: Math.PI / 2, color: '#ffd23d', w: 48, h: 12 });
  signs.push({ text: 'MARINA', x: 1500, z: 180, y: 34, angle: -Math.PI / 2, color: '#4dd8e8', w: 56, h: 12 });
  signs.push({ text: 'BEACH', x: 1500, z: 1240, y: 26, angle: 0, color: '#ff9a3d', w: 44, h: 11 });

  return {
    seed, districts: DISTRICTS, roads: ROADS, buildings, trees, lamps, boats,
    trafficLights, cars: { parked, drivable, traffic }, pedestrians, signs,
    canal: CANAL, harbour: HARBOUR, beach: BEACH, park: PARK, plaza: PLAZA,
    boulevard: BOULEVARD, avenue: AVENUE,
  };
}
