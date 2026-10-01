# R01 — First Pact guided locomotion lab

## Run and entry

Install dependencies with npm install, then run npm run dev. The full-game application is at /; open /lab/ directly for this separate Development Greybox risk lab. Vite binds to 127.0.0.1:5173. Run npm run build and npm run typecheck; npm run preview serves the built lab at http://127.0.0.1:4173/lab/.

The Vite build includes both root index.html and lab/index.html. Both use root-absolute assets; GitHub Pages project-subpath hosting is unsupported. The game title screen does not link to the development lab; use /lab/ directly.

The lab is explicitly identified as **Development Greybox**. The authored traversal follows near and far ribbon bands through a stone divider, then opens into a clearing with a route-end marker. Distinct stone, foliage, warm/cool stake and ring colors expose route depth. Capsule, trees, rocks, lighting and marker are development geometry—not final art or production assets.

## Controls and lifecycle

Click **Start**, then move with **WASD**, arrows, or a connected gamepad left stick. Movement is camera-relative. Diagonals normalize to the same maximum walk speed. **Pause** or Escape pauses; **Resume** restores canvas input focus; **Reset** returns to the start; **Debug** displays camera mode, player position/velocity, actual camera position/target, route bounds and authored collision bounds. Keyboard and gamepad input are only sampled while the game canvas has focus, so control interaction does not leak into gameplay.

Window blur and hidden tabs pause and clear held keys. A persisted `pagehide` pauses simulation and stops RAF; a BFCache `pageshow` resets elapsed time, reapplies viewport size, and resumes rendering without destroying the canvas. A final non-persisted `pagehide` removes listeners, disconnects resize observation, disposes Three.js resources, releases the renderer, and clears the debug export. ResizeObserver updates rendering and camera projection.

## Movement and camera policy

The proxy is grounded at y=0. Each 60 Hz lab step sends camera-relative, normalized movement through the production moveCircle swept-collision predicate, using the lab's authored AABB colliders, a 0.42 m horizontal radius and 1.7 m body height. The shared solver bounds the course and lets a blocked diagonal continue along an unblocked axis. This flat lab deliberately has no slopes, ledge step-up or free jump. The RAF loop uses a 60 Hz fixed step, at most five catch-up steps per rendered frame and interpolated render transforms. Displayed progress tracks z-depth toward the clearing; it is not a collision or contact condition for the central route-end marker.

The lab camera follows a guided three-quarter angle on the ribbon, then eases to the fixed arena pose (0, 10, -12) looking at (0, 0.9, -25). The anchor is fully active inside the clearing. Decorative foreground leaves fade near the player or camera to preserve body/feet visibility. This is a lab-specific camera path; production CameraDirector occluder collision is separate and exercised by tests/rendering/browser-smoke.ts.

## Not in this lab

This is a development risk instrument, not the GameApplication or a production acceptance screen. It does not implement combat, dodge, companion AI, final models/rigs/animation, narrative progression, saving or full-game campaign completion; all scene art remains greybox.

## Browser evidence

Retained WebP captures are in [`evidence/`](evidence/README.md). All show Development Greybox geometry only, not final art.

- [Legacy standalone entry capture (not the current full-game title screen)](evidence/entry.webp)
- [Near ribbon at collision wall](evidence/near-wall.webp)
- [Far ribbon traversal](evidence/far-ribbon.webp)
- [Arena anchor, player and route-end marker](evidence/arena-anchor.webp)
- [Built-preview route at /lab/](evidence/production-lab.webp)

Verification: npm run typecheck, bun test (136 passed, 0 failed; 619 expectations), and npm run build. The deterministic regression test confirms pause/resume interpolation starts from the current pose. Browser smoke exercised dev /lab/ movement, the authored start-gate collision and traversal, pause/resume/reset/Escape, the arena-anchor camera, and one Back/BFCache restore. The built preview served both / and /lab/ and passed movement/pause interaction. tests/rendering/browser-smoke.html reported PASS for production camera raycast/retraction against an authored capsule. No browser errors observed. These checks cover the Development Greybox and renderer path only; production gameplay and campaign acceptance remain unestablished.
