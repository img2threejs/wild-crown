# R01 — First Pact guided locomotion lab

## Run and entry

From the repository root, run `npm install` followed by `npm run dev`. The independent game entry is `/`; **Enter Movement Lab** opens `/lab`. Vite binds to `127.0.0.1:5173` by default. Build with `npm run build`, strict checking with `npm run typecheck`, and exercise the built production app with `npm run preview` at `http://127.0.0.1:4173/`.

Production routing intentionally targets a root-hosted site: `/`, `/lab`, and `/lab/` use root-absolute assets and entry links. GitHub Pages project-subpath hosting is unsupported by this configuration.

The lab is explicitly identified as **Development Greybox**. The authored traversal follows near and far ribbon bands through a stone divider, then opens into a clearing with a route-end marker. Distinct stone, foliage, warm/cool stake and ring colors expose route depth. Capsule, trees, rocks, lighting and marker are development geometry—not final art or production assets.

## Controls and lifecycle

Click **Start**, then move with **WASD**, arrows, or a connected gamepad left stick. Movement is camera-relative. Diagonals normalize to the same maximum walk speed. **Pause** or Escape pauses; **Resume** restores canvas input focus; **Reset** returns to the start; **Debug** displays camera mode, player position/velocity, actual camera position/target, route bounds and authored collision bounds. Keyboard and gamepad input are only sampled while the game canvas has focus, so control interaction does not leak into gameplay.

Window blur and hidden tabs pause and clear held keys. A persisted `pagehide` pauses simulation and stops RAF; a BFCache `pageshow` resets elapsed time, reapplies viewport size, and resumes rendering without destroying the canvas. A final non-persisted `pagehide` removes listeners, disconnects resize observation, disposes Three.js resources, releases the renderer, and clears the debug export. ResizeObserver updates rendering and camera projection.

## Movement and camera policy

The proxy is kinematic and grounded at y=0. Its horizontal circle is tested against authored axis-aligned boxes by closest-point circle/AABB distance; axis-separated fixed steps block penetration and permit sliding along an unblocked axis. This flat greybox intentionally has **no slopes, step-up or free jump**. Simulation uses a 60 Hz fixed step, no more than five catch-up steps per rendered frame, and interpolated render transforms.

The camera follows at a guided three-quarter angle on the ribbon, then eases to the fixed arena pose `(0, 10, -12)` looking at `(0, 0.9, -25)`. The anchor is fully active inside the clearing, so moving within it does not move the camera framing. Decorative foreground leaf proxies fade near the player or camera to preserve body/feet visibility.

## Not in this lab

Combat, dodge, companion AI, final models/rigs/animation, narrative progression, saving, and full-game campaign completion are not implemented or claimed.

## Browser evidence

Retained WebP captures are in [`evidence/`](evidence/README.md). All show Development Greybox geometry only, not final art.

- [Independent game entry](evidence/entry.webp)
- [Near ribbon at collision wall](evidence/near-wall.webp)
- [Far ribbon traversal](evidence/far-ribbon.webp)
- [Arena anchor, player and route-end marker](evidence/arena-anchor.webp)
- [Production `/lab/` route](evidence/production-lab.webp)

The completion report records build/typecheck/audit outcomes, production route checks, traversal states, viewport/controls smoke and repeated browser Back/Forward restoration checks.
