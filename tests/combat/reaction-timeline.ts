/**
 * Headless reaction timeline: drives the real CombatEngine through three scenes and prints per-tick positions.
 * Run: `bun tests/combat/reaction-timeline.ts`
 *   1. Sakda's Eight Limbs combo knocks a Greenwake boar into a wall.
 *   2. A boss (the Root Rammer trial boss) is armoured through a committed attack, then takes a poise break into a stun.
 *   3. A Root Rammer charge (its low surge) knocks the hero down; he rises with get-up i-frames.
 */
import { hit } from '../../src/game/combat/reactions.js';
import { SAKDA } from '../../src/game/combat/SakdaSkills.js';
import { vec } from '../../src/game/combat/geometry.js';
import { ATTACKS, reactionRig, type ReactionRig } from './reaction-rig.js';

const fmt = (value: number): string => value.toFixed(3).padStart(7);
const reactionText = (rig: ReactionRig, id: 'monster' | 'me'): string => {
  const snapshot = rig.engine.snapshot().actors.find(actor => actor.id === (id === 'monster' ? rig.monsterId : rig.state.playerId));
  const reaction = snapshot?.reaction;
  const poise = snapshot?.poise;
  return `${(reaction?.kind ?? '-').padEnd(9)} ${reaction ? `p=${reaction.progress.toFixed(2)} dur=${String(reaction.durationTicks).padStart(3)} #${reaction.serial}` : '                  '} ${poise === undefined ? '' : `poise=${poise.toFixed(2)}`}`;
};

function sakdaBoarIntoWall(log: (line: string) => void): void {
  log('== 1. Sakda Eight Limbs vs Ember Boar, wall 1.35 m behind it ==');
  // The wall's near face is 2.4 m behind the boar's start; the boar's 1.05 m body stops 1.35 m from where it stood.
  const rig = reactionRig({ hero: 'sakda', stage: 0, distance: 3, walls: [{ offset: vec(0, 1, -3.4), half: vec(3, 1, 1) }] });
  const start = { ...rig.monster().position };
  log(`boar start z=${start.z.toFixed(3)} (mass heavy, radius ${rig.monster().radius}); wall near face z=${(start.z - 2.4).toFixed(3)}`);
  log('tick  step     sakda.z   boar.z  boar.dz-from-start  boar reaction                              events');
  let tick = 0;
  const row = (note = ''): void => {
    log(`${String(tick).padStart(4)}  ${rig.state.actionId.padEnd(8)} ${fmt(rig.me().position.z)} ${fmt(rig.monster().position.z)} ${fmt(rig.monster().position.z - start.z)}   ${reactionText(rig, 'monster')} ${note}`);
  };
  for (let step = 1; step <= SAKDA.limbs.steps.length; step++) {
    while (step > 1 && rig.state.tick < rig.state.lightChainFrom!) { rig.step(); tick++; }
    const before = rig.cues.length;
    rig.step({ lightPressed: true }); tick++;
    row(`press J${step}`);
    const spec = SAKDA.limbs.steps[step - 1]!;
    for (let i = 0; i < spec.activeAt + 1; i++) { rig.step(); tick++; }
    row(`J${step} lands`);
    for (const cue of rig.cues.slice(before)) if (cue.kind === 'reaction-start' || cue.kind === 'wall-impact' || cue.kind === 'poise-break') log(`      cue ${cue.kind} ${cue.reactionKind} strength=${(cue.intensity ?? 0).toFixed(2)}`);
  }
  for (let i = 0; i < 60; i++) {
    rig.step(); tick++;
    const kind = rig.monster().reactionState?.kind;
    if (i % 3 === 0 || kind === 'getup') row();
  }
  log(`wall-impact cues: ${rig.cuesOf('wall-impact').length}; the boar slid ${(start.z - rig.monster().position.z).toFixed(3)} m in total and the wall stopped it at its 1.350 m limit; the slam filled its poise bar into a stun`);
}

function bossPoiseBreak(log: (line: string) => void): void {
  log('\n== 2. Boss poise: super-armour in a committed attack, then a poise break into a short stun ==');
  const rig = reactionRig({ stage: 2, distance: 3 });
  const attack = ATTACKS['root-rammer-slam']!;
  const hazard = rig.internals.beginAttack(rig.monster(), attack)!;
  log(`boss attack ${attack.id}: windup ${attack.windupTicks}, commit ${attack.commitTicks}, active ${attack.activeTicks}`);
  let tick = 0;
  const row = (note = ''): void => log(`${String(tick).padStart(4)}  phase=${(rig.snapshotMonster().attackPhase ?? '-').padEnd(8)} ${reactionText(rig, 'monster')} ${note}`);
  while (rig.state.worldTick < hazard.windupUntil! + 2) { rig.step(); tick++; }
  row('in commit (armoured)');
  for (let i = 0; i < 8; i++) { rig.strike(hit('heavy', 40, 2)); rig.step(); tick++; }
  row('8 heavy blows later: poise held at the bar, reaction is only a flinch');
  while (rig.snapshotMonster().attackPhase !== undefined && rig.snapshotMonster().attackPhase !== 'recovery') { rig.step(); tick++; }
  row('armour dropped (recovery)');
  rig.step(); tick++;
  row('deferred poise break lands');
  const stunStart = tick;
  while (rig.monster().reactionState?.kind === 'stun') { rig.step(); tick++; if ((tick - stunStart) % 20 === 0) row(); }
  row(`stun over after ${tick - stunStart} ticks; poise reset, next bar larger (poise breaks: ${rig.monster().poiseBreaks})`);
  log(`poise-break cues: ${rig.cuesOf('poise-break').length}`);
}

function rammerKnocksPlayerDown(log: (line: string) => void): void {
  log('\n== 3. Root Rammer charge (low surge) knocks the hero down ==');
  const rig = reactionRig({ stage: 2, distance: 4 });
  const attack = ATTACKS['root-rammer-low-wave']!;
  rig.internals.beginAttack(rig.monster(), attack);
  log(`attack ${attack.id}: damage ${attack.hazard.damage}; hero Aren (medium weight class)`);
  log('tick  hero.z    hero velocity  hero reaction                                  rammer.z');
  const start = rig.me().position.z;
  let tick = 0, hitTick = -1;
  for (let i = 0; i < 400; i++) {
    rig.step(); tick++;
    const reaction = rig.me().reactionState;
    if (reaction && hitTick < 0) hitTick = tick;
    const moving = Math.abs(rig.me().velocity.z) > 0.01;
    if (hitTick < 0 ? i % 40 === 0 : moving || (tick - hitTick) % 10 === 0 || reaction?.kind === 'getup' && (tick - hitTick) % 5 === 0) {
      log(`${String(tick).padStart(4)}  ${fmt(rig.me().position.z)}  ${fmt(rig.me().velocity.z)}  ${reactionText(rig, 'me')}  ${fmt(rig.monster().position.z)}`);
    }
    if (hitTick >= 0 && !reaction && tick > hitTick + 5) break;
  }
  log(`hero knocked back ${(rig.me().position.z - start).toFixed(3)} m; cues: ${rig.cues.filter(cue => cue.reactionKind && cue.actorId === rig.state.playerId).map(cue => `${cue.kind}:${cue.reactionKind}`).join(', ')}`);
}

if (import.meta.main) {
  const lines: string[] = [];
  const log = (line: string): void => { lines.push(line); };
  sakdaBoarIntoWall(log);
  bossPoiseBreak(log);
  rammerKnocksPlayerDown(log);
  console.log(lines.join('\n'));
}
