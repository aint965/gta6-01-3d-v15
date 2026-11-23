// drive.js — Palkon Auto Stage B: pure driving / traffic / collision sim.
// No DOM, no WebGL: importable from Node for headless tests and from
// main.js for the live game. Units are metres: speeds in units/s inside,
// km/h at the API boundary (1 km/h = 1/3.6 units/s). A car's forward is
// (sin(angle), cos(angle)), matching the renderer's car boxes and the
// city's carOnRoad angles.

import { ROADS } from './city.js';
import { mulberry32 } from './rng.js';

export const KMH = 1 / 3.6;
export const LIGHT_CYCLE = 26; // seconds: NS green 11, NS yellow 2, EW green 11, EW yellow 2

export const PROFILES = {
  compact: { name: 'COMPACT', topKmh: 115, accel: 4.6, brake: 14, reverseKmh: 30, steer: 2.1 },
  sedan: { name: 'SEDAN', topKmh: 130, accel: 5.2, brake: 14, reverseKmh: 30, steer: 2.0 },
  van: { name: 'VAN', topKmh: 108, accel: 4.2, brake: 13, reverseKmh: 28, steer: 1.8 },
  coupe: { name: 'COUPE', topKmh: 158, accel: 6.3, brake: 15, reverseKmh: 32, steer: 2.3 },
};
const PROFILE_ORDER = ['sedan', 'compact', 'coupe', 'van'];

// --- traffic lights -------------------------------------------------------
// phase p in [0, 26): NS green [0,11), NS yellow [11,13), EW green [13,24),
// EW yellow [24,26). Each light has its own offset so the city is staggered.
export function lightPhase(t, offset) {
  const p = (((t + offset) % LIGHT_CYCLE) + LIGHT_CYCLE) % LIGHT_CYCLE;
  if (p < 11) return { ns: 'green', ew: 'red' };
  if (p < 13) return { ns: 'yellow', ew: 'red' };
  if (p < 24) return { ns: 'red', ew: 'green' };
  return { ns: 'red', ew: 'yellow' };
}
export function signalFor(light, vertical, t) {
  const ph = lightPhase(t, light.offset);
  return vertical ? ph.ns : ph.ew;
}
// Seconds until the signal stops being green (0 when already yellow/red).
export function timeUntilNotGreen(light, vertical, t) {
  const p = (((t + light.offset) % LIGHT_CYCLE) + LIGHT_CYCLE) % LIGHT_CYCLE;
  if (vertical) return p < 11 ? 11 - p : 0;
  return p >= 13 && p < 24 ? 24 - p : 0;
}

