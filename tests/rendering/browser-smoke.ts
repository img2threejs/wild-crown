import { AnimationClip, Bone, Box3, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack, WebGLRenderTarget, type Object3D } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { ActorSnapshot, AssetManifestEntry, CombatSnapshot, EnvironmentRecipeDefinition, RegionColliderDefinition, RegionDefinition, RegionEntityDefinition } from '../../src/game/contracts';
import { GameRenderer, mountCompanionPreview } from '../../src/rendering/GameRenderer';
import { NativeAssetLoader, NativeAssetError } from '../../src/rendering/NativeAssetLoader';
import { ScreenSpaceLOD } from '../../src/rendering/ScreenSpaceLOD';
import { AnimationController } from '../../src/rendering/AnimationController';

const status = document.querySelector<HTMLElement>('#test-status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const results: string[] = [];
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); results.push(`PASS ${message}`); }

async function run(): Promise<void> {
  const fixture = await createTestSkinnedGlb();
  const alternate = await createTestSkinnedGlb(0x659dc8);
  const character = {
    id: 'test-character', sourceType: 'native-glb', kind: 'character', runtimeUrl: fixture.url, outputHash: fixture.outputHash,
    lodIds: [], rigFamily: 'test-rig', requiredActionIds: ['wild-crown:actor-idle', 'attack'], actionToClipMapping: { 'wild-crown:actor-idle': 'Idle', attack: 'Strike' }, sockets: ['hips'],
    coordinateTransform: { forward: { x: 0, y: 0, z: 1 }, scale: 1 },
    contacts: [{ actionId: 'attack', markerId: 'fixture:contact-1', normalizedTime: 0.7, evidenceStatus: 'verified' }],
    rootMotion: { 'wild-crown:actor-idle': { mode: 'in-place', evidenceStatus: 'verified' }, attack: { mode: 'native-root-motion', rootNodeName: 'hips', evidenceStatus: 'verified', curveSamples: [{ time: 0, position: { x: 0, y: 0, z: 0 } }, { time: 1, position: { x: 0.1, y: 0, z: 0 } }] } },
  } as unknown as AssetManifestEntry;
  let fetchCount = 0;
  const loader = new NativeAssetLoader({ maxCachedAssets: 2, onProgress: () => { fetchCount++; } });
  const aliasUrl = URL.createObjectURL(await (await fetch(fixture.url)).blob());
  const aliasManifest = { ...character, runtimeUrl: aliasUrl } as AssetManifestEntry;
  const [first, second, aliasInstance] = await Promise.all([loader.load(character), loader.load(character), loader.load(aliasManifest)]);
  aliasInstance.dispose();
  assert(fetchCount === 1, 'overlapping requests for one immutable native GLB share a fetch across equivalent runtime URLs');
  const firstMesh = findSkinnedMesh(first.root);
  const secondMesh = findSkinnedMesh(second.root);
  assert(firstMesh.skeleton !== secondMesh.skeleton, 'each GLB instance owns a separate Skeleton');
  assert(firstMesh.skeleton.bones[0] !== secondMesh.skeleton.bones[0], 'each GLB instance owns separate Bone objects');
  assert(firstMesh.skeleton.boneInverses[0] !== secondMesh.skeleton.boneInverses[0], 'inverse bind matrices are cloned per instance');
  firstMesh.skeleton.bones[0]!.position.y = 0.7;
  assert(secondMesh.skeleton.bones[0]!.position.y !== 0.7, 'animating one cloned rig does not move another');

  const animation = first.animation;
  animation.play('wild-crown:actor-idle', 'idle', 0.25);
  const sampledIdleTime = animation.activeTime!;
  animation.update(0.5);
  assert(animation.activeTime === sampledIdleTime, 'mixer delta advances fades without advancing snapshot-sampled action time');
  assert(animation.activeDuration === 2 && Math.abs(firstMesh.skeleton.bones[0]!.position.y - 0.05) < 1e-6, 'loaded two-second idle clip keeps its normalized sample while mixer fades reach full weight');
  animation.play('attack', 'active', 0.7);
  const sampledAttackTime = animation.activeTime!;
  assert(close(firstMesh.skeleton.bones[0]!.position.x, 0), 'verified native root-motion curve is consumed; x=' + firstMesh.skeleton.bones[0]!.position.x + ', t=' + animation.activeTime);
  animation.update(1.2);
  assert(animation.activeTime === sampledAttackTime, 'clamped one-shot time remains under authoritative snapshot control');
  assert(animation.activeContactMarkers.some((marker) => marker.markerId === 'fixture:contact-1'), 'active native clip exposes only its authored contact markers');
  assert(animation.activeRootMotionMetadata?.mode === 'native-root-motion', 'active clip exposes its authored root-motion policy');
  animation.play('attack', 'active', 0.4);
  assert(Math.abs(animation.activeTime! - sampledAttackTime * (0.4 / 0.7)) < 0.01, 'repeated one-shot action resamples authoritative progress');
  animation.play('wild-crown:actor-idle', 'idle', 0.8);
  assert(animation.activeActionId === 'wild-crown:actor-idle' && animation.activeContactMarkers.length === 0, 'interrupt returns to canonical actor idle and clears unrelated contact markers');
  animation.update(0.001);
  assert(animation.activeTime !== undefined, 'mixer updates preserve sampled action state');
  let missingActionFailed = false;
  try { animation.play('not-authored', 'active'); } catch (error) { missingActionFailed = error instanceof Error && error.name === 'AnimationBindingError'; }
  assert(missingActionFailed, 'missing clip fails visibly instead of choosing another action');
  let requiredClipFailed = false;
  const incompleteManifest = { ...character, actionToClipMapping: { 'wild-crown:actor-idle': 'Idle', attack: 'Missing' } } as AssetManifestEntry;
  const incomplete = new AnimationController(first.root, [], incompleteManifest);
  try { incomplete.play('attack', 'active'); } catch (error) { requiredClipFailed = error instanceof Error && error.name === 'AnimationBindingError'; }
  assert(requiredClipFailed && incomplete.issues.some((issue) => issue.actionId === 'attack'), 'a required action whose exact native clip is absent fails closed');
  incomplete.dispose();

  const retiredMesh = findSkinnedMesh(first.root);
  let retiredGeometryDisposed = 0;
  retiredMesh.geometry.addEventListener('dispose', () => { retiredGeometryDisposed++; });
  const revision = { ...character, runtimeUrl: alternate.url, outputHash: alternate.outputHash } as AssetManifestEntry;
  const replacement = await loader.load(revision);
  first.dispose();
  assert(retiredGeometryDisposed === 0, 'replacing a revision preserves old resources while another instance still leases them');
  second.dispose();
  assert(Number(retiredGeometryDisposed) === 1, 'the retired revision releases geometry after its last lease');
  assert(replacement.root.children.length > 0 && loader.cachedAssetIds.includes(character.id), 'new immutable revision remains independently cached after old leases release');
  let badHashRejected = false;
  try { await loader.load({ ...revision, outputHash: '0'.repeat(64) } as AssetManifestEntry); }
  catch (error) { badHashRejected = error instanceof NativeAssetError && error.message.includes('SHA-256 mismatch'); }
  assert(badHashRejected, 'fetched native GLB bytes are hash-checked before parsing');
  const externalFixture = await createExternalUriGlb(fixture.url);
  let externalDependencyRejected = false;
  try { await loader.load({ ...character, id: 'external-dependency', runtimeUrl: externalFixture.url, outputHash: externalFixture.outputHash } as AssetManifestEntry); }
  catch (error) { externalDependencyRejected = error instanceof NativeAssetError && error.message.includes('external dependency'); }
  assert(externalDependencyRejected, 'native GLB with an external image dependency is rejected before parse');
  URL.revokeObjectURL(externalFixture.url);
  replacement.dispose();
  loader.dispose();

  const capacityLoader = new NativeAssetLoader({ maxCachedAssets: 1 });
  const capacityFirst = await capacityLoader.load(character);
  capacityFirst.dispose();
  const capacitySecond = await capacityLoader.load({ ...character, id: 'test-character-capacity' } as AssetManifestEntry);
  capacitySecond.dispose();
  assert(capacityLoader.cachedAssetIds.length === 1 && capacityLoader.cachedAssetIds[0] === 'test-character-capacity', 'least-recently-used unleased native template is evicted at capacity');
  capacityLoader.dispose();

  const lodLevels = [0, 1, 2].map((level) => ({ assetId: `fixture-lod-${level}`, root: new Group(), instanceCount: 1, lodIds: [], updateOcclusion: () => {}, dispose: () => {} }));
  const lod = new ScreenSpaceLOD(lodLevels as never, [{ position: { x: 0, y: 0, z: 0 } }], 2, { transitionPixels: [100, 50], hysteresisRatio: 0.1 });
  const lodCamera = new PerspectiveCamera(60, 1, 0.1, 100);
  lodCamera.updateProjectionMatrix();
  lodCamera.position.set(0, 0, 40);
  lod.update(lodCamera, new Vector3(0, 0, 0), 600);
  assert(lod.debugState.selectedLevel === 2, 'projected screen size selects the coarsest available verified derivative');
  lodCamera.position.set(0, 0, 31);
  lod.update(lodCamera, new Vector3(0, 0, 0), 600);
  assert(lod.debugState.selectedLevel === 2, 'LOD hysteresis prevents rapid oscillation at the transition boundary');
  lodCamera.position.set(0, 0, 8);
  lod.update(lodCamera, new Vector3(0, 0, 0), 600);
  assert(Number(lod.debugState.selectedLevel) === 0, 'near screen size restores the highest-detail available level');
  lod.dispose();

  const recipe = {
    id: 'fixture-environment', sourceType: 'composed-recipe', proceduralRecipeId: 'fixture-environment', componentAssetIds: [],
    kind: 'environment', lodIds: [], requiredActionIds: [], actionToClipMapping: {}, sockets: [],
  } as unknown as AssetManifestEntry;
  const recipeDefinition: EnvironmentRecipeDefinition = { id: 'fixture-environment', regionId: 'greenwake', restorationFacts: { partial: 'restore:partial', restored: 'restore:restored' }, proceduralLayers: ['terrain', 'water', 'vegetation', 'fog', 'lighting', 'collision'], assetPlacementIds: [], groundSurfaceIds: ['ground', 'raised-walkway'] };
  const renderer = new GameRenderer({ canvas });
  const region = fixtureRegion();
  await renderer.loadRegion(region, [recipe], recipeDefinition);
  const actor = fixtureActor();
  const combat: CombatSnapshot = {
    actors: [actor], movableObjects: [], worldClock: { simulationTick: 30, worldTick: 7.5, worldTimeSeconds: 0.125, timeScale: 0.25, policy: 'perfect-dodge-slow' },
    player: { vitality: 1, maxVitality: 1, instinct: 0, dodgeCharges: 0, maxDodgeCharges: 0 },
    telegraphs: [{ id: 'warning', attackId: 'test' as never, sourceId: 'aren', targetPosition: { x: 0, y: 0, z: -2 }, phase: 'anticipation', remainingTicks: 4 }],
    hazards: [], events: [],
  };
  renderer.sync([actor], combat, 1 / 60);
  const evidence = renderer.capture();
  assert(evidence.regionId === 'greenwake', 'composed environment recipe commits with a region scene');
  assert(evidence.surfaceCount === 2 && evidence.colliderCount === 1, 'authored ground surfaces and camera collider are retained');
  const walkway = renderer.scene.getObjectByName('surface:raised-walkway') as Mesh | undefined;
  assert(walkway?.geometry.getAttribute('position').getY(0) === 3.5 && walkway.geometry.getAttribute('normal').getY(0) > 0, 'authored surface vertices stay absolute and fan winding faces the visible world side');
  assert(evidence.camera.telegraphLocked, 'camera director enters telegraph framing lock');
  assert(evidence.missingActorAssets.includes('aren'), 'unmapped player instance is reported by canonical archetype instead of an inferred asset ID');
  const basisA = renderer.getInputBasis();
  const basisB = renderer.getInputBasis();
  assert(basisA.forward === basisB.forward && basisA.right === basisB.right, 'input basis reuses frame scratch vectors');

  const groundMaterial = (walkway as Mesh & { material: { color: { clone: () => Color; equals: (other: Color) => boolean } } })?.material;
  const originalColor = groundMaterial?.color.clone();
  const baselineHex = originalColor ? originalColor.getHexString() : null;
  renderer.syncWorldFacts({ 'restore:partial': true, 'restore:restored': false });
  const partialWalkway = renderer.scene.getObjectByName('surface:raised-walkway') as Mesh | undefined;
  const partialMaterial = (partialWalkway as Mesh & { material: { color: Color } })?.material;
  assert(partialMaterial && partialMaterial.color.getHexString() !== baselineHex,
    'partial restoration fact retints authored surface material');
  const partialHex = partialMaterial?.color.getHexString();
  renderer.syncWorldFacts({ 'restore:partial': false, 'restore:restored': true });
  const restoredWalkway = renderer.scene.getObjectByName('surface:raised-walkway') as Mesh | undefined;
  const restoredMaterial = (restoredWalkway as Mesh & { material: { color: Color } })?.material;
  const restoredHex = restoredMaterial?.color.getHexString();
  assert(restoredMaterial && restoredHex !== baselineHex,
    'restored fact retints authored surface material');
  assert(restoredHex !== partialHex,
    'restored and partial tints use different authored tints');
  renderer.syncWorldFacts({ 'restore:partial': false, 'restore:restored': false });
  const neutralWalkway = renderer.scene.getObjectByName('surface:raised-walkway') as Mesh | undefined;
  const neutralMaterial = (neutralWalkway as Mesh & { material: { color: Color } })?.material;
  assert(neutralMaterial && neutralMaterial.color.getHexString() === baselineHex,
    'cleared restoration facts restore authored surface color');
  const clockCharacter = {
    ...character,
    requiredActionIds: [...character.requiredActionIds, 'clock-strike'],
    actionToClipMapping: { ...character.actionToClipMapping, 'clock-strike': 'ClockStrike' },
    rootMotion: { ...character.rootMotion, 'clock-strike': { mode: 'in-place', evidenceStatus: 'verified' } },
  } as AssetManifestEntry;
  const arenManifest = { ...clockCharacter, id: 'actor-aren', actorId: 'aren' } as AssetManifestEntry;
  const arenPlacement: RegionEntityDefinition = { id: 'aren', actorId: 'aren', kind: 'actor', assetId: 'actor-aren', position: { x: 0, y: 0, z: 0 }, placement: 'ground' };
  const clockHunterManifest = { ...clockCharacter, id: 'actor-clock-hunter', actorId: 'poacher-hunter' } as AssetManifestEntry;
  const clockHunterPlacement: RegionEntityDefinition = { id: 'clock-hunter', actorId: 'poacher-hunter', kind: 'actor', assetId: clockHunterManifest.id, position: { x: 2, y: 0, z: 0 }, placement: 'ground' };
  const clockHunter: ActorSnapshot = { ...actor, id: 'clock-hunter' as never, archetypeId: 'poacher-hunter' as never, allegiance: 'hostile', position: clockHunterPlacement.position };
  const clockActors = [actor, clockHunter];
  const clockCombat: CombatSnapshot = { ...combat, actors: clockActors, telegraphs: [] };
  await renderer.loadRegion(fixtureRegion([], [], undefined, [arenPlacement, clockHunterPlacement]), [recipe, arenManifest, clockHunterManifest], recipeDefinition);
  // Finish the 0.12s presentation fade with snapshot clocks held fixed before inspecting native bone samples.
  renderer.sync(clockActors, clockCombat, 0.2);
  const playerHips = renderer.resolveSocket('aren', 'hips');
  const hostileHips = renderer.resolveSocket('clock-hunter', 'hips');
  assert(playerHips && hostileHips, 'production renderer loads both synthetic native actor rigs for clock-domain sampling');
  const playerLoopSample = playerHips.position.y;
  const hostileLoopSample = hostileHips.position.y;
  assert(Math.abs(playerLoopSample - 0.05) < 1e-6, 'player loop clip samples simulation time during world slow-motion');
  assert(Math.abs(hostileLoopSample - 0.0125) < 1e-6 && Math.abs(playerLoopSample - hostileLoopSample * 4) < 1e-6, 'hostile and player native loop samples use distinct clock domains at world scale 0.25');
  renderer.sync(clockActors, clockCombat, 0.9);
  assert(playerHips.position.y === playerLoopSample && hostileHips.position.y === hostileLoopSample, 'unchanged authoritative clocks keep native loop samples fixed across different render deltas');
  const wrappedCombat: CombatSnapshot = { ...clockCombat, worldClock: { ...combat.worldClock, simulationTick: 150, worldTick: 37.5, worldTimeSeconds: 0.625 } };
  renderer.sync(clockActors, wrappedCombat, 1 / 60);
  assert(Math.abs(playerHips.position.y - 0.05) < 1e-6 && Math.abs(hostileHips.position.y - 0.0625) < 1e-6, 'native loops wrap actor-clock seconds by their loaded two-second duration, not a one-second normalized period');
  const clockStrikes: ActorSnapshot[] = clockActors.map((snapshot) => ({ ...snapshot, actionId: 'clock-strike' as never, phase: 'active', normalizedTime: 0.25 }));
  const strikeCombat: CombatSnapshot = { ...wrappedCombat, actors: clockStrikes };
  renderer.sync(clockStrikes, strikeCombat, 0.5);
  assert(Math.abs(playerHips.position.y - 0.05) < 1e-6 && Math.abs(hostileHips.position.y - 0.05) < 1e-6, 'player and hostile one-shot clips use normalized snapshot progress instead of either loop clock');
  const progressedStrikes: ActorSnapshot[] = clockStrikes.map((snapshot) => ({ ...snapshot, normalizedTime: snapshot.allegiance === 'player' ? 0.75 : 0.375 }));
  const progressedCombat: CombatSnapshot = { ...strikeCombat, actors: progressedStrikes };
  renderer.sync(progressedStrikes, progressedCombat, 1 / 60);
  assert(Math.abs(playerHips.position.y - 0.15) < 1e-6 && Math.abs(hostileHips.position.y - 0.075) < 1e-6, 'native one-shot samples follow each actor normalized progress even when both clock values are unchanged');
  const playerStrikeSample = playerHips.position.y;
  const hostileStrikeSample = hostileHips.position.y;
  renderer.sync(progressedStrikes, progressedCombat, 1);
  assert(playerHips.position.y === playerStrikeSample && hostileHips.position.y === hostileStrikeSample, 'renderer delta cannot advance snapshot-sampled player or hostile one-shots');
  const finishedStrikes: ActorSnapshot[] = clockStrikes.map((snapshot) => ({ ...snapshot, normalizedTime: 1 }));
  renderer.sync(finishedStrikes, { ...strikeCombat, actors: finishedStrikes }, 1 / 60);
  assert(Math.abs(playerHips.position.y - 0.2) < 1e-6 && Math.abs(hostileHips.position.y - 0.2) < 1e-6, 'finite native clips retain their normalized endpoint instead of wrapping like loops');
  const hunterManifest = { ...character, id: 'actor-poacher-hunter', actorId: 'poacher-hunter' } as AssetManifestEntry;
  const scoutManifest = { ...character, id: 'actor-poacher-scout', actorId: 'poacher-scout' } as AssetManifestEntry;
  const hunterPlacements: RegionEntityDefinition[] = [
    { id: 'hunter-melee-west', actorId: 'poacher-hunter', kind: 'actor', assetId: 'actor-poacher-hunter', position: { x: -2, y: 0, z: -1 }, placement: 'ground' },
    { id: 'hunter-melee-east', actorId: 'poacher-hunter', kind: 'actor', assetId: 'actor-poacher-hunter', position: { x: 2, y: 0, z: -1 }, placement: 'ground' },
    { id: 'hunter-ranged', actorId: 'poacher-scout', kind: 'actor', assetId: 'actor-poacher-scout', position: { x: 0, y: 0, z: -3 }, placement: 'ground' },
  ];
  await renderer.loadRegion(fixtureRegion([], [], undefined, hunterPlacements), [recipe, hunterManifest, scoutManifest], recipeDefinition);
  const hunterWest: ActorSnapshot = { ...fixtureActor(), id: 'hunter-melee-west' as never, archetypeId: 'poacher-hunter' as never, allegiance: 'hostile', position: { x: -2, y: 0, z: -1 } };
  const hunterEast: ActorSnapshot = { ...hunterWest, id: 'hunter-melee-east' as never, position: { x: 2, y: 0, z: -1 } };
  const hunterRanged: ActorSnapshot = { ...hunterWest, id: 'hunter-ranged' as never, archetypeId: 'poacher-scout' as never, position: { x: 0, y: 0, z: -3 } };
  const hunters = [hunterWest, hunterEast, hunterRanged];
  const huntersCombat = { ...combat, actors: hunters, telegraphs: [] };
  renderer.sync(hunters, huntersCombat, 0.2);
  const placedActors = new Map<string, Object3D>();
  renderer.scene.traverse((node) => { if (typeof node.userData.actorInstanceId === 'string') placedActors.set(node.userData.actorInstanceId, node); });
  const westRig = placedActors.get('hunter-melee-west');
  const eastRig = placedActors.get('hunter-melee-east');
  const rangedRig = placedActors.get('hunter-ranged');
  assert(westRig && eastRig && rangedRig && westRig !== eastRig && findSkinnedMesh(westRig).skeleton !== findSkinnedMesh(eastRig).skeleton && findSkinnedMesh(eastRig).skeleton !== findSkinnedMesh(rangedRig).skeleton, 'two camp melee instances share actor-poacher-hunter while all three placed actors keep independent skeletons');
  assert(renderer.capture().actorCount === 3, 'renderer retains all camp runtime instance IDs without archetype-key overwrite');
  const enemyLoopSample = findSkinnedMesh(westRig!).skeleton.bones[0]!.position.y;
  assert(Math.abs(enemyLoopSample - 0.0125) < 1e-6, 'hostile loop clip remains sampled on scaled world time');
  const horizontalCollider: RegionColliderDefinition = { id: 'horizontal', kind: 'capsule', from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 10 }, radius: 0.5, blocksMovement: true, blocksCamera: true };
  await renderer.loadRegion(fixtureRegion([], [horizontalCollider]), [recipe], recipeDefinition);
  let colliderMesh = renderer.scene.getObjectByName('camera-collider:horizontal') as Mesh;
  let colliderBox = new Box3().setFromObject(colliderMesh);
  assert(close(colliderBox.min.x, -0.5) && close(colliderBox.max.x, 0.5) && close(colliderBox.min.y, -0.5) && close(colliderBox.max.y, 0.5) && close(colliderBox.min.z, -0.5) && close(colliderBox.max.z, 10.5), 'horizontal capsule bounds match endpoint centers plus caps');
  const verticalCollider: RegionColliderDefinition = { ...horizontalCollider, id: 'vertical', to: { x: 0, y: 10, z: 0 } };
  await renderer.loadRegion(fixtureRegion([], [verticalCollider]), [recipe], recipeDefinition);
  colliderMesh = renderer.scene.getObjectByName('camera-collider:vertical') as Mesh;
  colliderBox = new Box3().setFromObject(colliderMesh);
  assert(close(colliderBox.min.x, -0.5) && close(colliderBox.max.x, 0.5) && close(colliderBox.min.y, -0.5) && close(colliderBox.max.y, 10.5) && close(colliderBox.min.z, -0.5) && close(colliderBox.max.z, 0.5), 'vertical capsule bounds orient along Y without axis drift');
  const diagonalCollider: RegionColliderDefinition = { ...horizontalCollider, id: 'diagonal', to: { x: 3, y: 4, z: 0 } };
  await renderer.loadRegion(fixtureRegion([], [diagonalCollider]), [recipe], recipeDefinition);
  colliderMesh = renderer.scene.getObjectByName('camera-collider:diagonal') as Mesh;
  colliderBox = new Box3().setFromObject(colliderMesh);
  assert(close(colliderBox.min.x, -0.5) && close(colliderBox.max.x, 3.5) && close(colliderBox.min.y, -0.5) && close(colliderBox.max.y, 4.5) && close(colliderBox.min.z, -0.5) && close(colliderBox.max.z, 0.5), 'diagonal capsule bounds preserve both endpoint coordinates and radius');

  const collisionCollider: RegionColliderDefinition = { id: 'camera-collision', kind: 'capsule', from: { x: 0, y: 3, z: 4 }, to: { x: 0, y: 3, z: 8 }, radius: 0.8, blocksMovement: true, blocksCamera: true };
  const cameraRegion = fixtureRegion([], [collisionCollider], { position: { x: 0, y: 5, z: 10 }, lookAt: { x: 0, y: 1, z: 0 } });
  await renderer.loadRegion(cameraRegion, [recipe], recipeDefinition);
  const lockedCamera = { ...combat, telegraphs: [] };
  for (let frame = 0; frame < 60; frame++) renderer.sync([actor], lockedCamera, 1 / 60);
  const cameraTarget = new Vector3(0, 1.15, 0);
  assert(renderer.camera.position.distanceTo(cameraTarget) < Math.hypot(4, 10), 'camera raycast collides with and retracts from the authored capsule');
  const previewHost = document.createElement('div');
  previewHost.style.width = '240px'; previewHost.style.height = '240px';
  document.body.append(previewHost);
  const previewManifest = { ...character, id: 'actor-preview-test', actorId: 'preview-test', requiredActionIds: [...character.requiredActionIds, 'preview-test:idle'], actionToClipMapping: { ...character.actionToClipMapping, 'preview-test:idle': 'PreviewIdle' }, rootMotion: { ...character.rootMotion, 'preview-test:idle': { mode: 'in-place', evidenceStatus: 'verified' } } } as AssetManifestEntry;
  const previewOptions = { idleActionId: 'preview-test:idle' as never, loader: renderer.assetLoader };
  const livePreview = await mountCompanionPreview(previewHost, 'preview-test', [previewManifest], previewOptions);
  const previewTime0 = livePreview.actionTime ?? 0;
  livePreview.update(0.25);
  const previewTime1 = livePreview.actionTime ?? 0;
  livePreview.update(0.25);
  const previewTime2 = livePreview.actionTime ?? 0;
  assert(previewTime1 > previewTime0 && previewTime2 > previewTime1, 'successful native preview advances its explicitly mapped idle pose when the app ticks its handle');
  let missingPreviewActionFailed = false;
  try { await mountCompanionPreview(previewHost, 'preview-test', [previewManifest], { ...previewOptions, idleActionId: 'missing-idle' as never }); }
  catch (error) { missingPreviewActionFailed = error instanceof Error && error.message.includes('no explicitly required native idle action'); }
  assert(missingPreviewActionFailed, 'preview refuses an absent idle ActionId without choosing a fallback clip');
  livePreview.dispose();
  livePreview.dispose();
  assert(previewHost.childElementCount === 0, 'native preview disposer releases the mounted canvas idempotently');
  previewHost.remove();

  const detachedPreviewHost = document.createElement('div');
  document.body.append(detachedPreviewHost);
  const stalePreview = mountCompanionPreview(detachedPreviewHost, 'preview-test', [previewManifest], previewOptions);
  detachedPreviewHost.remove();
  let stalePreviewCancelled = false;
  try { await stalePreview; }
  catch (error) { stalePreviewCancelled = error instanceof Error && error.message.includes('host detached'); }
  assert(stalePreviewCancelled && detachedPreviewHost.childElementCount === 0, 'native preview completion after host detachment releases its instance and rejects as stale');
  const staticFixture = await createTestStaticGlb();
  const delayedProp = { id: 'prop-stale-load', sourceType: 'native-glb', kind: 'prop', runtimeUrl: staticFixture.url, outputHash: staticFixture.outputHash, lodIds: [], requiredActionIds: [], actionToClipMapping: {}, sockets: [] } as unknown as AssetManifestEntry;
  const stalePlacement = { id: 'stale-placement', assetId: delayedProp.id, position: { x: 1, y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, placement: 'ground' } as const;
  const staleRegion = fixtureRegion([stalePlacement], [{ id: 'stale-collider', kind: 'box', from: { x: 0, y: 1, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 }, blocksMovement: true, blocksCamera: true }]);
  const staleRecipe = { ...recipe, componentAssetIds: [delayedProp.id] } as AssetManifestEntry;
  const staleRecipeDefinition = { ...recipeDefinition, assetPlacementIds: [stalePlacement.id] };
  const originalFetch = globalThis.fetch;
  let signalFetchStarted = () => {};
  const fetchStarted = new Promise<void>((resolve) => { signalFetchStarted = resolve; });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== staticFixture.url) return originalFetch(input, init);
    signalFetchStarted();
    return new Promise<Response>((resolve, reject) => window.setTimeout(() => { originalFetch(input, init).then(resolve, reject); }, 60));
  }) as typeof fetch;
  let staleRegionRejected = false;
  try {
    const staleLoad = renderer.loadRegion(staleRegion, [staleRecipe, delayedProp], staleRecipeDefinition).then(() => false, () => true);
    await fetchStarted;
    await renderer.loadRegion(fixtureRegion([], []), [recipe], recipeDefinition);
    staleRegionRejected = await staleLoad;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(staleRegionRejected && renderer.capture().propCount === 0 && renderer.capture().colliderCount === 0, 'newer scene commits while a stale native GLB region load is in flight and the stale completion cannot replace it');
  const movablePropManifest = { id: 'prop-broken-snare', sourceType: 'native-glb', kind: 'prop', runtimeUrl: staticFixture.url, outputHash: staticFixture.outputHash, lodIds: [], requiredActionIds: [], actionToClipMapping: {}, sockets: [] } as unknown as AssetManifestEntry;
  const movablePlacement = { id: 'camp-loose-snare', assetId: movablePropManifest.id, position: { x: -2, y: 0, z: 9 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, placement: 'ground' } as const;
  const movableDefinition: RegionDefinition['movableObjects'][number] = { id: 'camp-loose-snare', assetId: movablePropManifest.id, from: { x: -2, y: 0, z: 9 }, to: { x: -2, y: 0, z: 5 }, supportSurfaceId: 'ground', radiusMeters: 0.5, animationTicks: 24, requiredCompanionId: 'koro', koroInteractionId: 'koro-drop-object', playerInteractionId: 'player-drop-object', movedFactId: 'objectMoved:camp-loose-snare', requiredFacts: [], effect: { kind: 'distraction', targetActorInstanceId: 'hunter-ranged', radiusMeters: 4, interruptRangedWindupTicks: 24 } };
  const movableRegion = fixtureRegion([movablePlacement], [], undefined, [], [movableDefinition]);
  const movableRecipe = { ...recipe, componentAssetIds: [movablePropManifest.id] } as AssetManifestEntry;
  const movableRecipeDefinition = { ...recipeDefinition, assetPlacementIds: [movablePlacement.id] };
  await renderer.loadRegion(movableRegion, [movableRecipe, movablePropManifest], movableRecipeDefinition);
  const movableRoot = renderer.scene.getObjectByName('movable-prop:camp-loose-snare') as Group | undefined;
  const countMovableRoots = () => { let count = 0; renderer.scene.traverse((node) => { if (node.userData.movableObjectId === movableDefinition.id) count++; }); return count; };
  assert(movableRoot && close(movableRoot.position.x, -2) && close(movableRoot.position.z, 9) && countMovableRoots() === 1 && !renderer.scene.getObjectByName('prop-broken-snare:instances'), 'movable snare starts at its authored origin as one exact native prop outside static instancing');
  const movementCombat: CombatSnapshot = { ...combat, actors: [], telegraphs: [], movableObjects: [{ objectId: movableDefinition.id, phase: 'in-flight', position: { x: -2, y: 0, z: 7 } }] };
  renderer.sync([], movementCombat, 1 / 60);
  assert(movableRoot && close(movableRoot.position.x, -2) && close(movableRoot.position.y, 0) && close(movableRoot.position.z, 7) && movableRoot.visible && countMovableRoots() === 1, 'in-flight native prop uses the exact fixed-step Core snapshot pose without a renderer tween or duplicate');
  renderer.sync([], { ...movementCombat, movableObjects: [{ objectId: movableDefinition.id, phase: 'settled', position: movableDefinition.to }] }, 1 / 60);
  assert(movableRoot && close(movableRoot.position.z, 5) && !movableRoot.visible && countMovableRoots() === 1, 'settled prop stays hidden at its exact destination while the durable movedFactId is uncommitted');
  renderer.syncWorldFacts({ [movableDefinition.movedFactId]: false });
  assert(movableRoot && close(movableRoot.position.z, 5) && !movableRoot.visible, 'unrelated or failed durable fact synchronization does not reveal or reset an uncommitted landing');
  renderer.syncWorldFacts({ [movableDefinition.movedFactId]: true });
  assert(movableRoot && close(movableRoot.position.z, 5) && movableRoot.visible, 'durable movedFactId reveals the same prop at its committed destination');
  await renderer.loadRegion(movableRegion, [movableRecipe, movablePropManifest], movableRecipeDefinition);
  const reloadedMovableRoot = renderer.scene.getObjectByName('movable-prop:camp-loose-snare') as Group | undefined;
  assert(reloadedMovableRoot && close(reloadedMovableRoot.position.z, 5) && reloadedMovableRoot.visible && countMovableRoots() === 1, 'region reload seeds one visible snare at the committed destination from movedFactId');
  const propManifest = {
    id: 'prop-occlusion-fixture', sourceType: 'native-glb', kind: 'prop', runtimeUrl: staticFixture.url,
    outputHash: staticFixture.outputHash, lodIds: [], requiredActionIds: [], actionToClipMapping: {}, sockets: [],
  } as unknown as AssetManifestEntry;
  let disposedTextureCount = 0;
  const batch = await renderer.assetLoader.loadStaticBatch(propManifest, [{ id: 'fade-probe', assetId: propManifest.id, position: { x: 0, y: 0, z: 2 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, placement: 'ground' }]);
  batch.root.traverse((node) => {
    if (!(node as Mesh).isMesh) return;
    for (const material of Array.isArray((node as Mesh).material) ? (node as Mesh).material as MeshBasicMaterial[] : [(node as Mesh).material as MeshBasicMaterial]) {
      material.map?.addEventListener('dispose', () => { disposedTextureCount++; });
    }
  });
  const fadeScene = new Scene();
  fadeScene.background = new Color(0x000000);
  fadeScene.add(batch.root);
  const fadeCamera = new PerspectiveCamera(50, 1, 0.1, 20);
  fadeCamera.position.set(0, 0, 5);
  fadeCamera.lookAt(0, 0, 0);
  fadeCamera.updateMatrixWorld(true);
  const target = new WebGLRenderTarget(32, 32);
  const pixel = new Uint8Array(4);
  renderer.renderer.setRenderTarget(target);
  batch.updateOcclusion(fadeCamera, new Vector3(0, 0, 0));
  renderer.renderer.render(fadeScene, fadeCamera);
  renderer.renderer.readRenderTargetPixels(target, 16, 16, 1, 1, pixel);
  const fadedRed = pixel[0]!;
  batch.updateOcclusion(fadeCamera, new Vector3(10, 0, 0));
  renderer.renderer.render(fadeScene, fadeCamera);
  renderer.renderer.readRenderTargetPixels(target, 16, 16, 1, 1, pixel);
  const opaqueRed = pixel[0]!;
  renderer.renderer.setRenderTarget(null);
  target.dispose();
  batch.dispose();
  assert(fadedRed > 5 && fadedRed < opaqueRed * 0.6, `rendered occlusion shader attenuates framebuffer color (${fadedRed} < ${opaqueRed})`);

  const broken = fixtureRegion([{ id: 'greenwake-placement-0', assetId: 'prop-not-in-manifest', position: { x: 1, y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, placement: 'ground' }]);
  const brokenRecipe = { ...recipe, componentAssetIds: ['prop-not-in-manifest'] } as AssetManifestEntry;
  const brokenRecipeDefinition = { ...recipeDefinition, assetPlacementIds: ['greenwake-placement-0'] };
  let rejected = false;
  try { await renderer.loadRegion(broken, [brokenRecipe], brokenRecipeDefinition); } catch { rejected = true; }
  assert(rejected, 'missing native prop rejects region staging');
  assert(renderer.capture().regionId === 'greenwake', 'failed region staging preserves the previous valid scene');
  assert(renderer.capture().assetErrors.length === 1, 'failed asset load remains visible in renderer debug evidence');
  renderer.dispose();
  assert(Number(disposedTextureCount) === 1, 'native template eviction disposes its unique embedded texture once');
  renderer.dispose();
  URL.revokeObjectURL(aliasUrl);
  URL.revokeObjectURL(fixture.url);
  URL.revokeObjectURL(alternate.url);
  URL.revokeObjectURL(staticFixture.url);
  status.textContent = results.join('\n');
  document.documentElement.dataset.testResult = 'pass';
}

function fixtureRegion(
  props: RegionDefinition['props'] = [],
  colliders: readonly RegionColliderDefinition[] = [{ id: 'camera-wall', kind: 'box', from: { x: 0, y: 1.5, z: -4 }, halfExtents: { x: 2, y: 1.5, z: 0.25 }, blocksMovement: true, blocksCamera: true }],
  cameraAnchor: { position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } } = { position: { x: 5, y: 5, z: 8 }, lookAt: { x: 0, y: 1, z: 0 } },
  entities: readonly RegionEntityDefinition[] = [],
  movableObjects: RegionDefinition['movableObjects'] = [],
): RegionDefinition {
  return {
    id: 'greenwake', authoringStatus: 'in-progress', name: 'Renderer fixture', biome: 'forest', environmentRecipeId: 'fixture-environment', props, movableObjects,
    bounds: { min: { x: -12, y: -2, z: -12 }, max: { x: 12, y: 8, z: 12 } },
    ground: {
      y: 0, profile: 'flat', navGraphId: 'fixture-nav',
      surfaces: [
        { id: 'ground', profile: 'plane', points: [{ x: -10, y: 0, z: -10 }, { x: 10, y: 0, z: -10 }, { x: 10, y: 0, z: 10 }, { x: -10, y: 0, z: 10 }], elevation: 0, walkable: true, material: 'grass', colliderId: 'floor' },
        { id: 'raised-walkway', profile: 'canopy', points: [{ x: -3, y: 3.5, z: -2 }, { x: 3, y: 3.5, z: -2 }, { x: 3, y: 3.5, z: 2 }, { x: -3, y: 3.5, z: 2 }], elevation: 3.5, walkable: true, material: 'wood', colliderId: 'platform' },
      ],
      colliders,
    },
    navigation: { nodes: [], ribbons: [] }, cameraAnchors: [{ id: 'three-quarter', position: cameraAnchor.position, lookAt: cameraAnchor.lookAt, mode: 'exploration' }],
    entrances: [], exits: [], traversalArcs: [], entities, encounterIds: [], encounterParticipants: {}, restorationStates: [], assetIds: ['fixture-environment', ...props.map((placement) => placement.assetId), ...entities.flatMap((entity) => entity.assetId ? [entity.assetId] : [])],
  };
}

function fixtureActor(): ActorSnapshot {
  return { id: 'aren', archetypeId: 'aren' as never, species: 'human', allegiance: 'player', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: -1 }, actionId: 'wild-crown:actor-idle' as never, phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false };
}
function findSkinnedMesh(root: Object3D): SkinnedMesh {
  let result: SkinnedMesh | undefined;
  root.traverse((node) => { if ((node as SkinnedMesh).isSkinnedMesh) result = node as SkinnedMesh; });
  if (!result) throw new Error('Exported test fixture did not contain a skinned mesh.');
  return result;
}
function close(a: number, b: number): boolean { return Math.abs(a - b) < 0.02; }
async function hash(bytes: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join(''); }
async function createExternalUriGlb(url: string): Promise<{ url: string; outputHash: string }> {
  const source = await (await fetch(url)).arrayBuffer();
  const sourceView = new DataView(source);
  const jsonLength = sourceView.getUint32(12, true);
  if (sourceView.getUint32(16, true) !== 0x4e4f534a) throw new Error('Native GLB fixture does not begin with a JSON chunk.');
  const documentValue = JSON.parse(new TextDecoder().decode(new Uint8Array(source, 20, jsonLength)).replace(/[\u0000\s]+$/g, '')) as { images?: unknown[] };
  documentValue.images = [...(documentValue.images ?? []), { uri: 'https://example.invalid/external.png' }];
  const jsonBytes = new TextEncoder().encode(JSON.stringify(documentValue));
  const paddedJsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const binaryTail = new Uint8Array(source, 20 + jsonLength);
  const bytes = new Uint8Array(20 + paddedJsonLength + binaryTail.byteLength);
  bytes.set(new Uint8Array(source, 0, 12), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, paddedJsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + paddedJsonLength);
  bytes.set(jsonBytes, 20);
  bytes.set(binaryTail, 20 + paddedJsonLength);
  return { url: URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' })), outputHash: await hash(bytes.buffer) };
}
async function createTestSkinnedGlb(color = 0x9fc887): Promise<{ url: string; outputHash: string }> {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.4, 0, 0, 0.4, 0, 0, 0, 1, 0]), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
  geometry.setIndex([0, 1, 2]);
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial({ color, skinning: true } as never));
  mesh.name = 'test-body';
  const hips = new Bone();
  hips.name = 'hips';
  mesh.add(hips);
  mesh.bind(new Skeleton([hips]));
  const root = new Group();
  root.add(mesh);
  // Synthetic test motion only: a known two-second clip with linear y = 0.1 * sampleSeconds.
  const idle = new AnimationClip('Idle', 2, [new VectorKeyframeTrack('hips.position', [0, 2], [0, 0, 0, 0, 0.2, 0])]);
  const strike = new AnimationClip('Strike', 1, [new VectorKeyframeTrack('hips.position', [0, 1], [0, 0, 0, 0.1, 0, 0])]);
  const clockStrike = new AnimationClip('ClockStrike', 2, [new VectorKeyframeTrack('hips.position', [0, 2], [0, 0, 0, 0, 0.2, 0])]);
  const previewIdle = new AnimationClip('PreviewIdle', 1, [new VectorKeyframeTrack('hips.position', [0, 1], [0, 0, 0, 0, 0, 0.1])]);
  const binary = await new GLTFExporter().parseAsync(root, { binary: true, animations: [idle, strike, clockStrike, previewIdle] }) as ArrayBuffer;
  return { url: URL.createObjectURL(new Blob([binary], { type: 'model/gltf-binary' })), outputHash: await hash(binary) };
}
async function createTestStaticGlb(): Promise<{ url: string; outputHash: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = 2; canvas.height = 2;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, 2, 2);
  const texture = new CanvasTexture(canvas);
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(2, 2, 0.3), new MeshBasicMaterial({ map: texture, color: 0xffffff })));
  const binary = await new GLTFExporter().parseAsync(root, { binary: true }) as ArrayBuffer;
  return { url: URL.createObjectURL(new Blob([binary], { type: 'model/gltf-binary' })), outputHash: await hash(binary) };
}

void run().catch((error: unknown) => {
  if (status) status.textContent = 'FAIL ' + (error instanceof Error ? error.stack ?? error.message : String(error));
  document.documentElement.dataset.testResult = 'fail';
  throw error;
});
