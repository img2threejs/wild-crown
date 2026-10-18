import { Vector3 } from 'three';
import type { FocusSource } from './CanopyKits';
import type { ImpactSink, KitSlot, MapKitFamily, SocketResolver } from './ElementKits';
import { PALETTE, type VfxElement } from './palette';
import type { VfxSystem } from './VfxSystem';
import type { BeamSlot } from './RibbonFx';

type Mode = 'charge' | 'voice' | 'claw' | 'fall' | 'slam' | 'tether' | 'combo' | 'counter' | 'evade' | 'suppression' | 'sky' | 'roots' | 'pounce' | 'rows' | 'shadow' | 'crown' | 'possession' | 'fruit' | 'spear' | 'net';
interface Recipe { readonly mode: Mode; readonly element: VfxElement; readonly weight: number }
const RECIPES = {
  'koro-fruit-burst': { mode: 'fruit', element: 'sap', weight: .65 },
  'ruun-track-charge': { mode: 'charge', element: 'ice', weight: .8 },
  'ruun-pack-call': { mode: 'voice', element: 'sap', weight: .85 },
  'ruun-claw-arc': { mode: 'claw', element: 'ice', weight: .55 },
  'ghor-hammering-charge': { mode: 'charge', element: 'earth', weight: 1.2 },
  'ghor-stonefall': { mode: 'fall', element: 'earth', weight: 1.15 },
  'ghor-overhead-slam': { mode: 'slam', element: 'earth', weight: 1.3 },
  'solkar-commanding-roar': { mode: 'voice', element: 'gold', weight: 1 },
  'solkar-pride-rush': { mode: 'pounce', element: 'fire', weight: .85 },
  'solkar-paw-slam': { mode: 'slam', element: 'gold', weight: .75 },
  'orun-root-tether': { mode: 'tether', element: 'heartroot', weight: .55 },
  'orun-staff-combo': { mode: 'combo', element: 'heartroot', weight: .45 },
  'orun-cartwheel-counter': { mode: 'counter', element: 'gold', weight: .6 },
  'orun-back-handspring': { mode: 'evade', element: 'wind', weight: .4 },
  'orun-dive-roll': { mode: 'evade', element: 'earth', weight: .35 },
  'orun-companion-suppression': { mode: 'suppression', element: 'umbral', weight: .85 },
  'orun-sky-aspect': { mode: 'sky', element: 'lightning', weight: .85 },
  'orun-sky-dive': { mode: 'pounce', element: 'wind', weight: .65 },
  'orun-canopy-root': { mode: 'roots', element: 'heartroot', weight: .65 },
  'orun-canopy-aspect': { mode: 'roots', element: 'heartroot', weight: 1.1 },
  'orun-fang-aspect': { mode: 'pounce', element: 'gold', weight: 1.1 },
  'orun-pack-aspect': { mode: 'rows', element: 'ice', weight: .8 },
  'orun-shadow-aspect': { mode: 'shadow', element: 'umbral', weight: .8 },
  'orun-crown-aspect': { mode: 'crown', element: 'fire', weight: 1.1 },
  'orun-root-surge': { mode: 'roots', element: 'heartroot', weight: .9 },
  'orun-crown-possession': { mode: 'possession', element: 'umbral', weight: .55 },
  'poacher-hunter-east-spear': { mode: 'spear', element: 'earth', weight: .3 },
  'poacher-hunter-spear': { mode: 'spear', element: 'earth', weight: .3 },
  'poacher-scout-net': { mode: 'net', element: 'earth', weight: .3 },
  'asha-protective-roar': { mode: 'voice', element: 'sap', weight: .9 },
  'nyra-shadow-ambush': { mode: 'pounce', element: 'umbral', weight: .65 },
} as const satisfies Readonly<Record<string, Recipe>>;
export type LateBossKitId = keyof typeof RECIPES;
export const LATE_BOSS_ATTACK_KITS: Readonly<Record<string, readonly [LateBossKitId, VfxElement]>> =
  Object.fromEntries(Object.entries(RECIPES).map(([id, recipe]) => [id, [id as LateBossKitId, recipe.element] as const]));
const BODY_ONLY_MODE = /^(combo|counter|evade|tether|possession|spear|net)$/;

