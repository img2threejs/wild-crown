import { describe, expect, it } from 'bun:test';
import { ACTORS, INTERACTIONS, REGIONS } from '../../src/content/campaign.js';
import { CombatEngine, createEngineState, makeActor, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';
import type { ActorId } from '../../src/game/contracts.js';
import { EVASION_PROFILES } from '../../src/game/combat/evasion.js';

const idle: CombatInput = {
  tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false,
  heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false,
};

function startHunters(): CombatEngine {
  const region=REGIONS.find((candidate)=>candidate.id==='blood-bamboo-valley')!;
  const hunter=region.entities.find(entity=>entity.id==='hunter-melee-west')!;
  const seed=createEngineState();
  seed.lastAttackTick=10_000;
  const engine=new CombatEngine(seed);
  engine.startEncounter({
    encounterId:'camp-hunters',regionId:region.id,runId:'camp-hunter-test',
    playerPosition:vec(hunter.position.x,hunter.position.y,hunter.position.z+1.5),
  });
  return engine;
}

/** One Heavy to the end of its recovery; a connecting hit freezes the player clock, so wait on the deadline rather than a tick count. */
function heavyHit(engine: CombatEngine): void {
  engine.fixedStep({ ...idle, heavyPressed: true });
  for (let tick = 1; tick < 120 && engine.snapshotState().actionRecoveryUntil > 0; tick++) engine.fixedStep(idle);
}

function approach(engine:CombatEngine,targetId:ActorId):void{
  for(let tick=0;tick<600;tick++){
    const state=engine.snapshotState();
    const player=state.actors.find(actor=>actor.id==='aren')!;
    const target=state.actors.find(actor=>actor.id===targetId)!;
    const dx=target.position.x-player.position.x;
    const dz=target.position.z-player.position.z;
    const distance=Math.hypot(dx,dz);
    if(distance<=2)return;
    engine.fixedStep({...idle,move:vec(dx/distance,0,-dz/distance)});
  }
}
describe('Aren locomotion and jump animation inputs', () => {
  it('selects Walk or Run and applies the faster Shift movement speed', () => {
    const engine = new CombatEngine();
    engine.fixedStep({ ...idle, move: vec(0, 0, 1) });
    const walked = engine.snapshotState().actors.find(actor => actor.id === 'aren')!;
    expect(walked.actionId).toBe('aren-walk');
    const walkSpeed = Math.hypot(walked.velocity.x, walked.velocity.z);

    engine.fixedStep({ ...idle, move: vec(0, 0, 1), sprintHeld: true });
    const ran = engine.snapshotState().actors.find(actor => actor.id === 'aren')!;
    expect(ran.actionId).toBe('aren-run');
    expect(Math.hypot(ran.velocity.x, ran.velocity.z)).toBeGreaterThan(walkSpeed);
  });



  it('selects a forward diagonal Dive Roll', () => {
    const engine = new CombatEngine();
    engine.fixedStep({ ...idle, move: vec(-1, 0, 1), dodgePressed: true });
    expect(engine.snapshotState().actors.find(actor => actor.id === 'aren')!.actionId).toBe('aren-forward-left-dive-roll');
  });

  it('moves a Dive Roll over its active animation instead of teleporting', () => {
    const engine = new CombatEngine();
    const before = engine.snapshotState().actors.find(actor => actor.id === 'aren')!;
    const profile = EVASION_PROFILES.forward_left_dive_roll;
    engine.fixedStep({ ...idle, move: vec(-1, 0, 1), dodgePressed: true });
    const firstStep = engine.snapshotState().actors.find(actor => actor.id === 'aren')!;
    expect(firstStep.actionId).toBe('aren-forward-left-dive-roll');
    const firstDistance = Math.hypot(firstStep.position.x - before.position.x, firstStep.position.z - before.position.z);
    expect(firstDistance).toBeGreaterThan(0);
    expect(firstDistance).toBeLessThan(0.2);

    for (let tick = 1; tick < profile.durationTicks; tick++) engine.fixedStep(idle);
    const end = engine.snapshotState().actors.find(actor => actor.id === 'aren')!;
    const totalDistance = Math.hypot(end.position.x - before.position.x, end.position.z - before.position.z);
    expect(totalDistance).toBeCloseTo(profile.distance, 1);
  });
});

describe('authored hunter encounters and mechanic-backed interactions', () => {

  it('emits the camp result only after both melee instances and the ranged instance are subdued', () => {
    const engine=startHunters();
    const initial=engine.snapshot().actors;
    expect(initial.find(actor=>actor.id==='hunter-melee-west')).toMatchObject({id:'hunter-melee-west',archetypeId:'poacher-hunter'});
    expect(initial.find(actor=>actor.id==='hunter-melee-east')).toMatchObject({id:'hunter-melee-east',archetypeId:'poacher-hunter'});
    expect(initial.find(actor=>actor.id==='hunter-ranged')).toMatchObject({id:'hunter-ranged',archetypeId:'poacher-scout'});
    engine.fixedStep(idle);
    expect(engine.snapshot().telegraphs.map(telegraph=>telegraph.sourceId+':'+telegraph.attackId).sort()).toEqual(['hunter-melee-west:poacher-hunter-spear','hunter-melee-east:poacher-hunter-east-spear','hunter-ranged:poacher-scout-net'].sort());
    for(let hit=0;hit<5;hit++)heavyHit(engine);
    const first=engine.snapshotState();
    expect(first.actors.find(actor=>actor.id==='hunter-melee-west')?.downed).toBe(true);
    expect(first.actors.find(actor=>actor.id==='hunter-melee-east')?.downed).toBe(false);
    expect(first.actors.find(actor=>actor.id==='hunter-ranged')?.downed).toBe(false);
    expect(engine.consumeWorldEvents().some(event=>event.type==='encounter-resolved')).toBe(false);

    engine.fixedStep({...idle,targetCycle:1});
    const secondTarget=engine.snapshotState().targetId!;
    expect(['hunter-melee-east','hunter-ranged']).toContain(secondTarget);
    approach(engine,secondTarget);
    const secondPosition=engine.snapshotState();
    const player=secondPosition.actors.find(actor=>actor.id==='aren')!;
    const secondActor=secondPosition.actors.find(actor=>actor.id===secondTarget)!;
    expect(Math.hypot(secondActor.position.x-player.position.x,secondActor.position.z-player.position.z)).toBeLessThanOrEqual(2);
    for(let hit=0;hit<5;hit++)heavyHit(engine);
    expect(engine.snapshotState().actors.find(actor=>actor.id===secondTarget)?.downed).toBe(true);
    const thirdTarget=secondTarget==='hunter-melee-east'?'hunter-ranged':'hunter-melee-east';
    expect(engine.snapshotState().actors.find(actor=>actor.id===thirdTarget)?.downed).toBe(false);
    expect(engine.consumeWorldEvents().some(event=>event.type==='encounter-resolved')).toBe(false);

    approach(engine,thirdTarget);
    engine.fixedStep({...idle,targetCycle:1});
    expect(engine.snapshotState().targetId).toBe(thirdTarget);
    for(let hit=0;hit<5;hit++)heavyHit(engine);
    const resolved=engine.consumeWorldEvents().filter(event=>event.type==='encounter-resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({encounterId:'camp-hunters',resolution:'subdued',actorIds:['hunter-melee-west','hunter-melee-east','hunter-ranged']});
  });

  it('keeps Asha core state on a missed Cleanse and advances one per successful impact', () => {
    const region=REGIONS.find(candidate=>candidate.id==='blood-bamboo-valley')!;
    const asha=region.entities.find(entity=>entity.actorId==='asha')!;
    const seed=createEngineState();
    seed.player.instinct=100;
    let engine=new CombatEngine(seed);
    const playerPosition=vec(asha.position.x,asha.position.y,asha.position.z+4);
    const player=makeActor('aren','human','player',playerPosition,false,false,100);
    const mother=makeActor('asha',ACTORS.asha!.species,'hostile',asha.position,true,false,100);
    mother.recoveringUntil=10_000;
    engine.startEncounter({encounterId:'encounter-asha',regionId:region.id,runId:'asha-core-test',playerPosition,actors:[player,mother]});
    const coreIds=['asha-corruption-core-1','asha-corruption-core-2','asha-corruption-core-3'];
    expect(engine.snapshot().boss?.corruptionCores).toEqual(coreIds.map(id=>({id,cleansed:false})));

    expect(engine.useAbility('cleanse','asha')).toBe(true);
    for(let tick=0;tick<36;tick++)engine.fixedStep(idle);
    expect(engine.snapshot().boss?.corruptionCores).toEqual(coreIds.map(id=>({id,cleansed:false})));
    expect(engine.snapshotState().player.instinct).toBe(100);
    while(engine.snapshotState().tick<engine.snapshotState().actionRecoveryUntil)engine.fixedStep(idle);
    for(let tick=0;tick<35;tick++)engine.fixedStep({...idle,move:vec(0,0,1)});
    const closePlayer=engine.snapshotState().actors.find(actor=>actor.id==='aren')!;
    expect(Math.hypot(closePlayer.position.x-asha.position.x,closePlayer.position.z-asha.position.z)).toBeLessThan(2.5);

    for(let cleared=1;cleared<=coreIds.length;cleared++){
      if(engine.snapshot().player.mana<30){
        for(let tick=0;tick<60;tick++)engine.fixedStep({...idle,move:vec(1,0,0)});
        for(let tick=0;tick<60;tick++)engine.fixedStep({...idle,move:vec(-1,0,0)});
      }
      expect(engine.useAbility('cleanse','asha')).toBe(true);
      for(let tick=0;tick<36;tick++)engine.fixedStep(idle);
      expect(engine.snapshot().boss?.corruptionCores).toEqual(coreIds.map((id,index)=>({id,cleansed:index<cleared})));
      if(cleared===1){
        const restored=new CombatEngine();
        restored.restore(engine.serialize());
        engine=restored;
        expect(engine.snapshot().boss?.corruptionCores).toEqual(coreIds.map((id,index)=>({id,cleansed:index===0})));
      }
      if(cleared<coreIds.length){
        while(engine.snapshotState().tick<engine.snapshotState().actionRecoveryUntil)engine.fixedStep(idle);
      }
    }
    for(let tick=0;tick<60;tick++)engine.fixedStep(idle);
    expect(engine.snapshot().boss?.corruptionCores).toEqual(coreIds.map(id=>({id,cleansed:true})));
    expect(engine.consumeWorldEvents().filter(event=>event.type==='encounter-resolved'&&event.encounterId==='encounter-asha')).toHaveLength(1);
  });

  it('requires a present Koro for the authored thorn inspection', () => {
    const region = REGIONS.find((candidate) => candidate.id === 'whispering-canopy')!;
    const thorn = region.entities.find((entity) => entity.id === 'koro-thorn' || entity.interactionId === 'koro-thorn')!;
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: region.id, runId: 'koro-context-test', presentActorIds: ['koro' as ActorId], companionSlots: { utility: 'koro' }, playerPosition: thorn.position });
    expect(engine.resolveInteraction('koro-thorn', 'koro-thorn')).toBe(true);
    expect(engine.resolveInteraction('koro-thorn', 'koro-thorn')).toBe(false);
    expect(engine.consumeWorldEvents()).toMatchObject([{ type: 'semantic-interaction', interactionId: 'koro-thorn', kind: 'inspect' }]);
  });

  it('records the authored Nyra route signal without Warden’s Call or Bond', () => {
    const region=REGIONS.find(candidate=>candidate.id==='mistveil-basin')!;
    const nyra=region.entities.find(entity=>entity.actorId==='nyra')!;
    const interaction=INTERACTIONS.find(candidate=>candidate.id==='nyra-reveal-hidden-route')!;
    const engine=new CombatEngine();
    engine.loadRegion({regionId:region.id,runId:'nyra-route-test',presentActorIds:[nyra.id],companionSlots:{utility:'nyra'},playerPosition:nyra.position,wardenCall:false,bond:0});
    expect(engine.resolveInteraction(interaction.id,interaction.targetId)).toBe(true);
    expect(engine.consumeWorldEvents()).toMatchObject([{type:'semantic-interaction',actorId:'nyra',interactionId:'nyra-reveal-hidden-route',kind:'signal',targetId:'mistveil-hidden-route'}]);
    expect(engine.resolveInteraction(interaction.id,interaction.targetId)).toBe(false);
    expect(engine.snapshotState().companionState.bond).toBe(0);
    expect(engine.snapshotState().companionState.wardenCall).toBe(false);
  });

  it('resolves an exact interaction instance and refuses an ambiguous canonical target', () => {
    const region=REGIONS.find(candidate=>candidate.id==='mistveil-basin')!;
    const nyraPlacement=region.entities.find(entity=>entity.actorId==='nyra')!;
    const interaction=INTERACTIONS.find(candidate=>candidate.id==='nyra-reveal-hidden-route')!;
    const playerPosition=nyraPlacement.position;
    const makeNyraSeed=(ids:readonly ActorId[])=>{
      const seed=createEngineState();
      seed.regionId=region.id;
      seed.runId='nyra-instance-target-test';
      seed.companionSlots={utility:'nyra'};
      seed.actors=[makeActor('aren','human','player',playerPosition,false,false,100),...ids.map(id=>makeActor(id,ACTORS.nyra!.species,'ally',playerPosition,false,false,100,'nyra'))];
      return seed;
    };
    const exactEngine=new CombatEngine(makeNyraSeed(['nyra-instance']));
    expect(exactEngine.resolveInteraction(interaction.id,'nyra-instance')).toBe(true);
    expect(exactEngine.consumeWorldEvents()).toMatchObject([{type:'semantic-interaction',actorId:'nyra-instance',interactionId:'nyra-reveal-hidden-route',targetId:'mistveil-hidden-route'}]);

    const ambiguousEngine=new CombatEngine(makeNyraSeed(['nyra-west','nyra-east']));
    expect(ambiguousEngine.resolveInteraction(interaction.id,'nyra')).toBe(false);
    expect(ambiguousEngine.consumeWorldEvents()).toHaveLength(0);
  });

  it('rejects a Tali rescue while an authored hunter remains hostile even after camp-disable facts', () => {
    const region=REGIONS.find(candidate=>candidate.id==='blood-bamboo-valley')!;
    const tali=region.entities.find(entity=>entity.actorId==='tali')!;
    const engine=new CombatEngine();
    engine.startEncounter({encounterId:'camp-hunters',regionId:region.id,runId:'tali-threat-test',playerPosition:tali.position,worldFacts:{taliInBamboo:true,'interaction:camp-disable':true}});
    const before=engine.snapshotState();
    expect(engine.resolveInteraction('tali-cage','tali')).toBe(false);
    expect(engine.snapshotState().rewardEmitted).toBe(before.rewardEmitted);
    expect(engine.consumeWorldEvents().some(event=>event.type==='rescue')).toBe(false);
  });

  it('opens the authored Tali route through camp mechanics and rescues her once', () => {
    const region=REGIONS.find(candidate=>candidate.id==='blood-bamboo-valley')!;
    const campDisable=region.entities.find(entity=>entity.id==='camp-disable'||entity.interactionId==='camp-disable')!;
    const engine=new CombatEngine();
    engine.loadRegion({regionId:region.id,runId:'tali-rescue-test',presentActorIds:['tali' as ActorId],playerPosition:vec(campDisable.position.x+0.5,campDisable.position.y,campDisable.position.z),worldFacts:{taliInBamboo:true}});
    const before=engine.snapshotState();
    expect(engine.resolveInteraction('tali-cage','tali')).toBe(false);
    expect(engine.snapshotState().actors).toEqual(before.actors);
    expect(engine.snapshotState().seenWorldKeys).toEqual(before.seenWorldKeys);
    expect(engine.consumeWorldEvents()).toHaveLength(0);

    engine.fixedStep({...idle,heavyPressed:true,interactionId:'camp-disable',interactionTargetId:'hunter-camp'});
    for(let tick=1;tick<24;tick++)engine.fixedStep(idle);
    expect(engine.consumeWorldEvents()).toMatchObject([{type:'semantic-interaction',interactionId:'camp-disable',kind:'break',targetId:'hunter-camp'}]);

    for(let tick=0;tick<400;tick++){
      const state=engine.snapshotState();
      const player=state.actors.find(actor=>actor.id==='aren')!;
      const tali=state.actors.find(actor=>actor.id==='tali')!;
      const dx=tali.position.x-player.position.x;
      const dz=tali.position.z-player.position.z;
      const distance=Math.hypot(dx,dz);
      if(distance<=1.5)break;
      engine.fixedStep({...idle,move:vec(dx/distance,0,-dz/distance)});
    }
    const approached=engine.snapshotState();
    const approachedPlayer=approached.actors.find(actor=>actor.id==='aren')!;
    const approachedTali=approached.actors.find(actor=>actor.id==='tali')!;
    expect(Math.hypot(approachedTali.position.x-approachedPlayer.position.x,approachedTali.position.z-approachedPlayer.position.z)).toBeLessThanOrEqual(1.5);
    expect(engine.resolveInteraction('tali-cage','tali')).toBe(true);
    expect(engine.resolveInteraction('tali-cage','tali')).toBe(false);
    expect(engine.consumeWorldEvents()).toMatchObject([{type:'rescue',targetId:'tali',safe:true}]);
    expect(engine.snapshotState().actors.find(actor=>actor.id==='tali')?.allegiance).toBe('ally');
  });

  it('restores the river source only after an authored Cleanse pulse lands', () => {
    const region=REGIONS.find(candidate=>candidate.id==='mistveil-basin')!;
    const source=region.entities.find(entity=>entity.id==='river-source'||entity.interactionId==='river-source')!;
    const seed=createEngineState();
    seed.player.instinct=20;
    const engine=new CombatEngine(seed);
    const playerPosition=vec(source.position.x+0.5,source.position.y,source.position.z);
    engine.loadRegion({regionId:region.id,runId:'river-restoration-test',presentActorIds:[],playerPosition});
    const before=engine.snapshotState();
    expect(engine.resolveInteraction('river-source','river-source')).toBe(false);
    expect(engine.consumeWorldEvents()).toHaveLength(0);
    expect(engine.snapshotState().seenWorldKeys).toEqual(before.seenWorldKeys);

    engine.fixedStep({...idle,cleansePressed:true,interactionId:'river-source',interactionTargetId:'river-source'});
    for(let tick=1;tick<36;tick++)engine.fixedStep(idle);
    expect(engine.resolveInteraction('river-source','river-source')).toBe(false);
    expect(engine.consumeWorldEvents()).toMatchObject([{type:'restoration',regionId:'mistveil-basin',state:'restored',causeId:'river-source'}]);
  });
});
