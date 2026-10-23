import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';
import { PLAYER_SKILLS } from '../../src/game/combat/PlayerSkills.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { VESPER } from '../../src/game/combat/VesperSkills.js';

const idle: CombatInput = { tick: 0, move: vec(0,0,0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
function bench(wall = false): CombatEngine {
  const seed = createEngineState();
  seed.heroId = 'vesper';
  seed.actors[0]!.facing = vec(1,0,0);
  seed.arena.bounds = { min: vec(-30,0,-30), max: vec(30,20,30) };
  if (wall) seed.arena.colliders = [{ id: 'wall', kind: 'box', from: vec(3,2,0), halfExtents: vec(.1,2,5), blocksMovement: true, blocksCamera: false }];
  return new CombatEngine(seed);
}
function step(engine: CombatEngine, ticks: number, patch: Partial<CombatInput> = {}): StoryCue[] {
  const cues: StoryCue[] = [];
  for(let i=0;i<ticks;i++){engine.fixedStep({...idle,...patch});cues.push(...engine.drainPresentationCues());}
  return cues;
}
function airborne(engine: CombatEngine): void { step(engine,1,{jumpPressed:true,move:vec(1,0,0)});step(engine,14,{move:vec(1,0,0)}); }

describe('airborne Vesper actions',()=>{
  it('accepts one dash without renewing airtime, then lands despite repeated dash input',()=>{
    const engine=bench(); airborne(engine);
    const before=engine.snapshotState(),deadline=before.playerJump!.flightStartedAtTick+before.playerJump!.flightTicks;
    step(engine,1,{dodgePressed:true,move:vec(1,0,0)});
    const dashed=engine.snapshotState();
    expect(dashed.player.mana).toBe(before.player.mana-PLAYER_SKILLS.dive.manaCost);
    expect(dashed.actors[0]!.actionId).toBe('vesper-mist-blink');
    expect(dashed.actors[0]!.position.y).toBeGreaterThan(.5);
    expect(dashed.playerJump!.flightStartedAtTick+dashed.playerJump!.flightTicks).toBe(deadline);
    const restored=new CombatEngine(dashed);
    step(restored,deadline+11-dashed.tick,{dodgePressed:true});
    const landed=restored.snapshotState();
    expect(landed.playerJump).toBeUndefined();
    expect(landed.actors[0]!.position.y).toBeCloseTo(0,6);
    expect(landed.player.mana).toBe(dashed.player.mana);
    expect(landed.actors[0]!.position.x).toBeGreaterThan(before.actors[0]!.position.x+1);
  });
  it('keeps the planned Mist Blink burst instead of braking it to ordinary airborne movement',()=>{
    const engine=bench();airborne(engine);step(engine,1,{dodgePressed:true,move:vec(1,0,0)});
    const dashed=engine.snapshotState(),jump=dashed.playerJump!,start=dashed.actors[0]!.position.x;
    const ticks=VESPER.mistBlink.durationTicks-1;
    const remaining=jump.flightStartedAtTick+jump.flightTicks-dashed.tick;
    const expected=(jump.to.x-start)*ticks/remaining;
    // The locked dash follows its clear planned path even while ordinary steering requests another direction.
    step(engine,ticks,{move:vec(0,0,1)});
    expect(engine.snapshotState().actors[0]!.position.x-start).toBeCloseTo(expected,6);
  });
  it('keeps the true-blink protection in the air and ends it at the authored iframe boundary',()=>{
    const initial=bench();airborne(initial);step(initial,1,{dodgePressed:true,move:vec(1,0,0)});
    const seed=initial.snapshotState(),attack=ATTACKS['koro-fruit-burst']!;
    seed.hazards.push({...structuredClone(attack.hazard),id:'air-burst',attackId:attack.id,sourceId:'koro',startTick:seed.worldTick,activeFrom:seed.worldTick+1,activeUntil:seed.worldTick+100,target:vec(0,0,0),origin:vec(0,0,0),direction:vec(0,0,1),width:400,depth:400,heightAboveGround:4,damage:40,hitIds:[],threatTicks:[],cue:'burst',bounds:{min:vec(-200,-50,-200),max:vec(200,50,200)}});
    const engine=new CombatEngine(seed);
    step(engine,VESPER.mistBlink.iframes-1);
    expect(engine.snapshotState().player.vitality).toBe(seed.player.vitality);
    step(engine,1);
    expect(engine.snapshotState().player.vitality).toBeLessThan(seed.player.vitality);
  });
  it('sweeps the airborne dash against a wall rather than teleporting through it',()=>{
    const engine=bench(true);airborne(engine);step(engine,1,{dodgePressed:true,move:vec(1,0,0)});
    for(let i=0;i<65;i++){
      step(engine,1,{move:vec(1,0,0)});
      expect(engine.snapshotState().actors[0]!.position.x).toBeLessThanOrEqual(2.48+1e-6);
    }
    expect(engine.snapshotState().playerJump).toBeUndefined();
  });
  it('plays a kunai cast in the air while its original jump continues to landing',()=>{
    const engine=bench();airborne(engine);
    const deadline=engine.snapshotState().playerJump!.flightStartedAtTick+engine.snapshotState().playerJump!.flightTicks;
    step(engine,1,{rangedPressed:true});
    expect(engine.snapshotState().actors[0]!.actionId).toBe('vesper-kunai-fan');
    const cues=step(engine,20);
    const shot=cues.find(cue=>cue.kind==='projectile');
    expect(shot?.from?.y).toBeGreaterThan(1.1);
    expect(engine.snapshotState().actors[0]!.position.y).toBeGreaterThan(0);
    step(engine,deadline+12-engine.snapshotState().tick);
    expect(engine.snapshotState().playerJump).toBeUndefined();
    expect(engine.snapshotState().actors[0]!.position.y).toBeCloseTo(0,6);
  });
  it('keeps the native aerial katana action through contact without extending its jump',()=>{
    const engine=bench();airborne(engine);
    const before=engine.snapshotState(),deadline=before.playerJump!.flightStartedAtTick+before.playerJump!.flightTicks;
    step(engine,1,{lightPressed:true});
    expect(engine.snapshotState().actors[0]!.actionId).toBe('vesper-iai-1');
    const cues=step(engine,VESPER.iai.steps[0]!.activeAt);
    expect(cues.some(cue=>cue.kind==='slash'&&cue.phase==='active')).toBe(true);
    expect(engine.snapshotState().actors[0]!.position.y).toBeGreaterThan(0);
    expect(engine.snapshotState().playerJump!.flightStartedAtTick+engine.snapshotState().playerJump!.flightTicks).toBe(deadline);
    step(engine,deadline+12-engine.snapshotState().tick);
    expect(engine.snapshotState().playerJump).toBeUndefined();
    expect(engine.snapshotState().actors[0]!.position.y).toBeCloseTo(0,6);
  });
});

describe('accepted-cast cooldowns',()=>{
  it('rejects ranged spam without spending mana and becomes available exactly at its persisted deadline',()=>{
    const engine=bench();step(engine,1,{rangedPressed:true});
    const first=engine.snapshotState(),ready=first.skillReadyAt.sigil_bolt!;
    expect(first.skillReadyAt.sigil_barrage).toBe(ready);
    step(engine,45,{rangedPressed:true});
    expect(engine.snapshotState().player.mana).toBe(first.player.mana);
    expect(engine.snapshotState().skillReadyAt.sigil_bolt).toBe(ready);
    const saved=engine.serialize();step(engine,200);engine.restore(saved);
    step(engine,ready-engine.snapshotState().tick-1,{rangedPressed:true});
    expect(engine.snapshotState().player.mana).toBe(first.player.mana);
    step(engine,1,{rangedPressed:true});
    expect(engine.snapshotState().player.mana).toBe(first.player.mana-PLAYER_SKILLS.sigil_bolt.manaCost);
    expect(engine.snapshotState().skillReadyAt.sigil_bolt).toBe(ready+PLAYER_SKILLS.sigil_bolt.cooldownTicks);
  });
  it('freezes the remaining cooldown during hit-stop and pause',()=>{
    const engine=bench();step(engine,1,{rangedPressed:true});
    const seed=engine.snapshotState();seed.hitStop={remainingTicks:4,strength:1};
    const frozen=new CombatEngine(seed),remaining=seed.skillReadyAt.sigil_bolt!-seed.tick;
    step(frozen,4);
    const after=frozen.snapshotState();expect(after.skillReadyAt.sigil_bolt!-after.tick).toBe(remaining);
    frozen.setTimePolicy('paused');step(frozen,20);
    expect(frozen.snapshotState().tick).toBe(after.tick);
  });
});

describe('physical environment contacts',()=>{
  it('projects a real projectile contact onto the wall and never claims damage to it',()=>{
    const engine=bench(true);const cues=[...step(engine,1,{rangedPressed:true}),...step(engine,60)];
    const impact=cues.find(cue=>cue.kind==='projectile-impact'&&cue.contact?.surfaceId==='wall');
    expect(impact?.contact?.kind).toBe('solid');
    expect(impact?.position?.x).toBeCloseTo(2.9,5);
    expect(impact?.contact?.normal.x).toBeCloseTo(-1,5);
    expect(impact?.contact?.normal.y).toBeCloseTo(0,5);
    expect(impact?.confirmedDamage).toBeUndefined();
  });
  it('does not create surface contact proof when a projectile expires in empty space',()=>{
    const engine=bench();const cues=[...step(engine,1,{rangedPressed:true}),...step(engine,100)];
    expect(cues.filter(cue=>cue.contact!==undefined)).toEqual([]);
  });
  it('leaves physical surface feedback for an active melee cut, not a windup',()=>{
    const engine=bench(true),seed=engine.snapshotState();seed.actors[0]!.position.x=1;
    const subject=new CombatEngine(seed);
    expect(step(subject,1,{lightPressed:true}).filter(cue=>cue.contact)).toEqual([]);
    const cues=step(subject,15);
    const impact=cues.find(cue=>cue.contact?.surfaceId==='wall');
    expect(impact?.position?.x).toBeCloseTo(2.9,5);
    expect(impact?.contact?.normal.x).toBeCloseTo(-1,5);
  });
  it('records a stomp on the physical floor only at its active contact',()=>{
    const seed=bench().snapshotState();seed.heroId='sakda';
    seed.arena.colliders=[{id:'floor',kind:'box',from:vec(0,-.5,0),halfExtents:vec(20,.5,20),blocksMovement:true,blocksCamera:false}];
    const engine=new CombatEngine(seed);
    expect(step(engine,1,{heavyPressed:true}).filter(cue=>cue.contact)).toEqual([]);
    const cues=step(engine,30),impact=cues.find(cue=>cue.contact?.surfaceId==='floor');
    expect(impact?.position?.y).toBe(0);
    expect(impact?.contact?.normal).toEqual(vec(0,1,0));
    expect(impact?.confirmedDamage).toBeUndefined();
  });
});
