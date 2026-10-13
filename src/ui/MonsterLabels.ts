import { Vector3, type Camera, type Object3D } from 'three';
import type { CombatSnapshot } from '../game/contracts.js';

interface LabelSlot {
  root: HTMLDivElement;
  name: HTMLSpanElement;
  /** "Boss" chip beside the name; hidden for regular monsters. */
  chip: HTMLSpanElement;
  health: HTMLDivElement;
  track: HTMLSpanElement;
  fill: HTMLSpanElement;
  value: HTMLSpanElement;
  actorId: string | undefined;
  vitality: number | undefined;
  maxVitality: number | undefined;
  boss: boolean;
}

/** Names follow actual native cast/head bones; no combat state lives in the DOM. */
export class MonsterLabels {
  readonly element = document.createElement('div');
  private readonly slots: LabelSlot[] = [];
  private readonly anchor = new Vector3();
  constructor(root: HTMLElement) {
    this.element.className = 'wc-monster-labels';
    for (let index = 0; index < 6; index++) {
      const root = document.createElement('div'), name = document.createElement('span'), chip = document.createElement('span');
      const health = document.createElement('div'), track = document.createElement('span');
      const fill = document.createElement('span'), value = document.createElement('span');
      root.className = 'wc-monster-label'; root.hidden = true;
      chip.className = 'wc-boss-chip'; chip.textContent = 'Boss'; chip.hidden = true;
      health.className = 'wc-monster-label__health';
      track.className = 'wc-monster-label__track'; track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0');
      fill.className = 'wc-monster-label__fill'; value.className = 'wc-monster-label__value';
      track.append(fill); health.append(track, value); root.append(name, chip, health); this.element.append(root);
      this.slots.push({ root, name, chip, health, track, fill, value, actorId: undefined, vitality: undefined, maxVitality: undefined, boss: false });
    }
    root.append(this.element);
  }
  update(snapshot: CombatSnapshot, camera: Camera, width: number, height: number, socket: (id: string) => Object3D | undefined): void {
    const monsters = snapshot.encounterStatus?.monsters ?? [];
    const player = snapshot.actors.find(actor => actor.id === 'aren');
    for (let index = 0; index < this.slots.length; index++) {
      const slot = this.slots[index]!, monster = monsters[index];
      const actor = monster && snapshot.actors.find(actor => actor.id === monster.id);
      const bone = monster && socket(monster.id);
      if (!actor?.visible || actor.downed || actor.allegiance !== 'hostile' || !bone || !player || Math.hypot(actor.position.x - player.position.x, actor.position.z - player.position.z) > 18) { slot.root.hidden = true; continue; }
      bone.getWorldPosition(this.anchor); this.anchor.y += 0.55; this.anchor.project(camera);
      slot.root.hidden = this.anchor.z < -1 || this.anchor.z > 1 || Math.abs(this.anchor.x) > 0.95 || Math.abs(this.anchor.y) > 0.92;
      if (slot.root.hidden) continue;
      if (slot.actorId !== actor.id) {
        slot.actorId = actor.id; slot.name.textContent = monster!.name;
        slot.track.setAttribute('aria-label', monster!.name + ' vitality');
        slot.vitality = slot.maxVitality = undefined;
      }
      const boss = monster!.boss === true || (snapshot.encounterStatus?.trial?.boss === true && monster!.active);
      if (slot.boss !== boss) { slot.boss = boss; slot.chip.hidden = !boss; slot.root.dataset.boss = String(boss); }
      const max = actor.maxVitality, vitality = actor.vitality;
      const valid = typeof max === 'number' && Number.isFinite(max) && max > 0 && typeof vitality === 'number' && Number.isFinite(vitality);
      slot.health.hidden = !valid;
      if (valid && (slot.vitality !== vitality || slot.maxVitality !== max)) {
        const remaining = Math.max(0, Math.min(max!, vitality!));
        slot.fill.style.width = `${remaining / max! * 100}%`;
        slot.track.setAttribute('aria-valuemax', String(max)); slot.track.setAttribute('aria-valuenow', String(remaining));
        slot.value.textContent = `${Math.ceil(remaining)} / ${Math.ceil(max!)}`;
        slot.vitality = vitality; slot.maxVitality = max;
      }
      slot.root.dataset.active = String(monster!.active);
      slot.root.style.transform = `translate(${(this.anchor.x + 1) * width / 2}px, ${(1 - this.anchor.y) * height / 2}px) translate(-50%, -100%)`;
    }
  }
  clear(): void { for (const slot of this.slots) slot.root.hidden = true; }
  dispose(): void { this.element.remove(); }
}