// --- 2D oriented boxes (SAT) ----------------------------------------------
// A box is {x, z, hw, hd, angle}: half-width, half-depth, rotation.
export function obbCorners(b) {
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const out = [];
  for (const [lx, lz] of [[-b.hw, -b.hd], [b.hw, -b.hd], [b.hw, b.hd], [-b.hw, b.hd]]) {
    out.push([b.x + lx * c - lz * s, b.z + lx * s + lz * c]);
  }
  return out;
}
function project(corners, ax, az) {
  let lo = Infinity, hi = -Infinity;
  for (const [x, z] of corners) {
    const d = x * ax + z * az;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}
// Returns the minimum translation vector [mx, mz] to push a out of b,
// or null when the boxes do not overlap.
export function obbMtv(a, b) {
  const ca = obbCorners(a), cb = obbCorners(b);
  const axes = [];
  for (const ang of [a.angle, b.angle]) {
    axes.push([Math.cos(ang), Math.sin(ang)]);
    axes.push([-Math.sin(ang), Math.cos(ang)]);
  }
  let best = null;
  let bestOverlap = Infinity;
  for (const [ax, az] of axes) {
    const [loA, hiA] = project(ca, ax, az);
    const [loB, hiB] = project(cb, ax, az);
    const overlap = Math.min(hiA, hiB) - Math.max(loA, loB);
    if (overlap <= 0) return null;
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      // Push a away from b along this axis.
      const centreA = (loA + hiA) / 2;
      const centreB = (loB + hiB) / 2;
      const sign = centreA < centreB ? -1 : 1;
      best = [ax * sign * overlap, az * sign * overlap];
    }
  }
  return best;
}
export function obbOverlap(a, b) {
  return obbMtv(a, b) !== null;
}
// Circle (x, z, r) vs box: push the circle out, return the push or null.
export function circleObbPush(x, z, r, b) {
  const c = Math.cos(-b.angle), s = Math.sin(-b.angle);
  const dx = x - b.x, dz = z - b.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const qx = Math.max(-b.hw, Math.min(b.hw, lx));
  const qz = Math.max(-b.hd, Math.min(b.hd, lz));
  let ddx = lx - qx, ddz = lz - qz;
  const d2 = ddx * ddx + ddz * ddz;
  if (d2 >= r * r) return null;
  if (d2 < 1e-9) {
    // Centre is inside the box: push out along the smallest penetration.
    const px = b.hw - Math.abs(lx);
    const pz = b.hd - Math.abs(lz);
    if (px < pz) ddx = (lx >= 0 ? px + r : -(px + r));
    else ddz = (lz >= 0 ? pz + r : -(pz + r));
  } else {
    const d = Math.sqrt(d2);
    const push = r - d;
    ddx = (ddx / d) * push;
    ddz = (ddz / d) * push;
  }
  const wc = Math.cos(b.angle), ws = Math.sin(b.angle);
  return [ddx * wc - ddz * ws, ddx * ws + ddz * wc];
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// --- road graph (axis-aligned roads only) ---------------------------------
function buildGraph(roads, lights) {
  const axis = roads.filter((r) => r.x1 === r.x2 || r.z1 === r.z2);
  const nodes = [];
  const nodeAt = new Map();
  const key = (x, z) => `${Math.round(x)},${Math.round(z)}`;
  function addNode(x, z) {
    const k = key(x, z);
    if (!nodeAt.has(k)) {
      nodeAt.set(k, nodes.length);
      nodes.push({ x, z, edges: [], light: null });
    }
    return nodeAt.get(k);
  }
  for (const r of axis) {
    addNode(r.x1, r.z1);
    addNode(r.x2, r.z2);
  }
  for (let i = 0; i < axis.length; i++) {
    for (let j = i + 1; j < axis.length; j++) {
      const a = axis[i], b = axis[j];
      const aVert = a.x1 === a.x2, bVert = b.x1 === b.x2;
      if (aVert === bVert) continue;
      const v = aVert ? a : b, h = aVert ? b : a;
      const x = v.x1, z = h.z1;
      if (x >= Math.min(h.x1, h.x2) && x <= Math.max(h.x1, h.x2)
        && z >= Math.min(v.z1, v.z2) && z <= Math.max(v.z1, v.z2)) addNode(x, z);
    }
  }
  // Traffic lights sit on intersections (and on the two canal bridges):
  // make each one a node so edges split there and cars can stop at it.
  for (const l of lights) addNode(l.x, l.z);
  const edges = [];
  for (const r of axis) {
    const on = nodes.filter((n) => {
      if (r.x1 === r.x2) return n.x === r.x1 && n.z >= Math.min(r.z1, r.z2) && n.z <= Math.max(r.z1, r.z2);
      return n.z === r.z1 && n.x >= Math.min(r.x1, r.x2) && n.x <= Math.max(r.x1, r.x2);
    });
    on.sort((a, b) => (r.x1 === r.x2 ? a.z - b.z : a.x - b.x));
    for (let i = 0; i + 1 < on.length; i++) {
      const A = on[i], B = on[i + 1];
      const len = Math.hypot(B.x - A.x, B.z - A.z);
      if (len < 1) continue;
      const e = {
        a: nodes.indexOf(A), b: nodes.indexOf(B), road: r, len,
        vertical: r.x1 === r.x2, w: r.w,
      };
      edges.push(e);
      nodes[e.a].edges.push(edges.length - 1);
      nodes[e.b].edges.push(edges.length - 1);
    }
  }
  // Attach each light to its node.
  for (const l of lights) {
    const n = nodes[nodeAt.get(key(l.x, l.z))];
    if (n) n.light = l;
  }
  return { nodes, edges };
}

function pointOnEdge(edge, nodes, s) {
  const A = nodes[edge.a], B = nodes[edge.b];
  const dx = (B.x - A.x) / edge.len, dz = (B.z - A.z) / edge.len;
  return [A.x + dx * s, A.z + dz * s, dx, dz];
}

// --- the simulation --------------------------------------------------------
export function createDrive(city, seed = 20261123) {
  const rng = mulberry32(seed);
  const lights = city.trafficLights.map((l, i) => ({ ...l, offset: (i * 3.7) % LIGHT_CYCLE }));
  const graph = buildGraph(ROADS, lights);
  const { nodes, edges } = graph;

  function nearestEdge(x, z, heading) {
    let best = null;
    let bestD = Infinity;
    for (const e of edges) {
      const A = nodes[e.a], B = nodes[e.b];
      const dx = B.x - A.x, dz = B.z - A.z;
      const len2 = dx * dx + dz * dz;
      let t = len2 === 0 ? 0 : ((x - A.x) * dx + (z - A.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = A.x + dx * t, pz = A.z + dz * t;
      const d = Math.hypot(x - px, z - pz);
      // Prefer edges whose direction matches the heading.
      const ex = dx / e.len, ez = dz / e.len;
      const align = Math.abs(heading[0] * ex + heading[1] * ez);
      const score = d + (1 - align) * 8;
      if (score < bestD) { bestD = score; best = { edge: e, s: t * e.len, align }; }
    }
    return best;
  }

  // --- traffic cars --------------------------------------------------------
  // Spawn weighted toward wide roads (boulevard/avenue carry the traffic).
  function weightedRoad() {
    const pool = ROADS.filter((r) => r.x1 === r.x2 || r.z1 === r.z2);
    let total = 0;
    for (const r of pool) total += r.w;
    let roll = rng() * total;
    for (const r of pool) {
      roll -= r.w;
      if (roll <= 0) return r;
    }
    return pool[pool.length - 1];
  }
  const traffic = city.cars.traffic.map((car, i) => {
    // Re-place the car on a weighted road (wide roads carry the traffic),
    // then snap it to the nearest graph edge.
    const road = weightedRoad();
    const t = rng();
    const rx = road.x1 + (road.x2 - road.x1) * t;
    const rz = road.z1 + (road.z2 - road.z1) * t;
    const nx = -(road.z2 - road.z1), nz = road.x2 - road.x1;
    const nl = Math.hypot(nx, nz) || 1;
    const side = rng() < 0.5 ? -1 : 1;
    car.x = rx + (nx / nl) * side * (road.w / 2 - 5);
    car.z = rz + (nz / nl) * side * (road.w / 2 - 5);
    car.angle = Math.atan2(road.x2 - road.x1, road.z2 - road.z1) + (rng() < 0.5 ? 0 : Math.PI);
    const heading = [Math.sin(car.angle), Math.cos(car.angle)];
    const snap = nearestEdge(car.x, car.z, heading);
    const cruise = (22 + rng() * 10) * KMH; // 22–32 km/h
    return {
      car, edge: snap.edge, s: snap.s,
      dir: (heading[0] * (nodes[snap.edge.b].x - nodes[snap.edge.a].x)
        + heading[1] * (nodes[snap.edge.b].z - nodes[snap.edge.a].z)) >= 0 ? 1 : -1,
      speed: cruise * (0.6 + rng() * 0.4), cruise,
      turnFrom: null, turnT: 1, stoppedAt: null, idx: i,
    };
  });

  function carPos(tc) {
    const e = tc.edge;
    const [px, pz, dx, dz] = pointOnEdge(e, nodes, tc.s);
    // Right-hand traffic: keep to the right of the direction of travel.
    const tx = tc.dir * dx, tz = tc.dir * dz;
    const rx = -tz, rz = tx;
    const off = e.w / 4;
    let x = px + rx * off, z = pz + rz * off;
    if (tc.turnT < 1 && tc.turnFrom) {
      const k = tc.turnT * tc.turnT * (3 - 2 * tc.turnT);
      x = tc.turnFrom[0] + (x - tc.turnFrom[0]) * k;
      z = tc.turnFrom[1] + (z - tc.turnFrom[1]) * k;
    }
    return [x, z, Math.atan2(tx, tz)];
  }

  function applyCarPos(tc) {
    const [x, z, angle] = carPos(tc);
    tc.car.x = x;
    tc.car.z = z;
    tc.car.angle = angle;
  }
  for (const tc of traffic) applyCarPos(tc);

  // --- pedestrians ---------------------------------------------------------
  const roadPool = ROADS.filter((r) => r.x1 === r.x2 || r.z1 === r.z2);
  function pedOnRoad(ped) {
    const r = ped.road;
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const nx = -uz, nz = ux;
    const off = ped.side * (r.w / 2 + 5);
    return [r.x1 + ux * ped.along + nx * off, r.z1 + uz * ped.along + nz * off];
  }
  const peds = city.pedestrians.map((ped, i) => {
    const wander = i < 18; // plaza (12) + park (6) pedestrians wander
    const area = i < 12 ? city.plaza : city.park;
    const r = roadPool[Math.floor(rng() * roadPool.length)];
    const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
    return {
      ped, wander, area,
      road: r, along: rng() * len, dir: rng() < 0.5 ? 1 : -1,
      side: rng() < 0.5 ? 1 : -1, speed: (1.2 + rng() * 0.6),
      mode: 'walk', crossT: 0, crossFrom: null, crossTo: null,
      crossTimer: 12 + rng() * 18, tx: ped.x, tz: ped.z,
      dodgeX: 0, dodgeZ: 0,
    };
  });

  // --- player --------------------------------------------------------------
  // Static round obstacles the sim must respect (not buildings): the clock
  // tower and the fountain, both standing on the boulevard.
  const OBSTACLES = [
    { x: 400, z: 0, r: 13 },   // clock tower
    { x: 400, z: 120, r: 23 }, // fountain
  ];
  const player = {
    mode: 'foot',
    x: 330, z: 78, angle: 0, speed: 0,
    car: null, profile: null, damage: 0, shake: 0,
    velX: 0, velZ: 0, lastHitAt: -10,
  };
  // Assign a driving profile to each drivable car, round-robin.
  city.cars.drivable.forEach((c, i) => { c.profile = PROFILE_ORDER[i % PROFILE_ORDER.length]; });

  const sim = {
    city, time: 0, traffic, peds, player,
    dust: [], crossings: [],
    headlightsOn: true, trafficEnabled: true,
    stats: { redRuns: 0, stops: [], minGap: Infinity, carCarOverlaps: 0, carPedOverlaps: 0, crossingsDone: 0, lightEncounters: 0, lightPasses: 0 },
  };

  // --- helpers -------------------------------------------------------------
  function buildingObb(b) {
    return { x: b.x, z: b.z, hw: b.w / 2, hd: b.d / 2, angle: b.angle };
  }
  function carObb(c) {
    return { x: c.x, z: c.z, hw: 2.3, hd: 4.5, angle: c.angle };
  }
  function allCars() {
    return [...city.cars.parked, ...city.cars.drivable, ...city.cars.traffic];
  }

  function trafficStep(dt) {
    if (!sim.trafficEnabled) return;
    // Active crossings, for cars to yield to.
    const activeCross = sim.crossings;
    for (const tc of traffic) {
      const e = tc.edge;
      const targetNodeIdx = tc.dir === 1 ? e.b : e.a;
      const targetNode = nodes[targetNodeIdx];
      const distToNode = tc.dir === 1 ? e.len - tc.s : tc.s;
      let target = tc.cruise;

      // Stop-line distance: the car's centre must stop clear of the
      // crossing road (half its width) plus half a car length plus a
      // 1-unit margin — stopping 8.5 before the node centre leaves the
      // bumper inside a wide intersection.
      let crossW = 0;
      for (const ei of targetNode.edges) {
        const oe = edges[ei];
        if (oe !== e) crossW = Math.max(crossW, oe.w / 2);
      }
      const stopD = crossW + 5.5;

      // 1. Traffic light at the target node.
      if (targetNode.light) {
        if (tc.nearLightNode !== targetNodeIdx && distToNode < 60) {
          tc.nearLightNode = targetNodeIdx;
          sim.stats.lightEncounters++;
        }
        const light = targetNode.light;
        const sig = signalFor(light, e.vertical, sim.time);
        const timeToReach = Math.max(0, distToNode - stopD) / Math.max(tc.speed, 0.5);
        const willBeRed = sig !== 'green' || timeUntilNotGreen(light, e.vertical, sim.time) < timeToReach + 2.0;
        // Past the stop line the car is committed: clear the intersection.
        // But a car that overshot and came to a near-stop just past the
        // line waits for green instead of accelerating through red.
        if (willBeRed && distToNode < 60 && distToNode > stopD) {
          const stopDist = Math.max(0, distToNode - stopD);
          target = Math.min(target, Math.sqrt(2 * 8 * stopDist));
          if (distToNode <= stopD + 0.1) target = 0;
        } else if (distToNode <= stopD && tc.speed < 0.5) {
          // Overshot and nearly stopped just past the line: wait for green
          // on red (on yellow, clear the intersection instead).
          if (signalFor(light, e.vertical, sim.time) === 'red') target = 0;
        }
      }
      // 2. Pedestrian crossing ahead on this edge.
      for (const cr of activeCross) {
        const [cx, cz] = [cr.x, cr.z];
        const [px, pz, dx, dz] = pointOnEdge(e, nodes, tc.s);
        const tx = tc.dir * dx, tz = tc.dir * dz;
        const relX = cx - px, relZ = cz - pz;
        const ahead = relX * tx + relZ * tz;
        const side = Math.abs(relX * tz - relZ * tx);
        if (ahead > 0 && ahead < 30 && side < 8) {
          target = Math.min(target, Math.sqrt(2 * 8 * Math.max(0, ahead - 8)));
          if (ahead <= 8.5) target = 0;
        }
      }
      // 3. Follow gap: the car ahead on the same edge, same direction.
      for (const other of traffic) {
        if (other === tc || other.edge !== e || other.dir !== tc.dir) continue;
        const gap = (other.s - tc.s) * tc.dir - 9;
        if (gap > 0 && gap < 14) {
          if (gap < 5) target = 0;
          else target = Math.min(target, other.speed * (gap / 14));
          if (gap < sim.stats.minGap) sim.stats.minGap = gap;
        }
      }
      // 4. Another car inside the target intersection: yield if it is
      // closer to the node than we are (breaks deadlocks by distance).
      // Once committed (within the yield line), clear the intersection.
      if (distToNode < 30 && distToNode > stopD + 3) {
        for (const other of traffic) {
          if (other === tc) continue;
          const od = Math.hypot(other.car.x - targetNode.x, other.car.z - targetNode.z);
          if (od < 20 && od < distToNode - 2) {
            target = Math.min(target, Math.sqrt(2 * 8 * Math.max(0, distToNode - (stopD + 3))));
            if (distToNode <= stopD + 3.1) target = 0;
            break;
          }
        }
      }

      // Speed toward target.
      if (target > tc.speed) tc.speed = Math.min(target, tc.speed + 6 * dt);
      else tc.speed = Math.max(target, tc.speed - 10 * dt);
      if (tc.speed < 0.01) tc.speed = 0;
      // Snap to a full stop: the sqrt braking profile is asymptotic, so
      // without this the car creeps past the stop line instead of waiting.
      if (target === 0 && tc.speed < 3) tc.speed = 0;

      // Record a full stop at a light (front bumper to the intersection
      // edge — the clearance past the crossing road).
      if (tc.speed === 0 && targetNode.light && distToNode < stopD + 4 && !tc.stoppedAt) {
        tc.stoppedAt = targetNodeIdx;
        sim.stats.stops.push({ light: targetNode.light, gap: +(distToNode - 4.5 - crossW).toFixed(1) });
      }
      if (tc.speed > 0.5) tc.stoppedAt = null;

      const prevS = tc.s;
      const prevDistToNode = distToNode;
      tc.s += tc.dir * tc.speed * dt;
      const newDistToNode = tc.dir === 1 ? e.len - tc.s : tc.s;
      // Red-run: the car's centre crossed the STOP LINE while its signal
      // was red. Crossing the node itself on red after entering on green
      // or yellow is legal and is not counted.
      if (targetNode.light && prevDistToNode > stopD && newDistToNode <= stopD) {
        const sig = signalFor(targetNode.light, e.vertical, sim.time);
        if (sig === 'red' && tc.speed > 3) sim.stats.redRuns++;
      }
      // Light pass: the car's centre crossed the node.
      if (targetNode.light) {
        const crossed = tc.dir === 1 ? (prevS < e.len && tc.s >= e.len) : (prevS > 0 && tc.s <= 0);
        if (crossed) {
          sim.stats.lightPasses++;
          tc.nearLightNode = -1;
        }
      }
      // Arrived at the node: pick the next edge. Traffic mostly goes
      // straight (70%): the edge most aligned with the travel direction.
      if ((tc.dir === 1 && tc.s >= e.len) || (tc.dir === -1 && tc.s <= 0)) {
        const from = [tc.car.x, tc.car.z];
        const node = nodes[targetNodeIdx];
        tc.nearLightNode = -1;
        const candidates = node.edges.filter((ei) => edges[ei] !== e);
        if (candidates.length === 0) {
          tc.dir = -tc.dir; // dead end: U-turn on the same edge
          tc.s = tc.dir === 1 ? 0 : e.len;
        } else {
          const fromNode = nodes[tc.dir === 1 ? e.a : e.b];
          const tdx = node.x - fromNode.x, tdz = node.z - fromNode.z;
          const tl = Math.hypot(tdx, tdz) || 1;
          const ux = tdx / tl, uz = tdz / tl;
          let next;
          if (rng() < 0.7) {
            let bestDot = -2;
            let bestEi = candidates[0];
            for (const ei of candidates) {
              const ce = edges[ei];
              const ddx = ce.a === targetNodeIdx ? nodes[ce.b].x - nodes[ce.a].x : nodes[ce.a].x - nodes[ce.b].x;
              const ddz = ce.a === targetNodeIdx ? nodes[ce.b].z - nodes[ce.a].z : nodes[ce.a].z - nodes[ce.b].z;
              const dl = Math.hypot(ddx, ddz) || 1;
              const dot = (ddx / dl) * ux + (ddz / dl) * uz;
              if (dot > bestDot) { bestDot = dot; bestEi = ei; }
            }
            next = edges[bestEi];
          } else {
            next = edges[candidates[Math.floor(rng() * candidates.length)]];
          }
          tc.edge = next;
          if (next.a === targetNodeIdx) { tc.dir = 1; tc.s = 0; }
          else { tc.dir = -1; tc.s = next.len; }
        }
        tc.turnFrom = from;
        tc.turnT = 0;
      }
      if (tc.turnT < 1) tc.turnT = Math.min(1, tc.turnT + dt / 0.8);
      applyCarPos(tc);
    }
  }

  function pedsStep(dt) {
    sim.crossings = [];
    for (const p of peds) {
      // Dodge the player's driven car: step away fast if it comes close.
      const pl = player;
      if (pl.mode === 'drive') {
        const dx = p.ped.x - pl.x, dz = p.ped.z - pl.z;
        const d = Math.hypot(dx, dz);
        if (d < 9 && d > 0.01) {
          p.dodgeX = (dx / d) * 4.5;
          p.dodgeZ = (dz / d) * 4.5;
        } else {
          p.dodgeX *= 0.9;
          p.dodgeZ *= 0.9;
        }
      } else {
        p.dodgeX *= 0.9;
        p.dodgeZ *= 0.9;
      }
      if (p.mode === 'cross') {
        p.crossT += (2.5 * dt) / Math.hypot(p.crossTo[0] - p.crossFrom[0], p.crossTo[1] - p.crossFrom[1]);
        const k = Math.min(1, p.crossT);
        p.ped.x = p.crossFrom[0] + (p.crossTo[0] - p.crossFrom[0]) * k;
        p.ped.z = p.crossFrom[1] + (p.crossTo[1] - p.crossFrom[1]) * k;
        p.ped.angle = Math.atan2(p.crossTo[0] - p.crossFrom[0], p.crossTo[1] - p.crossFrom[1]);
        sim.crossings.push({ x: (p.crossFrom[0] + p.crossTo[0]) / 2, z: (p.crossFrom[1] + p.crossTo[1]) / 2 });
        if (k >= 1) {
          p.mode = 'walk';
          p.side = -p.side;
          p.crossTimer = 14 + rng() * 20;
          sim.stats.crossingsDone++;
        }
      } else if (p.wander) {
        const dx = p.tx - p.ped.x, dz = p.tz - p.ped.z;
        const d = Math.hypot(dx, dz);
        if (d < 3) {
          p.tx = p.area.x0 + 15 + rng() * (p.area.x1 - p.area.x0 - 30);
          p.tz = p.area.z0 + 15 + rng() * (p.area.z1 - p.area.z0 - 30);
        } else {
          const step = p.speed * dt;
          p.ped.x += (dx / d) * step;
          p.ped.z += (dz / d) * step;
          p.ped.angle = Math.atan2(dx, dz);
        }
      } else {
        const r = p.road;
        const len = Math.hypot(r.x2 - r.x1, r.z2 - r.z1);
        p.along += p.dir * p.speed * dt;
        if (p.along >= len || p.along <= 0) {
          // At the end of the road: turn around (simple, keeps peds on
          // sidewalks instead of teleporting across the city).
          p.dir = -p.dir;
          p.along = Math.max(0, Math.min(len, p.along));
        }
        const [x, z] = pedOnRoad(p);
        p.ped.x = x;
        p.ped.z = z;
        const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
        p.ped.angle = Math.atan2(dx * p.dir, dz * p.dir);
        // Maybe start crossing at a crosswalk (narrow roads only).
        p.crossTimer -= dt;
        if (p.crossTimer <= 0 && r.w <= 28) {
          const [cx, cz] = pedOnRoad(p);
          const side = -p.side;
          const nx = -(r.z2 - r.z1), nz = r.x2 - r.x1;
          const nl = Math.hypot(nx, nz) || 1;
          const toX = r.x1 + ((r.x2 - r.x1) / len) * p.along + (nx / nl) * side * (r.w / 2 + 5);
          const toZ = r.z1 + ((r.z2 - r.z1) / len) * p.along + (nz / nl) * side * (r.w / 2 + 5);
          let clear = true;
          for (const c of allCars()) {
            if (Math.hypot(c.x - (cx + toX) / 2, c.z - (cz + toZ) / 2) < 30) { clear = false; break; }
          }
          if (clear) {
            p.mode = 'cross';
            p.crossT = 0;
            p.crossFrom = [cx, cz];
            p.crossTo = [toX, toZ];
          } else {
            p.crossTimer = 3; // retry soon
          }
        }
      }
      // Dodge offset applies on top of the walk position.
      p.ped.x += p.dodgeX * dt;
      p.ped.z += p.dodgeZ * dt;
    }
  }

  function playerStep(dt, input, cameraYaw) {
    const pl = player;
    if (pl.mode === 'foot') {
      const fwd = [Math.sin(cameraYaw), Math.cos(cameraYaw)];
      const right = [-fwd[1], fwd[0]];
      let mx = 0, mz = 0;
      if (input.up) { mx += fwd[0]; mz += fwd[1]; }
      if (input.down) { mx -= fwd[0]; mz -= fwd[1]; }
      if (input.left) { mx += right[0]; mz += right[1]; }
      if (input.right) { mx -= right[0]; mz -= right[1]; }
      const ml = Math.hypot(mx, mz);
      const run = input.run ? 12 : 6;
      if (ml > 0) {
        pl.angle = Math.atan2(mx / ml, mz / ml);
        pl.speed = run;
        pl.x += (mx / ml) * run * dt;
        pl.z += (mz / ml) * run * dt;
      } else {
        pl.speed = 0;
      }
      // Collision: circle vs buildings, cars and round obstacles.
      for (const b of city.buildings) {
        const push = circleObbPush(pl.x, pl.z, 1.2, buildingObb(b));
        if (push) { pl.x += push[0]; pl.z += push[1]; }
      }
      for (const c of allCars()) {
        const push = circleObbPush(pl.x, pl.z, 1.2, carObb(c));
        if (push) { pl.x += push[0]; pl.z += push[1]; }
      }
      for (const o of OBSTACLES) {
        const dx = pl.x - o.x, dz = pl.z - o.z;
        const d = Math.hypot(dx, dz);
        const minD = o.r + 1.2;
        if (d < minD && d > 0.01) {
          pl.x += (dx / d) * (minD - d);
          pl.z += (dz / d) * (minD - d);
        }
      }
      pl.x = Math.max(-1900, Math.min(1900, pl.x));
      pl.z = Math.max(-1700, Math.min(1700, pl.z));
      return;
    }
    // Driving.
    const prof = PROFILES[pl.profile];
    const top = prof.topKmh * KMH;
    const revTop = prof.reverseKmh * KMH;
    const fwd = [Math.sin(pl.angle), Math.cos(pl.angle)];
    if (input.up) pl.speed = Math.min(top, pl.speed + prof.accel * dt);
    else if (input.down) {
      if (pl.speed > 0.5) pl.speed = Math.max(0, pl.speed - prof.brake * dt);
      else pl.speed = Math.max(-revTop, pl.speed - prof.accel * 0.7 * dt);
    } else {
      // Coast down slowly.
      pl.speed -= Math.sign(pl.speed) * Math.min(Math.abs(pl.speed), 2.5 * dt);
      if (Math.abs(pl.speed) < 0.05) pl.speed = 0;
    }
    if (input.handbrake) {
      pl.speed -= Math.sign(pl.speed) * Math.min(Math.abs(pl.speed), 22 * dt);
    }
    // Steering: sharper at low speed, gentler at top speed.
    const steerAuthority = prof.steer * (1 - Math.min(1, Math.abs(pl.speed) / top) * 0.55);
    const steerInput = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    const dirSign = pl.speed >= 0 ? 1 : -1;
    pl.angle += steerInput * steerAuthority * dirSign * Math.min(1, Math.abs(pl.speed) / 6 + 0.15) * dt;
    if (input.handbrake) pl.angle += steerInput * 1.6 * dirSign * dt;
    const nx = pl.x + Math.sin(pl.angle) * pl.speed * dt;
    const nz = pl.z + Math.cos(pl.angle) * pl.speed * dt;
    const speedBefore = pl.speed;
    pl.x = nx;
    pl.z = nz;
    pl.car.x = pl.x;
    pl.car.z = pl.z;
    pl.car.angle = pl.angle;
    // Collision: car OBB vs buildings and other cars.
    const me = carObb(pl.car);
    let hit = false;
    for (const b of city.buildings) {
      const mtv = obbMtv(me, buildingObb(b));
      if (mtv) {
        pl.x += mtv[0];
        pl.z += mtv[1];
        pl.car.x = pl.x;
        pl.car.z = pl.z;
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const c of allCars()) {
        if (c === pl.car) continue;
        const mtv = obbMtv(me, carObb(c));
        if (mtv) {
          pl.x += mtv[0];
          pl.z += mtv[1];
          pl.car.x = pl.x;
          pl.car.z = pl.z;
          hit = true;
          break;
        }
      }
    }
    if (hit) {
      const impact = Math.abs(speedBefore);
      if (impact > 4 && sim.time - pl.lastHitAt > 0.3) {
        pl.damage = Math.min(100, pl.damage + impact * 0.9);
        pl.shake = Math.min(1, impact / 22);
        pl.lastHitAt = sim.time;
        sim.dust.push({
          x: pl.x + fwd[0] * 4, z: pl.z + fwd[1] * 4,
          age: 0, life: 0.9, size: 3 + impact * 0.12,
        });
      }
      pl.speed *= 0.25;
    }
    // Round obstacles (tower, fountain): push the car out as a circle.
    for (const o of OBSTACLES) {
      const dx = pl.x - o.x, dz = pl.z - o.z;
      const d = Math.hypot(dx, dz);
      const minD = o.r + 4.5;
      if (d < minD && d > 0.01) {
        pl.x += (dx / d) * (minD - d);
        pl.z += (dz / d) * (minD - d);
        pl.car.x = pl.x;
        pl.car.z = pl.z;
        const impact = Math.abs(speedBefore);
        if (impact > 4 && sim.time - pl.lastHitAt > 0.3) {
          pl.damage = Math.min(100, pl.damage + impact * 0.9);
          pl.shake = Math.min(1, impact / 22);
          pl.lastHitAt = sim.time;
          sim.dust.push({
            x: pl.x + fwd[0] * 4, z: pl.z + fwd[1] * 4,
            age: 0, life: 0.9, size: 3 + impact * 0.12,
          });
        }
        pl.speed *= 0.25;
      }
    }
    pl.shake = Math.max(0, pl.shake - dt * 1.4);
    pl.x = Math.max(-1900, Math.min(1900, pl.x));
    pl.z = Math.max(-1700, Math.min(1700, pl.z));
  }

  // --- public API ----------------------------------------------------------
  sim.update = function update(dt, input = {}, cameraYaw = 0) {
    sim.time += dt;
    trafficStep(dt);
    pedsStep(dt);
    playerStep(dt, input, cameraYaw);
    for (const d of sim.dust) d.age += dt;
    sim.dust = sim.dust.filter((d) => d.age < d.life);
  };

  // Run the world forward with no player input (shot setup, tests).
  sim.advance = function advance(seconds) {
    const steps = Math.ceil(seconds / 0.05);
    for (let i = 0; i < steps; i++) sim.update(0.05, {}, 0);
  };

  sim.nearestDrivable = function nearestDrivable(maxDist = 14) {
    let best = null;
    let bestD = maxDist;
    for (const c of city.cars.drivable) {
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best ? { car: best, dist: bestD } : null;
  };

  sim.nearestParked = function nearestParked(maxDist = 14) {
    let best = null;
    let bestD = maxDist;
    for (const c of city.cars.parked) {
      const d = Math.hypot(c.x - player.x, c.z - player.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best ? { car: best, dist: bestD } : null;
  };

  sim.prompt = function prompt() {
    // While driving the HUD shows E — EXIT (E still exits the car); the
    // ground ring is only for a car you can enter, not the one you are in.
    if (player.mode === 'drive') return { text: 'E — EXIT', kind: 'exit', car: player.car };
    const d = sim.nearestDrivable();
    if (d) return { text: `E — ENTER ${PROFILES[d.car.profile].name}`, kind: 'enter', car: d.car };
    const p = sim.nearestParked();
    if (p) return { text: 'LOCKED — PARKED CAR', kind: 'locked', car: p.car };
    return { text: '', kind: '' };
  };

  // E pressed: enter the nearest drivable car, or exit the car.
  sim.interact = function interact() {
    if (player.mode === 'foot') {
      const d = sim.nearestDrivable();
      if (!d) return false;
      player.mode = 'drive';
      player.car = d.car;
      player.profile = d.car.profile;
      player.x = d.car.x;
      player.z = d.car.z;
      player.angle = d.car.angle;
      player.speed = 0;
      return true;
    }
    // Exit: step out to the left of the car.
    const side = [-Math.cos(player.angle), Math.sin(player.angle)];
    player.x = player.car.x + side[0] * 5;
    player.z = player.car.z + side[1] * 5;
    player.angle = player.car.angle;
    player.speed = 0;
    player.mode = 'foot';
    player.car = null;
    player.profile = null;
    return true;
  };

  // Put the player in a drivable car at a fixed spot (tests, shots).
  sim.teleportPlayer = function teleportPlayer(x, z, angle, carIndex = 0) {
    const car = city.cars.drivable[carIndex];
    car.x = x;
    car.z = z;
    car.angle = angle;
    player.mode = 'drive';
    player.car = car;
    player.profile = car.profile;
    player.x = x;
    player.z = z;
    player.angle = angle;
    player.speed = 0;
  };

  sim.playerSpeedKmh = function playerSpeedKmh() {
    return Math.round(Math.abs(player.speed) / KMH);
  };

  sim.playerPos = function playerPos() {
    return [player.x, player.z];
  };

  // Place the scene for a drive screenshot: player in a car on the
  // boulevard heading north toward the clock tower, traffic running,
  // one traffic car ahead inside the headlight cone. The car ahead is
  // re-placed AFTER the 30 s advance — placed before it, it drives away
  // from the shot.
  sim.placeForShot = function placeForShot() {
    sim.teleportPlayer(400, 480, Math.PI, 0);
    sim.advance(30);
    const ahead = city.cars.traffic[0];
    ahead.x = 400;
    ahead.z = 445;
    ahead.angle = Math.PI;
    // Re-snap that traffic car onto the boulevard edge so the sim keeps it.
    const snap = nearestEdge(ahead.x, ahead.z, [0, -1]);
    const tc = traffic[0];
    tc.edge = snap.edge;
    tc.s = snap.s;
    tc.dir = 1;
    tc.speed = 0;
    tc.cruise = 26 * KMH;
  };

  // Is a red/yellow light within maxDist ahead of the player (along its
  // heading)? Used by the demo auto-driver.
  sim.redLightAhead = function redLightAhead(maxDist = 45) {
    if (player.mode !== 'drive') return false;
    const fx = Math.sin(player.angle), fz = Math.cos(player.angle);
    for (const l of lights) {
      const dx = l.x - player.x, dz = l.z - player.z;
      const ahead = dx * fx + dz * fz;
      const side = Math.abs(dx * fz - dz * fx);
      if (ahead > 0 && ahead < maxDist && side < 12) {
        const vertical = Math.abs(fz) > Math.abs(fx);
        if (signalFor(l, vertical, sim.time) !== 'green') return true;
      }
    }
    return false;
  };

  // Is another car within maxDist directly ahead of the player?
  sim.carAhead = function carAhead(maxDist = 25) {
    if (player.mode !== 'drive') return false;
    const fx = Math.sin(player.angle), fz = Math.cos(player.angle);
    for (const c of allCars()) {
      if (c === player.car) continue;
      const dx = c.x - player.x, dz = c.z - player.z;
      const ahead = dx * fx + dz * fz;
      const side = Math.abs(dx * fz - dz * fx);
      if (ahead > 0 && ahead < maxDist && side < 5) return true;
    }
    return false;
  };

  // Render options for the dynamic geometry (called every frame).
  sim.renderOpts = function renderOpts(timeMs) {
    const pr = sim.prompt();
    return {
      timeMs,
      headlightsOn: sim.headlightsOn,
      headlightLevel: 1,
      drivenCar: player.mode === 'drive' ? player.car : null,
      mara: player.mode === 'foot' ? { x: player.x, z: player.z, angle: player.angle } : null,
      // The ground ring marks a car you can enter (or a locked parked
      // car); it is not drawn around the car you are already driving.
      prompt: (pr.kind === 'enter' || pr.kind === 'locked') ? { x: pr.car.x, z: pr.car.z, r: 12, mode: pr.kind } : null,
      dust: sim.dust,
      lights: lights.map((l) => ({
        x: l.x, z: l.z,
        ns: signalFor(l, true, sim.time),
        ew: signalFor(l, false, sim.time),
      })),
    };
  };

  return sim;
}
