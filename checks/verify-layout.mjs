// verify-layout.mjs — checks the Solmar layout before any screenshot is
// taken: every building inside the city, off every road, out of the canal,
// harbour, beach, park and plaza, and not overlapping another building;
// every car on a road or the plaza; every pedestrian on a sidewalk, the
// plaza or the park; every lamp near a road, the plaza or the promenade;
// every tree off the roads. Prints counts and exits 1 on any problem.
import { buildCity, distToRoad, inRect, inCanal, CITY } from '../game/src/city.js';

const city = buildCity();
const problems = [];
const counts = { buildings: 0, trees: 0, lamps: 0, boats: 0, lights: 0, parked: 0, drivable: 0, traffic: 0, pedestrians: 0, signs: 0 };

function checkBuilding(b) {
  const r = 0.5 * Math.hypot(b.w, b.d) + 6;
  const corners = [[-b.w / 2, -b.d / 2], [b.w / 2, -b.d / 2], [b.w / 2, b.d / 2], [-b.w / 2, b.d / 2]];
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const pts = corners.map(([x, z]) => [b.x + x * c - z * s, b.z + x * s + z * c]);
  pts.push([b.x, b.z]);
  for (const [x, z] of pts) {
    if (x < CITY.x0 || x > CITY.x1 || z < CITY.z0 || z > CITY.z1) return `outside city bounds (${x.toFixed(0)}, ${z.toFixed(0)})`;
    if (inRect(x, z, city.plaza, 8)) return 'inside plaza';
    if (inRect(x, z, city.park, 6)) return 'inside park';
    if (inRect(x, z, city.harbour, 6)) return 'inside harbour';
    if (inRect(x, z, city.beach, 6)) return 'inside beach';
    if (inCanal(x, z, 8)) return 'inside canal';
    for (const rd of city.roads) {
      if (distToRoad(x, z, rd) < rd.w / 2 + 4) return `on road ${rd.kind} (${rd.x1},${rd.z1})-(${rd.x2},${rd.z2})`;
    }
  }
  return null;
}

const placed = [];
for (const b of city.buildings) {
  counts.buildings++;
  const p = checkBuilding(b);
  if (p) problems.push(`building at (${b.x.toFixed(0)}, ${b.z.toFixed(0)}) ${b.district}: ${p}`);
  const r = 0.5 * Math.hypot(b.w, b.d) + 6;
  for (const q of placed) {
    const dx = b.x - q.x, dz = b.z - q.z;
    if (dx * dx + dz * dz < (r + q.r) * (r + q.r)) {
      problems.push(`buildings overlap at (${b.x.toFixed(0)}, ${b.z.toFixed(0)}) and (${q.x.toFixed(0)}, ${q.z.toFixed(0)})`);
    }
  }
  placed.push({ x: b.x, z: b.z, r });
}

function nearRoad(x, z, maxDist) {
  return city.roads.some((rd) => distToRoad(x, z, rd) <= rd.w / 2 + maxDist);
}

for (const t of city.trees) {
  counts.trees++;
  for (const rd of city.roads) {
    if (distToRoad(t.x, t.z, rd) < rd.w / 2 + 1) problems.push(`tree at (${t.x.toFixed(0)}, ${t.z.toFixed(0)}) on road ${rd.kind}`);
  }
}
for (const l of city.lamps) {
  counts.lamps++;
  if (!nearRoad(l.x, l.z, 12) && !inRect(l.x, l.z, city.plaza, 20) && !inCanal(l.x, l.z, 30)) {
    problems.push(`lamp at (${l.x.toFixed(0)}, ${l.z.toFixed(0)}) far from any road/plaza/canal`);
  }
}
for (const b of city.boats) {
  counts.boats++;
  if (!inCanal(b.x, b.z, 20) && !inRect(b.x, b.z, city.harbour, 10)) {
    problems.push(`boat at (${b.x.toFixed(0)}, ${b.z.toFixed(0)}) not on water`);
  }
}
counts.lights = city.trafficLights.length;
counts.signs = city.signs.length;

function checkCar(c, label) {
  if (inRect(c.x, c.z, city.plaza, 4)) return null;
  if (nearRoad(c.x, c.z, 10)) return null;
  return `${label} car at (${c.x.toFixed(0)}, ${c.z.toFixed(0)}) off road and plaza`;
}
for (const c of city.cars.parked) { counts.parked++; const p = checkCar(c, 'parked'); if (p) problems.push(p); }
for (const c of city.cars.drivable) { counts.drivable++; const p = checkCar(c, 'drivable'); if (p) problems.push(p); }
for (const c of city.cars.traffic) { counts.traffic++; const p = checkCar(c, 'traffic'); if (p) problems.push(p); }
for (const p of city.pedestrians) {
  counts.pedestrians++;
  if (inRect(p.x, p.z, city.plaza, 4) || inRect(p.x, p.z, city.park, 4)) continue;
  if (nearRoad(p.x, p.z, 10)) continue;
  problems.push(`pedestrian at (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) off sidewalk/plaza/park`);
}

console.log('layout counts:', JSON.stringify(counts));
console.log('layout problems:', problems.length);
for (const p of problems.slice(0, 40)) console.log('  -', p);
if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);
process.exit(problems.length === 0 ? 0 : 1);
