# Isolated asset toolchain

Pinned checkouts and the isolated IMG2 home live outside the runtime workspace at /Users/nhonh/.local/share/wild-crown-img2. IMG2_HOME and the narrowly scoped HOME used for plugin registration are owner-only. No global IMG2 home, skill symlink, Tripo profile, or unrelated checkout was changed. Exact source versions and hashes are in toolchain/lock.json.

## Verified registration

- IMG2 base v2.0.0 tag: commit a669e9a97cea4452b1c2310c5cca6aa0f6657c1f.
- Character plugin v0.2.0 tag: commit 796dd9caf3f299958cf75b2294f54b37dc23ada9; official HEAD d8750638f9fc092714e7fcb4941053514455295d differs from the tag only in one task markdown file. It requires harness >=0.2.3.
- Official harness latest tag/current HEAD is version 0.2.3 (commit 7aa41b37ee24dde844390bb05eca76b709e91599). Jev requires >=0.2.5; no compatible official tag or HEAD exists, so Jev is not registered. Do not relabel or lower the requirement.
- Environment plugin v0.3.0 is an active dirty local snapshot at source commit 98ef8df746def242e06b0ab94dbd29bb7d6a79ab, not an official immutable tag; its working tree has uncommitted changes and no remote. It was copied read-only into the isolated home with archive SHA-256 bee2010f15fa3ee1581cbed04197158e955d055d8244ab4e87617ee02562544f. The isolated copy received Git metadata only so the harness could verify its existing _img2_local.py ignore rule; the active source was not modified.
- Isolated img2 doctor reports zero failures and two multi-capability warnings. Character edges glb→rig-reference and character-mesh→rigged-character, plus all three environment edges, answer. Jev remains unregistered.
- Tripo CLI 0.5.1 is on PATH; authenticated profile unchanged.

An initial isolated plugin-link attempt safely refused the foreign global ~/.claude/skills/img2-character symlink. Registration succeeded only with HOME=/Users/nhonh/.local/share/wild-crown-img2/user-home and IMG2_HOME=/Users/nhonh/.local/share/wild-crown-img2. The host detector created no host skill links. The HOME override is for registration isolation only; consent helpers use real HOME=/Users/nhonh and the same IMG2_HOME as the human grant flow.

## Consent and vegetation prerequisites

The operator selected both consent grants, but helper checks with the real user HOME still report environment host-image consent not granted and Jev consent absent/revoked. No grant was performed here. Recheck immediately before each dispatch. Only the human performs interactive grants. Never create consent records or change global permissions.

Environment require: IMG2_HOME=/Users/nhonh/.local/share/wild-crown-img2 python3 /Users/nhonh/Documents/personal/img2-plugins/plugin-environment/tools/environment_image_consent.py require /Users/nhonh/Documents/personal/wild-crown-worktrees/full-game

Jev require operation is require_consent in /Users/nhonh/Documents/personal/img2-plugins/plugin-jev/tools/jev_consent.py with the same real HOME, IMG2_HOME, and workspace. Jev consent is separate.

The active environment plugin explicitly says room is the only fixture-qualified scene kind; vegetation-cluster stays fail-closed until rights-reviewed, vegetation-specific fixtures and negative controls exist. No vegetation fixture is qualified by room evidence, no cast/room relabel is used, and no workspace image has been dispatched. R05 vegetation remains blocked pending applicable fixture/source approval and consent.

## Tripo tasks

Read tripo make --help, tripo ai --help, and tripo view --help before use. tripo make --dry-run plans and validates only; help states it prints selected model, completed parameters, and processing-chain steps with no upload, submission, or credit use. Run it for exact proposed inputs and documented flags before a paid task. --seed is documented for reproducible geometry and --then for processing; never invent parameters.

If the CLI watches a submitted task, --timeout must be at least 900 seconds. Do not use custom polling, --no-wait plus manual polling, or a shorter timeout. Never rerun a successful task. Known balance snapshot: 154515 credits, frozen 0; no automatic top-up or unbounded rerolls. Store provider task ID, model/version, input/output hashes and paths; never store credentials. No provider task was started.

## Native assets

Actors and props use native GLBs with immutable output paths public/assets/<assetId>/<outputHash>.glb and matching SHA-256; the manifest is revalidated and points to the current revision. No signed provider URLs or mutable stable GLB names. Region environments are composed recipes with explicit prop-* component IDs, not merged island GLBs; terrain, water, vegetation placement, fog, lighting, and collision remain procedural. LOD IDs remain empty until real derivatives exist; thresholds are proposed/unprofiled until P11 locked-hardware profiling.
