# Guided locomotion — Astra production-route review

## Repairs verified before this finding

Astra inspected the lifecycle/camera changes and ran the application in owned Chromium.

- Traversed the real ribbon with keyboard input, moved around the authored divider and reached the clearing.
- Measured the fixed arena target `[0, 0.9, -25]` at player positions approximately `[-0.6574, 0, -27.5901]` and `[1.2101, 0, -27.5901]`; camera position settled near `[0, 10, -12]` at both.
- Pause prevented movement; Reset returned position `[0,0,12]` and the initial camera pose.
- Two committed-navigation Back/Forward restores retained one canvas, restored paused state, and allowed movement after Resume.
- After ResizeObserver settled, viewport and canvas both measured 1120x720.
- Build/typecheck passed. Patched Vite 6.4.3 audit reported zero known vulnerabilities.

The review driver initially issued Back before the entry navigation committed, which aborted that request and reached `about:blank`. That was a driver sequencing error, not a failed BFCache repair. The corrected sequence waits for the destination URL and entry control before navigating back. The driver's initial greedy route also contacted the divider; keyboard steering around the obstacle completed the route without teleport/debug state mutation.

## Production defect reproduced

Launched the actual built app using:

```sh
npm exec -- vite preview --host 127.0.0.1 --port 4173 --strictPort
```

At `http://127.0.0.1:4173/lab/` the page had no interactive controls or canvas. The browser requested `/lab/assets/index-4CrxkwkM.js`, which failed with `net::ERR_ABORTED`.

The Vite `base: './'` setting conflicted with the nested `/lab/` route that the application explicitly supports. Development-server success did not establish production-route correctness.

Returned to Luna: correct the base/routing contract, document a reproducible production preview command, and exercise built `/`, `/lab`, `/lab/`, reload and committed Back/Forward navigation. Root-hosted support must be stated without claiming an untested GitHub Pages subpath deployment.

No locomotion feature PR is marked accepted before this built-surface defect is corrected and verified.
