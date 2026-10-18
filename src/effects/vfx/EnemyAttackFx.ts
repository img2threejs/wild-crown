import { Group, Vector3, type Object3D } from 'three';
import type { ActorSnapshot } from '../../game/contracts';
import { enemyAttackPresentation, enemyAttackPresentationForId, enemyAttackTime, type EnemyAttackPresentation } from '../../rendering/EnemyAttackPresentation';
import type { StoryCue } from '../story-cues';
import { BladeTrailFx } from './BladeTrailFx';
import { enemyAttackKit, type SocketResolver } from './ElementKits';
import type { VfxElement } from './palette';
import type { VfxSystem } from './VfxSystem';

const CAPACITY = 16;
// Same reserved signed-32-bit owner range convention as ACTOR_VFX_OWNER; never shares a cue's owner.
const OWNER_BASE = 0x7ffe0000;
const INTERRUPTS = /^(stagger|knockback|knockdown|launch|stun|getup)$/;
const RIBBON = /charge|rush|claw|sweep|lash|rake|tail|pounce|lunge|dive|leap|slam|smash|vault|combo|counter|handspring|spear/;
interface AttackSlot {
  readonly trails: readonly [BladeTrailFx, BladeTrailFx];
  readonly owner: number;
  readonly scopes: Set<string>;
  readonly bases: [Object3D | undefined, Object3D | undefined];
  readonly tips: [Object3D | undefined, Object3D | undefined];
  actorId: string | undefined;
  actionId: string;
  root: Object3D | undefined;
  element: VfxElement;
  phase: ActorSnapshot['attackPhase'];
  progress: number;
  lastEmissionTick: number;
  seen: number;
  cancelled: boolean;
}

/** Cosmetic anatomy only. No inferred impacts, root displacement, hit windows or second animation clock. */
export class EnemyAttackFx {
  readonly group = new Group();
  private readonly slots: AttackSlot[] = [];
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private frame = 0;
  private drops = 0;
  private missing = 0;
  private worldTick = 0;

  constructor(private readonly vfx: VfxSystem, private readonly resolveSocket: SocketResolver | undefined, private readonly resolveRoot: ((id: string) => Object3D | undefined) | undefined) {
    this.group.name = 'enemy-native-attack-fx';
    for (let index = 0; index < CAPACITY; index++) {
      const first = new BladeTrailFx(), second = new BladeTrailFx();
      first.mesh.name = `enemy-attack-${index}-right`; second.mesh.name = `enemy-attack-${index}-left`;
      this.group.add(first.mesh, second.mesh);
      this.slots.push({ trails: [first, second], owner: OWNER_BASE + index, scopes: new Set(), bases: [undefined, undefined], tips: [undefined, undefined], actorId: undefined, actionId: '', root: undefined, element: 'earth', phase: undefined, progress: 0, lastEmissionTick: -Infinity, seen: 0, cancelled: false });
    }
    vfx.group.add(this.group);
  }

  /** Consumed after skeleton evaluation, in simulation order; a Pack cast may have several scopes on one body. */
  consume(cue: StoryCue): void {
    if (!cue.actorId || !cue.attackId || cue.phase === 'hit' || !cue.scopeId) return;
    const spec = enemyAttackPresentationForId(cue.attackId);
    if (!spec) return;
    const root = this.resolveRoot?.(cue.actorId) ?? this.resolveSocket?.(cue.actorId, 'root');
    if (!root) return;
    const actionId = `wild-crown:${cue.attackId}`;
    const slot = this.findSlot(cue.actorId);
    if (!slot) { this.drops++; return; }
    const newCast = slot.actorId !== cue.actorId || slot.actionId !== actionId || cue.phase === 'anticipation' && (slot.phase !== 'windup' || slot.cancelled);
    if (newCast || slot.root !== root) this.bind(slot, cue.actorId, actionId, root, spec, !newCast);
    slot.scopes.add(cue.scopeId);
    if (cue.phase === 'anticipation') { slot.cancelled = false; slot.phase = 'windup'; }
  }

