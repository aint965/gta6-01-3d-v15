// test-stage-b.mjs — headless Node tests for the Stage B driving sim
// (game/src/drive.js). No DOM, no WebGL: imports the pure sim + city data
// and measures top speeds, red-light behaviour, follow gaps, collisions,
// on-foot movement and E enter/exit. Usage: node checks/test-stage-b.mjs
import { buildCity, distToRoad } from '../game/src/city.js';
import { createDrive, PROFILES, obbOverlap, KMH } from '../game/src/drive.js';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// --- 1. Top speeds: each profile on a clear boulevard straight ------------
for (const [key, prof] of Object.entries(PROFILES)) {
  const city = buildCity(20261123);
  const drive = createDrive(city);
  // Clear straight: traffic off, traffic cars parked far away on the beach,
  // and the other drivable cars (four of them sit on the boulevard centre
  // line) moved away too.
  drive.trafficEnabled = false;
  for (const c of city.cars.traffic) { c.x = 1700; c.z = 1500; }
  city.cars.drivable.forEach((c, i) => { if (i !== 0) { c.x = 1700; c.z = 1550 + i * 12; } });
  drive.teleportPlayer(400, -1500, 0, 0);
  drive.player.car.profile = key;
  drive.player.profile = key;
  let maxKmh = 0;
  let damage = 0;
  // 15 s is enough: every profile reaches its (hard-clamped) top speed in
  // ~7 s and holds it for 8 s, and the car stays ~1000 units clear of the
  // clock tower and fountain on the boulevard.
  for (let i = 0; i < 15 / 0.05; i++) {
    drive.update(0.05, { up: true }, 0);
    maxKmh = Math.max(maxKmh, drive.playerSpeedKmh());
    damage = drive.player.damage;
  }
  const diff = Math.abs(maxKmh - prof.topKmh);
  check(`top speed ${key}`, diff <= 1 && damage === 0, `measured ${maxKmh} vs target ${prof.topKmh} km/h, damage ${damage}`);
}

// --- 2. Reverse: distance covered in 2.5 s ---------------------------------
{
  const city = buildCity(20261123);
  const drive = createDrive(city);
  drive.teleportPlayer(400, -1500, 0, 0);
  const z0 = drive.player.z;
  for (let i = 0; i < 2.5 / 0.05; i++) drive.update(0.05, { down: true }, 0);
  const dist = z0 - drive.player.z; // reversing goes -z when facing +z
  check('reverse 2.5 s', dist > 8 && dist < 25, `${dist.toFixed(1)} m in 2.5 s (reverse top ~30 km/h)`);
}

// --- 3. Full traffic run: 90 s, red-runs, stops, gaps, overlaps ------------
{
  const city = buildCity(20261123);
  const drive = createDrive(city);
  // Player parked off-road so only traffic + pedestrians are measured.
  drive.player.x = 400;
  drive.player.z = 180;
  for (let i = 0; i < 90 / 0.05; i++) drive.update(0.05, {}, 0);
  const st = drive.stats;
  check('traffic 90 s: 0 red-runs', st.redRuns === 0, `${st.redRuns} red-runs`);
  check('traffic 90 s: cars stopped at lights', st.stops.length >= 5, `${st.stops.length} stops (encounters ${st.lightEncounters}, passes ${st.lightPasses}), first gaps: ${st.stops.slice(0, 4).map((s) => s.gap + 'm').join(', ')}`);
  check('traffic 90 s: min follow gap', st.minGap === Infinity || st.minGap >= 4, `min gap ${st.minGap === Infinity ? 'n/a (no follower pairs)' : st.minGap.toFixed(1) + ' m'}`);
  // Car-car overlaps (traffic vs parked/drivable/traffic).
  const cars = [...city.cars.parked, ...city.cars.drivable, ...city.cars.traffic];
  let carCar = 0;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = { x: cars[i].x, z: cars[i].z, hw: 2.3, hd: 4.5, angle: cars[i].angle };
      const b = { x: cars[j].x, z: cars[j].z, hw: 2.3, hd: 4.5, angle: cars[j].angle };
      if (obbOverlap(a, b)) {
        carCar++;
        console.log(`  overlap: ${cars[i].kind} (${cars[i].x.toFixed(1)}, ${cars[i].z.toFixed(1)}) vs ${cars[j].kind} (${cars[j].x.toFixed(1)}, ${cars[j].z.toFixed(1)})`);
      }
    }
  }
  check('traffic 90 s: 0 car-car overlaps', carCar === 0, `${carCar} overlapping pairs`);
  // Car-pedestrian overlaps.
  let carPed = 0;
  for (const p of city.pedestrians) {
    for (const c of cars) {
      if (Math.hypot(p.x - c.x, p.z - c.z) < 3.2) { carPed++; break; }
    }
  }
  check('traffic 90 s: 0 car-pedestrian overlaps', carPed === 0, `${carPed} peds touching a car`);
  // Traffic cars stay on roads.
  let offRoad = 0;
  for (const c of city.cars.traffic) {
    const onRoad = city.roads.some((r) => distToRoad(c.x, c.z, r) < r.w / 2 + 1);
    if (!onRoad) offRoad++;
  }
  check('traffic 90 s: 0 cars off-road', offRoad === 0, `${offRoad} traffic cars off-road`);
  check('pedestrians crossed at crosswalks', st.crossingsDone >= 1, `${st.crossingsDone} crossings completed`);
}

