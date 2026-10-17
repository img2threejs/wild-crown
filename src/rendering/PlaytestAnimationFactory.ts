import { AnimationClip, PropertyBinding, Quaternion, QuaternionKeyframeTrack, Vector3, type Object3D } from 'three';
import type { AssetManifestEntry } from '../game/contracts.js';

export interface PlaytestAnimationSet {
  clips: AnimationClip[];
  actionToClipMapping: Record<string, string>;
  rootMotion: Record<string, NonNullable<AssetManifestEntry['rootMotion']>[string]>;
}

export class PlaytestAnimationError extends Error {
  constructor(readonly assetId: string, message: string) {
    super(`Playtest animation for ${assetId}: ${message}`);
    this.name = 'PlaytestAnimationError';
  }
}

type MotionKind = 'idle' | 'locomotion' | 'run' | 'jump' | 'combat' | 'evasion';
interface RigAxes { right: Vector3; up: Vector3; forward: Vector3 }

/**
 * Builds in-memory, development-only motion for explicitly profiled blocked candidate rigs.
 * Manifests without a `playtestAnimation` profile (every native Tripo monster manifest) and rigs that
 * ship native clips always return `undefined`: procedural bone wiggle never runs for them.
 */
export function createPlaytestAnimationSet(
  root: Object3D,
  manifest: AssetManifestEntry,
  nativeClips: readonly AnimationClip[],
): PlaytestAnimationSet | undefined {
  const profile = manifest.playtestAnimation;
  if (!profile || nativeClips.length > 0) return undefined;
  root.updateMatrixWorld(true);
  const axes = rigAxes(root, manifest.id, profile);
  const actionToClipMapping: Record<string, string> = {};
  const rootMotion: Record<string, NonNullable<AssetManifestEntry['rootMotion']>[string]> = {};
  const clips: AnimationClip[] = [];
  const boneAliases: Record<string, string> = {};

  for (const actionId of profile.actionIds) {
    if (Object.hasOwn(manifest.actionToClipMapping, actionId)) continue;
    const clipName = `playtest:${manifest.id}:${actionId}`;
    const kind = motionKind(actionId);
    const { duration, tracks } = createTracks(root, manifest.id, profile, axes, actionId, kind, boneAliases);
    if (!tracks.length) throw new PlaytestAnimationError(manifest.id, `profile produced no motion tracks for '${actionId}'`);
    clips.push(new AnimationClip(clipName, duration, tracks));
    actionToClipMapping[actionId] = clipName;
    rootMotion[actionId] = { mode: 'in-place', evidenceStatus: 'verified' };
  }
  for (const [originalName, safeName] of Object.entries(boneAliases)) {
    const bone = root.getObjectByName(originalName);
    if (!bone) throw new PlaytestAnimationError(manifest.id, `rig bone '${originalName}' disappeared before track binding`);
    bone.name = safeName;
  }
  if (!clips.length) return undefined;

  return { clips, actionToClipMapping, rootMotion };
}

function motionKind(actionId: string): MotionKind {
  const id = actionId.toLowerCase();
  if (id.includes('idle')) return 'idle';
  if (id.includes('jump')) return 'jump';
  if (id.includes('run')) return 'run';
  if (/walk|strafe/.test(id)) return 'locomotion';
  if (/dodge|roll|cartwheel|slide|vault|handspring|ledge|landing|recovery|stumble/.test(id)) return 'evasion';
  return 'combat';
}

function rigAxes(
  root: Object3D,
  assetId: string,
  profile: NonNullable<AssetManifestEntry['playtestAnimation']>,
): RigAxes {
  requireBone(root, assetId, 'tripo::Root');
  const up = new Vector3(0, 1, 0);
  let forward: Vector3;

  if (profile.rigFamily === 'biped') {
    const arms = profile.armRootNames ?? [];
    if (arms.length !== 2) throw new PlaytestAnimationError(assetId, 'biped profile requires two arm roots');
    const right = requireBone(root, assetId, arms[0]!).getWorldPosition(new Vector3())
      .sub(requireBone(root, assetId, arms[1]!).getWorldPosition(new Vector3()))
      .projectOnPlane(up);
    if (right.lengthSq() < 1e-6) throw new PlaytestAnimationError(assetId, 'arm roots do not define a horizontal rig axis');
    right.normalize();
    forward = right.clone().cross(up).normalize();
    return { right, up, forward };
  }

  const torsoName = profile.torsoBoneNames?.[0];
  if (!torsoName || !profile.headBoneName) {
    throw new PlaytestAnimationError(assetId, `${profile.rigFamily} profile requires torso and head bones to derive rig axes`);
  }
  const torsoPosition = requireBone(root, assetId, torsoName).getWorldPosition(new Vector3());
  const head = requireBone(root, assetId, profile.headBoneName);
  const headPosition = head.getWorldPosition(new Vector3());
  forward = headPosition.sub(torsoPosition).projectOnPlane(up);
  if (forward.lengthSq() < 1e-6) {
    const headChild = head.children.find((child) => child.type === 'Bone');
    if (headChild) {
      forward = headChild.getWorldPosition(new Vector3()).sub(head.getWorldPosition(new Vector3())).projectOnPlane(up);
    }
  }
  if (forward.lengthSq() < 1e-6) throw new PlaytestAnimationError(assetId, 'torso and head do not define a horizontal rig axis');
  forward.normalize();
  const right = up.clone().cross(forward).normalize();
  return { right, up, forward };
}

