# Stage A — Palkon Auto: renderer + real-city Solmar

Date: 2026-11-23. Repo: `aint965/gta6-01-3d-v15`. Recording: v15 (pid 9784, alive at end of stage).

## What was built

- Handwritten WebGL 2 renderer (`game/src/render.js`): one shader program, one
  16-float vertex layout (pos/normal/color/emissive/uv/tex/spec), diffuse +
  Blinn-Phong specular + exponential fog, flat-shaded sky pass (horizon band,
  sky top, sun/moon disc facing the city, stars at night), and a canvas-2D
  texture atlas for the neon signs. No vendored library.
- Real-city Solmar (`game/src/city.js`, seed 20261123, deterministic): one wide
  boulevard (x = 400, 64 units) north–south + main avenue (z = 0, 64) east–west
  meeting at the central plaza (clock tower + fountain); road hierarchy
  (boulevard/avenue 64, secondary 28, local 18, diagonal); Old Solmar off-grid
  (diagonal avenue + jogged streets, buildings rotated 15°); varied blocks;
  height/density falling away from the centre toward beach/residential edges;
  canal (z 650–730) with 3 drivable bridges, harbour, beach, park.
- 7 named districts with tagline + standing (Old Solmar 55, Canal Ward 48,
  South Market 62, Citrus Quarter 51, Pearl Marina 58, Glasspoint 44,
  Sunstrand Beach 66), each with its own wall palette; Glasspoint towers
  50–130 units with glass specular.
- Living-city dressing: 648 buildings (windows, some lit; brick base trim;
  ground shadows leaning away from the sun), 235 trees (park cluster,
  boulevard rows, canal promenade, beach palms), 125 lamps with light pools,
  5 boats, 13 traffic lights, 54 parked + 8 drivable (coral, roof sign) +
  40 traffic cars (3 yellow taxis), 40 pedestrians in bright jackets,
  4 neon signs (SOLMAR, PALKO, MARINA, BEACH).
- HUD (`game/src/hud.js`): title, district line + standing bar, compass strip,
  clock + preset + fps, minimap (roads, boulevard highlight, district-coloured
  buildings, plaza/park/water, camera dot), speedometer, controls.
- Camera: orbit + pan + zoom, keys 1/2/3/T for midday/sunset/night; `?shot=`
  mode with 4 deterministic shots (seed 20261123).
- Entrypoint `main.ts` written in-session (screenshot guard: 3–4 images, each
  ≤256 KiB, `game/index.html` must exist; output check: dossier must carry
  exactly the packed images with a valid cover index). Edited once after the
  first packaging run (added the output check + sorted shot list) and re-run.

## Measured results

- Layout verifier (`checks/verify-layout.mjs`): **0 problems**. Counts:
  buildings 648, trees 235, lamps 125, boats 5, traffic lights 13, parked 54,
  drivable 8, traffic 40, pedestrians 40, signs 4.
- Drive test (`checks/drive.mjs`, port 8126, headless Chromium + SwiftShader):
  **4/4 shots OK, 0 console errors, 0 game errors** (empty `#game-errors`).
  Sizes: boulevard-day.png 123,905 B; night.png 117,635 B;
  plaza.jpg 156,919 B (PNG was 265,620 B, over the 256 KiB cap — converted to
  JPEG quality 85 by the driver); sunset.png 110,028 B. All ≤ 262,144 B.
- Packaging (`checks/pack-verify.mjs`): **byte-identical twice** — dossier
  741,780 B, sha256
  `ec3ea0110bc203b51787112f82c80b90ea24ab2aa6a90daabd0966dcd59ac4dc`
  (same hash before and after the main.ts edit). Dossier: 4 images, cover
  index 0 (boulevard-day.png).
- Geometry: 178,878 vertices midday/sunset (static 151,854 + sky 276 +
  dynamic 26,748); 180,438 at night (stars add 1,560).
- Screenshots viewed by the builder: boulevard vista with the clock tower at
  the end of the road, plaza from above with fountain + tower, sunset with a
  warm orange horizon and lit windows, night with stars + lit windows + lamp
  pools. No debug overlay.

## Bugs found and fixed in-session

1. Winding order: the first render had no ground, no shadows, no sidewalks,
   no dashes, and hollow-looking buildings (near walls culled, far walls and
   bottom faces showing through). Root cause: several quads/triangles were
   wound backwards for `gl.CULL_FACE`. Fixed `box()` (top/bottom/side order +
   side-normal map), `pyramid()` side order, `disc()` (+Y default, `down`
   option for the sky top), ground/beach/plaza/water/park, sidewalks, dashes,
   shadows, back-face windows, boat sail, and rebuilt the sun/moon disc and
   stars to face the city centre.
2. Layout: first run had 87 problems — building lots were checked by centre
   only, so corners landed on roads and in the canal; trees beside one road
   sat on a cross street. Fixed with corner-based lot checks (margins wider
   than the verifier's) and an all-roads check for every tree. Second run:
   16 tree problems left; third run: 0.
3. `plaza.png` over the 256 KiB cap — driver now converts an oversized PNG
   to JPEG quality 85 and updates `shots.json`.

## Honest notes for later stages

- Sunset shot: the sun disc is behind the camera (sun sits east, camera looks
  west) — the warm horizon glow still reads, but the disc itself is not in
  frame. Stage F may re-aim the sunset shot if the disc matters.
- Night shot: the moon sits just above the top of the frame; stars are
  visible. Same note as above.
- The sky band / sky top boundary shows as a hard line at midday. Cosmetic;
  a gradient band is a Stage E polish item if time allows.
- Daylight headlight cones were noted as too bright in v14 Stage B; Stage A
  has no driving yet, so headlights are static boxes — Stage B owns the
  headlight test and the wash fix.

## Files

- `game/src/rng.js`, `game/src/color.js`, `game/src/city.js`,
  `game/src/render.js`, `game/src/hud.js`, `game/src/main.js`,
  `game/index.html`
- `main.ts` (rewritten in-session), `shots.json`
- `checks/verify-layout.mjs`, `checks/drive.mjs`, `checks/pack-verify.mjs`,
  `checks/report.md` (this file)
- `screenshots/boulevard-day.png`, `screenshots/night.png`,
  `screenshots/plaza.jpg`, `screenshots/sunset.png`

## Not done in this stage (by design)

No README.md, no submit, no bundle. No driving, missions, police, garages,
radio, or title screen — those are Stages B–F.
