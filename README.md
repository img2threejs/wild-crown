# Wild Crown: The Broken Pact — First Pact Movement Lab

A standalone, explicitly labeled **Development Greybox** for bounded movement and camera evaluation. It is not final art or a complete game.

## Run

- `npm install` — install exact dependencies from `package-lock.json`.
- `npm run dev` — serve the independent game entry at `/`; choose **Enter Movement Lab** or open `/lab`.
- `npm run typecheck` — strict TypeScript check.
- `npm run build` — typecheck and production bundle.
- `npm run preview` — serve the built app at `http://127.0.0.1:4173/` (build first).

Production routing targets a root-hosted site: `/`, `/lab`, and `/lab/`. GitHub Pages project-subpath hosting is not supported by this build.

## Controls

Click **Start** to focus movement. Move with **WASD** or the arrow keys; use the left stick on a connected gamepad. Diagonals are normalized. Click **Pause** or press Escape to pause; use **Resume** to continue. **Reset** returns to the ribbon entrance. **Debug** reveals camera mode, motion, actual camera position/target and authored collision bounds. Keyboard/gamepad input is captured only while the game canvas is focused; click **Resume** or the canvas to return to movement. The scene automatically pauses and clears input on tab hiding or window blur.

## Movement and collision limits

The graybox uses a kinematic ground-plane capsule proxy against authored axis-aligned bounds. Wall response slides along one axis and blocks the other. The ribbon and arena are flat at ground level: there is no free jump, slope support, or step-up, and no combat, dodge, companion AI, or final model/animation system. Foreground leaf proxies demonstrate camera occlusion and fade near the player/camera so feet remain readable.

The fixed simulation runs at 60 Hz, caps catch-up at five steps, and interpolates visual transforms. The camera follows a guided three-quarter route and settles on a fixed arena anchor. BFCache restores pause first and resume rendering without destroying the lab canvas.

See [`docs/features/guided-locomotion.md`](docs/features/guided-locomotion.md) for scope and retained live-browser evidence.