  /** Call only after the renderer has evaluated the current native pose, including variant and attached weapon transforms. */
  update(actors: readonly ActorSnapshot[], worldTick: number): void {
    this.worldTick = worldTick; this.frame++;
    const time = worldTick / 60;
    for (const actor of actors) {
      if (!actor.visible || actor.downed || !actor.attackPhase || INTERRUPTS.test(actor.reaction?.kind ?? '')) continue;
      const spec = enemyAttackPresentation(actor.actionId);
      if (!spec) continue;
      const root = this.resolveRoot?.(actor.id) ?? this.resolveSocket?.(actor.id, 'root');
      if (!root || !root.visible) continue;
      const slot = this.findSlot(actor.id);
      // Snapshots pose a cue-owned cast; they cannot recreate a cancelled or never-consumed cast.
      if (!slot || slot.actorId !== actor.id) continue;
      slot.seen = this.frame;
      if (slot.cancelled) continue;
      if (slot.actionId !== actor.actionId) { this.release(slot); continue; }
      const progress = enemyAttackTime(actor.attackPhase, actor.attackPhaseProgress ?? 0);
      if (slot.root !== root || progress + 1e-6 < slot.progress) this.bind(slot, actor.id, actor.actionId, root, spec, true);
      slot.progress = progress; slot.phase = actor.attackPhase;
      const ribbon = !this.vfx.reducedEffects && RIBBON.test(spec.motion) && progress >= .3 && progress < .86;
      for (let side = 0; side < 2; side++) {
        const base = slot.bases[side], tip = slot.tips[side], trail = slot.trails[side]!;
        if (!base || !tip) continue;
        base.getWorldPosition(this.a); tip.getWorldPosition(this.b);
        if (ribbon) trail.push(this.a.x, this.a.y, this.a.z, this.b.x, this.b.y, this.b.z, time, actor.attackPhase === 'windup' ? .2 : .55);
        if (side === 0 && worldTick - slot.lastEmissionTick >= (actor.attackPhase === 'windup' ? 6 : 3)) {
          slot.lastEmissionTick = worldTick;
          // Small attached breath/charge motes, not a bright disc that hides the mesh or a fake contact burst on a miss.
          this.vfx.glow(this.b.x, this.b.y, this.b.z, actor.attackPhase === 'windup' ? .075 : .105, .14, slot.element, .24, slot.owner, .06);
        }
      }
    }
    for (const slot of this.slots) {
      if (slot.actorId !== undefined && slot.seen !== this.frame) this.release(slot);
      for (const trail of slot.trails) trail.update(time);
    }
  }

  cancelScope(scopeId: string): void {
    for (const slot of this.slots) if (slot.scopes.delete(scopeId) && slot.scopes.size === 0) { this.clearVisuals(slot); slot.cancelled = true; }
  }

  clear(): void {
    for (const slot of this.slots) { this.clearVisuals(slot); slot.scopes.clear(); slot.cancelled = true; }
  }

  dispose(): void {
    for (const slot of this.slots) { this.release(slot); for (const trail of slot.trails) trail.dispose(); }
    this.group.removeFromParent();
  }

  get diagnostics(): { capacity: number; activeActors: number; visibleTrails: number; droppedCosmeticActors: number; missingNativeAnchors: number; sampledWorldTick: number } {
    let activeActors = 0, visibleTrails = 0;
    for (const slot of this.slots) { if (slot.actorId !== undefined && !slot.cancelled) activeActors++; for (const trail of slot.trails) if (trail.mesh.visible) visibleTrails++; }
    return { capacity: CAPACITY, activeActors, visibleTrails, droppedCosmeticActors: this.drops, missingNativeAnchors: this.missing, sampledWorldTick: this.worldTick };
  }

  private findSlot(actorId: string): AttackSlot | undefined {
    let free: AttackSlot | undefined;
    for (const slot of this.slots) {
      if (slot.actorId === actorId) return slot;
      if (slot.actorId === undefined && free === undefined) free = slot;
    }
    return free;
  }

  private bind(slot: AttackSlot, actorId: string, actionId: string, root: Object3D, spec: EnemyAttackPresentation, preserveScopes = false): void {
    this.clearVisuals(slot); if (!preserveScopes) slot.scopes.clear();
    slot.actorId = actorId; slot.actionId = actionId; slot.root = root; slot.progress = 0; slot.phase = undefined; slot.cancelled = false; slot.lastEmissionTick = -Infinity;
    const kit = enemyAttackKit(actionId.slice('wild-crown:'.length));
    if (!kit) throw new Error(`Enemy attack has no authored effect kit: ${actionId}`);
    slot.element = kit[1];
    for (let side = 0; side < 2; side++) { slot.bases[side] = undefined; slot.tips[side] = undefined; slot.trails[side]!.setStyle(slot.element, .5, .12, .7); }
    const weaponTip = spec.socket.startsWith('weapon-') ? this.resolveSocket?.(actorId, 'weapon-tip') : undefined;
    const weaponBase = weaponTip ? this.resolveSocket?.(actorId, 'weapon-base') : undefined;
    if (weaponTip && weaponBase) { slot.bases[0] = weaponBase; slot.tips[0] = weaponTip; }
    else this.bindPair(slot, 0, spec.socket);
    if (spec.socket === 'paws' || spec.socket === 'hands' || spec.socket === 'wings') {
      this.bindPair(slot, 0, spec.socket === 'paws' ? 'paw-right' : 'hand-right');
      this.bindPair(slot, 1, spec.socket === 'paws' ? 'paw-left' : 'hand-left');
    }
    if (!slot.bases[0] || !slot.tips[0]) { this.missing++; throw new Error(`Missing actual native anatomy for ${actorId}/${actionId}/${spec.socket}`); }
  }

  private bindPair(slot: AttackSlot, side: number, semantic: string): void {
    slot.bases[side] = this.resolveSocket?.(slot.actorId!, `enemy:${semantic}:base`);
    slot.tips[side] = this.resolveSocket?.(slot.actorId!, `enemy:${semantic}:tip`);
  }

  private clearVisuals(slot: AttackSlot): void { for (const trail of slot.trails) trail.clear(); this.vfx.particles.killOwner(slot.owner); }
  private release(slot: AttackSlot): void { this.clearVisuals(slot); slot.scopes.clear(); slot.actorId = undefined; slot.root = undefined; slot.bases[0] = slot.bases[1] = slot.tips[0] = slot.tips[1] = undefined; }
}
