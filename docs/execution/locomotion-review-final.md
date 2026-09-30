# Guided locomotion — final Astra review for this feature

Feature PR: https://github.com/img2threejs/wild-crown/pull/3
Commit: `b912f8b`.
Implementation model: Luna. Reviewer: active Astra coordinator.

## Verdict

Accepted for the bounded R01 guided-locomotion development lab after two repair rounds. Both specification and code-quality review were performed against source and actual running surfaces.

## Evidence exercised by Astra

- Strict TypeScript/build passed on the repaired feature. Vite 6.4.3 dependency audit returned zero known vulnerabilities.
- Real keyboard input traversed the entry gap, near/far route and outer side of the authored divider, reaching route progress 1 without modifying player state or teleporting.
- Two interior positions measured approximately `[-0.6574,0,-27.5901]` and `[1.2101,0,-27.5901]`. The camera target stayed `[0,0.9,-25]` and the camera settled near `[0,10,-12]` at both.
- Pause prevented movement; Reset returned `[0,0,12]` with initial camera position `[7.2,7.2,20.2]` and target `[0,0.9,7.5]`.
- Two browser history restores retained one canvas, preserved paused state and allowed movement after Resume. Root entry had no canvas or stale debug export.
- After ResizeObserver settled, both viewport and canvas were 1120x720.
- Actual production preview verified direct `/lab/`, refresh, root entry `/`, entry link to `/lab`, and committed Back/Forward navigation. Post-fix script/style requests resolved under `/assets/`; production smoke had no newly captured page or console errors.

The review driver had an earlier aborted navigation caused by Back before navigation committed. It also initially steered into a divider corner. These driver failures are retained in the round record and are not presented as successful application tests. Corrected navigation sequencing and real keyboard steering completed the verification.

## Code-quality checks

- Fixed-step simulation and camera-relative input are separate from presentation setup.
- Arena look target no longer depends on the player's arena Z position.
- Camera/foliage frame paths reuse vector scratch state.
- BFCache persistence retains the cached renderer; non-persisted teardown disposes it and clears the debug export.
- Dev/preview bind to loopback, not all network interfaces.
- Production asset base matches supported absolute root routes.
- Evidence screenshots are repository-relative and part of the feature PR.

## Limits retained

This is an intentionally flat development greybox, not approved final art. No combat, dodge, companion AI, Tripo models, rigs, campaign integration or durable saving is included. Physical gamepad hardware was not tested. The approximately 514 kB minified Three.js bundle still emits Vite's size advisory. Root hosting is supported; GitHub Pages project-subpath hosting is not. No full-game completion or release-performance claim is made.

The feature was committed with the personal workspace identity and pushed to `feat/first-pact-locomotion`. PR #3 is open; no merge was performed.