/** Native-body accents are separate. This family draws only the authoritative hazard, never an inferred hit. */
class LateBossKits implements MapKitFamily {
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly nets = new WeakMap<KitSlot, BeamSlot[]>();
  constructor(private readonly vfx: VfxSystem, private readonly resolveSocket: SocketResolver | undefined, private impact: ImpactSink | undefined) {}
  owns(kit: string): boolean { return Object.hasOwn(RECIPES, kit); }
  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  begin(slot: KitSlot, seconds: number): void {
    const recipe = RECIPES[slot.kit as LateBossKitId], { mode, weight } = recipe, { cue, footprint: fp } = slot, vfx = this.vfx;
    if (cue.phase === 'anticipation' || cue.phase === 'commit') {
      if (slot.hasFootprint) slot.ground = vfx.ground.spawn('fill', fp, slot.element, slot.owner, vfx.time, 0);
      if (cue.phase === 'anticipation' && cue.actorId) this.impact?.flashActor(cue.actorId, PALETTE[slot.element].b, .55 + weight * .3, seconds, 'charge');
      if (cue.phase === 'commit' && mode === 'fall' && slot.hasFootprint) {
        // Ballistic rocks reach the mark at active onset, not an arbitrary time after the damage window.
        const flight = Math.max(1 / 60, seconds), height = 2.4;
        for (let i = 0; i < vfx.count(9); i++) {
          fp.sample(vfx.random(), vfx.random(), this.a, height, .72);
          vfx.debris.spawn(this.a.x, this.a.y, this.a.z, 0, -(height / flight - 4.9 * flight), 0, .1, flight + .22, vfx.time, slot.owner, PALETTE.earth.a, vfx.random());
        }
      }
      if (cue.phase === 'commit' && (mode === 'tether' || mode === 'possession' || mode === 'net')) {
        slot.beam = vfx.beams.acquire(slot.owner, vfx.time, 0, .1, .055, slot.element);
        this.driveBeam(slot, .7);
      }
      return;
    }
    if (cue.phase !== 'active' || !slot.hasFootprint) return;
    const surface = mode === 'rows' || mode === 'roots' || mode === 'shadow' || mode === 'suppression' || mode === 'crown';
    if (surface || !BODY_ONLY_MODE.test(mode)) slot.ground = vfx.ground.spawn(surface ? 'burn' : 'shock', fp, slot.element, slot.owner, vfx.time, 0);
    if (mode === 'net') {
      let beams = this.nets.get(slot);
      if (!beams) { beams = []; this.nets.set(slot, beams); }
      for (let axis = 0; axis < 2; axis++) for (let line = -1; line <= 1; line++) {
        const beam = vfx.beams.acquire(slot.owner, vfx.time, 0, .035, .02, slot.element);
        if (!beam) continue;
        fp.toWorld(axis === 0 ? -fp.halfWidth * .72 : line * fp.halfWidth * .6, axis === 0 ? line * fp.halfLength * .6 : -fp.halfLength * .72, beam.a, .06);
        fp.toWorld(axis === 0 ? fp.halfWidth * .72 : line * fp.halfWidth * .6, axis === 0 ? line * fp.halfLength * .6 : fp.halfLength * .72, beam.b, .06);
        beam.alpha = .6; beams.push(beam);
      }
    }
    if (mode === 'fall' || mode === 'slam') vfx.chunks(fp.cx, fp.cy + .03, fp.cz, Math.round(8 * weight), 2.5 + weight, .09, slot.owner, false, fp);
    if (mode === 'roots' || mode === 'suppression') {
      for (let i = 0; i < vfx.count(10 * weight); i++) { fp.sample(vfx.random(), vfx.random(), this.a, .04, .72); vfx.glow(this.a.x, this.a.y, this.a.z, .08, .3, slot.element, .35, slot.owner, .7); }
    }
    // The omitted Pack row stays empty: no radial dust, shock or drifting debris crosses its safe band.
    if (mode !== 'rows' && mode !== 'shadow' && mode !== 'combo' && mode !== 'spear' && mode !== 'evade' && mode !== 'tether' && mode !== 'possession' && mode !== 'net') {
      fp.sample(.5, .25, this.a, .06, .65);
      vfx.sparks(this.a.x, this.a.y, this.a.z, Math.round(5 * weight), 1.4, slot.element, slot.owner, .95);
    }
  }