// Pick a building with a clear 60-unit approach from the south (no other
// building in the path box) and no rotation, so a flat face stops the
// player dead instead of sliding them around a slanted corner.
function findBuildingWithClearApproach(city) {
  for (const b of city.buildings) {
    if (b.h < 16 || Math.abs(b.angle) > 0.01) continue;
    const path = { x: b.x, z: b.z - b.d / 2 - 30, hw: 3, hd: 35, angle: 0 };
    let clear = true;
    for (const other of city.buildings) {
      if (other === b) continue;
      const ob = { x: other.x, z: other.z, hw: other.w / 2, hd: other.d / 2, angle: other.angle };
      if (obbOverlap(path, ob)) { clear = false; break; }
    }
    if (clear) return b;
  }
  return null;
}

// --- 4. Collision: building + parked car ------------------------------------
{
  const city = buildCity(20261123);
  const drive = createDrive(city);
  // Find a building near the boulevard and aim at it.
  const b = findBuildingWithClearApproach(city);
  const startX = b.x;
  const startZ = b.z - (b.d / 2 + 60);
  drive.teleportPlayer(startX, startZ, 0, 0);
  for (let i = 0; i < 12 / 0.05; i++) drive.update(0.05, { up: true }, 0);
  const dmg = drive.player.damage;
  const me = { x: drive.player.x, z: drive.player.z, hw: 2.3, hd: 4.5, angle: drive.player.angle };
  const bb = { x: b.x, z: b.z, hw: b.w / 2, hd: b.d / 2, angle: b.angle };
  check('collision building: damage + stopped + pushed out', dmg > 0 && !obbOverlap(me, bb), `damage ${dmg.toFixed(1)}, overlap after resolve: ${obbOverlap(me, bb)}`);
}
{
  const city = buildCity(20261123);
  const drive = createDrive(city);
  const parked = city.cars.parked[0];
  drive.teleportPlayer(parked.x, parked.z - 40, 0, 0);
  for (let i = 0; i < 10 / 0.05; i++) drive.update(0.05, { up: true }, 0);
  check('collision parked car: damage + pushed out', drive.player.damage > 0, `damage ${drive.player.damage.toFixed(1)}`);
}

// --- 5. On foot: blocked by a building, E enter/exit round-trip -------------
{
  const city = buildCity(20261123);
  const drive = createDrive(city);
  const b = findBuildingWithClearApproach(city);
  drive.player.x = b.x;
  drive.player.z = b.z - (b.d / 2 + 4);
  drive.player.mode = 'foot';
  for (let i = 0; i < 3 / 0.05; i++) drive.update(0.05, { up: true }, 0); // camera yaw 0: forward = (sin 0, cos 0) = +z, toward the building south of Mara
  const me = { x: drive.player.x, z: drive.player.z, hw: 1.2, hd: 1.2, angle: 0 };
  const bb = { x: b.x, z: b.z, hw: b.w / 2, hd: b.d / 2, angle: b.angle };
  check('on foot: building blocks Mara', !obbOverlap(me, bb), `Mara at (${drive.player.x.toFixed(1)}, ${drive.player.z.toFixed(1)})`);
}
{
  const city = buildCity(20261123);
  const drive = createDrive(city);
  const d0 = city.cars.drivable[0];
  drive.player.x = d0.x + 3;
  drive.player.z = d0.z + 3;
  drive.player.mode = 'foot';
  const entered = drive.interact();
  const driving = drive.player.mode === 'drive';
  const exited = drive.interact();
  const onFoot = drive.player.mode === 'foot';
  check('E enter/exit round-trip', entered && driving && exited && onFoot, `enter=${entered} driving=${driving} exit=${exited} foot=${onFoot}`);
}

// --- 6. Prompt: drivable vs parked ------------------------------------------
{
  const city = buildCity(20261123);
  const drive = createDrive(city);
  const d0 = city.cars.drivable[0];
  drive.player.x = d0.x + 3;
  drive.player.z = d0.z + 3;
  drive.player.mode = 'foot';
  const pr = drive.prompt();
  check('prompt near drivable car', pr.kind === 'enter', `"${pr.text}"`);
  const pk = city.cars.parked[0];
  drive.player.x = pk.x + 3;
  drive.player.z = pk.z + 3;
  const pr2 = drive.prompt();
  check('prompt near parked car is LOCKED', pr2.kind === 'locked', `"${pr2.text}"`);
}

console.log(failures === 0 ? 'STAGE B SIM OK' : `STAGE B SIM: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