function createTracks(
  root: Object3D,
  assetId: string,
  profile: NonNullable<AssetManifestEntry['playtestAnimation']>,
  axes: RigAxes,
  actionId: string,
  kind: MotionKind,
  boneAliases: Record<string, string>,
): { duration: number; tracks: QuaternionKeyframeTrack[] } {
  const duration = kind === 'idle' ? profile.rigFamily === 'avian' ? 0.8 : 2 : kind === 'locomotion' ? 0.9 : kind === 'run' ? 0.55 : 0.8;
  const fractions = kind === 'locomotion' || kind === 'run' ? [0, 0.25, 0.5, 0.75, 1] : kind === 'jump' ? [0, 0.22, 0.5, 0.78, 1] : kind === 'combat' ? [0, 0.32, 0.5, 0.68, 0.86, 1] : kind === 'evasion' ? [0, 0.3, 0.72, 1] : [0, 0.5, 1];
  const times = fractions.map((fraction) => fraction * duration);
  const tracks: QuaternionKeyframeTrack[] = [];
  const venom = /poison|venom|miasma/.test(actionId);
  const frost = /ice|frost/.test(actionId);
  const gale = /wind|gust|gale/.test(actionId);
  const elemental = venom || frost || gale || /fire|flame|ember|cinder/.test(actionId);
  const turning = gale || /sweep|tail|spin|roar|crown|dominion/.test(actionId.slice(actionId.indexOf(':') + 1));
  const combatEnvelope = venom ? [0, -0.25, -0.4, 0.75, 0.35, 0]
    : frost ? [0, -0.65, -0.45, 1, 0.08, 0]
    : gale ? [0, -0.5, 0.25, 1, -0.22, 0]
    : elemental ? [0, -0.55, -0.2, 1, 0.18, 0]
    : turning ? [0, -0.5, 0.25, 1, -0.22, 0] : [0, -0.35, -0.65, 1, 0.2, 0];
  const add = (name: string, axis: Vector3, amplitude: number, phase = 1, envelope = kind === 'combat' ? combatEnvelope : defaultEnvelope(kind)): void => {
    const bone = requireBone(root, assetId, name);
    const trackNodeName = safeTrackNodeName(root, assetId, bone, boneAliases);
    tracks.push(makeQuaternionTrack(bone, trackNodeName, axis, amplitude, phase, envelope, times));
  };

  if (profile.rigFamily === 'biped') {
    const arms = profile.armRootNames ?? [];
    const legs = profile.legRootNames ?? [];
    if (arms.length !== 2 || !profile.torsoBoneNames?.length) throw new PlaytestAnimationError(assetId, 'biped profile requires two arm roots and at least one torso bone');
    if (legs.length !== 0 && legs.length !== 2 || (kind === 'run' || kind === 'jump') && legs.length !== 2) {
      throw new PlaytestAnimationError(assetId, 'run and jump motions require exactly two declared leg roots');
    }
    const locomotion = kind === 'locomotion' || kind === 'run';
    const armAmplitude = kind === 'idle' ? 0.025 : locomotion ? kind === 'run' ? 0.46 : 0.34 : kind === 'jump' ? 0.62 : kind === 'evasion' ? 0.55 : 0.82;
    const armAxis = kind === 'combat' ? axes.up : kind === 'evasion' ? axes.forward : axes.right;
    const leadArm = actionId.includes('light-2') ? 1 : actionId.includes('light-1') ? 0 : -1;
    for (let index = 0; index < arms.length; index++) {
      const phase = kind === 'jump' ? 1 : index === 0 ? 1 : -1;
      const emphasis = kind === 'combat' && leadArm >= 0 ? index === leadArm ? 1 : 0.3 : phase;
      add(arms[index]!, armAxis, armAmplitude, emphasis);
    }
    const torsoAmplitude = kind === 'idle' ? 0.018 : locomotion ? 0.05 : kind === 'evasion' ? 0.16 : kind === 'jump' ? 0.12 : 0.24;
    for (let index = 0; index < profile.torsoBoneNames.length; index++) {
      add(profile.torsoBoneNames[index]!, kind === 'combat' && turning ? axes.up : axes.right, torsoAmplitude / (index + 1), index % 2 ? -1 : 1);
    }
    if (legs.length === 2 && (kind === 'locomotion' || kind === 'run' || kind === 'jump')) {
      const legAmplitude = kind === 'jump' ? 0.55 : kind === 'run' ? 0.62 : 0.38;
      for (let index = 0; index < legs.length; index++) {
        const phase = kind === 'jump' ? index === 0 ? 1 : -1 : index === 0 ? -1 : 1;
        add(legs[index]!, axes.right, legAmplitude, phase);
      }
    }
    if (profile.headBoneName) add(profile.headBoneName, axes.right, kind === 'idle' ? 0.025 : 0.06, -1);
  } else if (profile.rigFamily === 'avian') {
    const wings = profile.wingRootNames ?? [];
    if (wings.length !== 2) throw new PlaytestAnimationError(assetId, 'avian profile requires exactly two wing roots');
    const flap = kind === 'idle' ? 0.58 : kind === 'locomotion' ? 0.82 : kind === 'evasion' ? 0.9 : 1.08;
    for (let index = 0; index < wings.length; index++) add(wings[index]!, axes.forward, flap, index === 0 ? 1 : -1);
    for (let index = 0; index < (profile.wingSecondaryBoneNames ?? []).length; index++) {
      add(profile.wingSecondaryBoneNames![index]!, axes.forward, flap * 0.28, index % 2 ? -1 : 1);
    }
    for (const name of profile.torsoBoneNames ?? []) add(name, turning ? axes.up : axes.right, kind === 'combat' ? 0.24 : 0.025, 1);
    if (profile.headBoneName) add(profile.headBoneName, axes.right, kind === 'idle' ? 0.04 : 0.1, -1);
  } else {
    const limbs = profile.limbRootNames ?? [];
    if (limbs.length !== 4) throw new PlaytestAnimationError(assetId, 'quadruped profile requires exactly four limb roots');
    const attackPose = kind === 'combat' && actionId.startsWith('wild-crown:');
    const forwardAttack = /charge|pounce|snap/.test(actionId.toLowerCase());
    const gait = kind === 'idle' ? 0.035 : kind === 'locomotion' ? 0.34 : kind === 'evasion' ? 0.16 : attackPose ? elemental ? 0.3 : 0.72 : 0.12;
    for (let index = 0; index < limbs.length; index++) {
      const phase = attackPose
        ? index < 2
          ? forwardAttack ? 1 : -1
          : forwardAttack ? -0.65 : 0.65
        : index % 2 ? -1 : 1;
      add(limbs[index]!, axes.right, gait, phase);
    }
    const torsoAmplitude = kind === 'idle' ? 0.025 : attackPose ? elemental ? 0.24 : 0.42 : 0.05;
    for (const name of profile.torsoBoneNames ?? []) add(name, turning ? axes.up : axes.right, torsoAmplitude, attackPose && !forwardAttack ? -1 : 1);
    if (profile.headBoneName) add(profile.headBoneName, axes.right, kind === 'idle' ? 0.045 : attackPose ? elemental ? 0.72 : 0.62 : 0.1, attackPose && !forwardAttack && !venom && !frost ? 1 : -1);
  }

  return { duration, tracks };
}