  update(slot: KitSlot, _worldTick: number, dt: number, t: number): void {
    const recipe = RECIPES[slot.kit as LateBossKitId], { mode, weight } = recipe, vfx = this.vfx, fp = slot.footprint, phase = slot.cue.phase;
    if (slot.ground) vfx.ground.drive(slot.ground, phase === 'anticipation' ? .8 * t : phase === 'commit' ? .8 + .2 * t : t, .55 + .25 * weight, phase === 'active' ? Math.min(1, (1 - t) * 5) * .7 : .7);
    if (slot.beam) this.driveBeam(slot, Math.min(1, (1 - t) * 4) * .7);
    if (phase !== 'active' || !slot.hasFootprint || dt <= 0) return;
    const rate = mode === 'rows' ? 18 : mode === 'shadow' ? 9 : mode === 'roots' || mode === 'crown' ? 20 : 10;
    slot.acc[0] = (slot.acc[0] ?? 0) + dt * rate;
    const count = Math.min(12, Math.floor(slot.acc[0])); slot.acc[0] -= Math.floor(slot.acc[0]);
    for (let i = 0; i < vfx.count(count); i++) {
      fp.sample(vfx.random(), vfx.random(), this.a, .04, .72);
      if (mode === 'rows') {
        const size = Math.min(.06, Math.min(fp.halfWidth, fp.halfLength) * .1);
        vfx.glow(this.a.x, this.a.y, this.a.z, size, .18, slot.element, .35, slot.owner, .35);
      } else if (mode === 'shadow') {
        vfx.smoke(this.a.x, this.a.y, this.a.z, 1, .09, .25, .28, .45, PALETTE.umbral.a, .19, slot.owner, .1);
      } else if (mode === 'charge' || mode === 'pounce' || mode === 'evade') {
        this.a.y += .04; vfx.glow(this.a.x, this.a.y, this.a.z, .07, .18, slot.element, .24, slot.owner, .1);
      } else if (mode === 'voice' || mode === 'sky' || mode === 'crown') {
        vfx.glow(this.a.x, this.a.y + .1 + t * .35, this.a.z, .09, .25, slot.element, .3, slot.owner, .7 + weight * .3);
      } else if (mode === 'roots' || mode === 'suppression') {
        vfx.glow(this.a.x, this.a.y, this.a.z, .055 + weight * .025, .3, slot.element, .3, slot.owner, .8);
      } else if (mode === 'fruit') {
        vfx.debris.spawn(this.a.x, this.a.y + .4, this.a.z, 0, 1.2, 0, .07, .6, vfx.time, slot.owner, PALETTE.sap.a, vfx.random());
      } else {
        vfx.glow(this.a.x, this.a.y, this.a.z, .055, .16, slot.element, .2, slot.owner, .15);
      }
    }
    if (mode === 'voice' && slot.socket && Math.floor(t * 3) > slot.pulses) {
      slot.pulses = Math.floor(t * 3); slot.socket.getWorldPosition(this.a);
      vfx.glow(this.a.x, this.a.y, this.a.z, .16, .18, slot.element, .28, slot.owner);
    }
  }

  end(slot: KitSlot, _natural: boolean): void {
    if (slot.ground) { this.vfx.ground.release(slot.ground); slot.ground = undefined; }
    if (slot.beam) { this.vfx.beams.release(slot.beam); slot.beam = undefined; }
    const beams = this.nets.get(slot);
    if (beams) { for (const beam of beams) this.vfx.beams.release(beam); beams.length = 0; }
    slot.socket = undefined;
  }

  private driveBeam(slot: KitSlot, alpha: number): void {
    if (!slot.beam) return;
    const source = slot.socket ?? (slot.cue.actorId ? this.resolveSocket?.(slot.cue.actorId, 'root') : undefined);
    if (source) source.getWorldPosition(this.a); else this.a.copy(slot.origin);
    // The committed mark, not a homing beam attached to a victim who may have dodged the attack.
    this.b.copy(slot.target);
    slot.beam.a.copy(this.a); slot.beam.b.copy(this.b); slot.beam.alpha = alpha;
  }
}

export const createLateBossKits = (vfx: VfxSystem, resolveSocket: SocketResolver | undefined, impact: ImpactSink | undefined, _focus: FocusSource): MapKitFamily => new LateBossKits(vfx, resolveSocket, impact);