function defaultEnvelope(kind: MotionKind): number[] {
  if (kind === 'locomotion' || kind === 'run') return [0, 1, 0, -1, 0];
  if (kind === 'jump') return [0, 0.8, 1, 0.4, 0];
  if (kind === 'evasion') return [0, 0.45, -1, 0];
  return [0, 1, 0];
}

function safeTrackNodeName(root: Object3D, assetId: string, bone: Object3D, aliases: Record<string, string>): string {
  const trackNodeName = PropertyBinding.sanitizeNodeName(bone.name);
  if (trackNodeName === bone.name) return trackNodeName;
  const existing = root.getObjectByName(trackNodeName);
  if (existing && existing !== bone) throw new PlaytestAnimationError(assetId, `bone '${bone.name}' sanitizes to ambiguous track node '${trackNodeName}'`);
  for (const [originalName, existingAlias] of Object.entries(aliases)) {
    if (existingAlias === trackNodeName && originalName !== bone.name) throw new PlaytestAnimationError(assetId, `bones '${originalName}' and '${bone.name}' share track node '${trackNodeName}'`);
  }
  aliases[bone.name] = trackNodeName;
  return trackNodeName;
}

function makeQuaternionTrack(
  bone: Object3D,
  trackNodeName: string,
  worldAxis: Vector3,
  amplitude: number,
  phase: number,
  envelope: readonly number[],
  times: readonly number[],
): QuaternionKeyframeTrack {
  const localAxis = worldAxis.clone().applyQuaternion(bone.getWorldQuaternion(new Quaternion()).invert()).normalize();
  const values: number[] = [];
  for (const value of envelope) {
    const rotation = bone.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(localAxis, value * amplitude * phase));
    values.push(rotation.x, rotation.y, rotation.z, rotation.w);
  }
  return new QuaternionKeyframeTrack(`${trackNodeName}.quaternion`, [...times], values);
}

function requireBone(root: Object3D, assetId: string, name: string): Object3D {
  const named = root.getObjectByName(name);
  if (named && 'isBone' in named && named.isBone === true) return named;
  const sanitizedName = PropertyBinding.sanitizeNodeName(name);
  const sanitized = sanitizedName === name ? undefined : root.getObjectByName(sanitizedName);
  if (sanitized && 'isBone' in sanitized && sanitized.isBone === true) return sanitized;
  throw new PlaytestAnimationError(assetId, `required rig bone '${name}' is missing`);
}
