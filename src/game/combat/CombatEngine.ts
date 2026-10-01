import type { ActionId, ActorId, ActorSnapshot, AttackId, CampaignSnapshot, CombatSnapshot, CompanionId, InputFrame, InteractionDefinition, MovableObjectSnapshot, RegionMovableObjectDefinition, RegionId, RegionRouteDefinition, Vec3, WorldEvent } from '../contracts.js';
import type { FragmentId } from '../../../packages/campaign/src/index.js';
import type { StoryCue } from '../../effects/story-cues.js';
import { ACTORS, INTERACTIONS, REGIONS } from '../../content/campaign.js';
import { COMPANION_ROSTER, type CompanionCommand, type CompanionRosterState, companionCommand, configureCompanionSlots, configureCompanions, createCompanionState, stepCompanions } from '../companions/CompanionSystem.js';
import { ATTACKS, BOSS_ENCOUNTERS, WILDLIFE_ENCOUNTERS, type AttackDefinition, type BossEncounterDefinition } from './content.js';
import { EVASION_PROFILES, type EvasionDirection, type EvasionProfile, type EvasionProfileId, type HazardDefinition } from './evasion.js';
import { arenaFromRegion, distance2, facingFrom, groundHeightAt, moveCircle, pointInSector, vec, type CombatArena, type Rect } from './geometry.js';

export const FIXED_STEP_SECONDS = 1 / 60;
const MAX_CATCH_UP_TICKS = 8;
const MAX_HOSTILES = 6;
const MAX_GROUNDED_LARGE = 2;
const MAX_TOTAL_LARGE=2;
const DODGE_RECHARGE_TICKS = 105;
const PERFECT_DODGE_EFFECTS={worldTimeScale:0.25,slowMotionTicks:12,maxSlowMotionTicks:18,instinctGain:20,petRecoveryReductionTicks:18,playerRecoveryReductionTicks:12,weakPointDurationTicks:36,weakPointDamageMultiplier:1.5,counterWindowTicks:36} as const;
const PLAYER_RADIUS = 0.42;
const ACTION_CLIPS: Readonly<Record<string, ActionId>> = {
  idle: 'aren-idle' as ActionId, walk: 'aren-walk' as ActionId, strafe: 'aren-strafe' as ActionId,
  quick_step_left: 'aren-quick-step-left' as ActionId, quick_step_right: 'aren-quick-step-right' as ActionId,
  forward_shoulder_roll: 'aren-forward-shoulder-roll' as ActionId, back_handspring: 'aren-back-handspring' as ActionId,
  left_cartwheel: 'aren-left-cartwheel' as ActionId, right_cartwheel: 'aren-right-cartwheel' as ActionId,
  forward_left_dive_roll: 'aren-forward-left-dive-roll' as ActionId, forward_right_dive_roll: 'aren-forward-right-dive-roll' as ActionId,
  back_left_pivot_roll: 'aren-back-left-pivot-roll' as ActionId, back_right_pivot_roll: 'aren-back-right-pivot-roll' as ActionId,
  low_slide: 'aren-low-slide' as ActionId, staff_vault: 'aren-staff-vault' as ActionId,
  perfect_dodge_left: 'aren-perfect-dodge-left' as ActionId, perfect_dodge_right: 'aren-perfect-dodge-right' as ActionId,
  dodge_recovery: 'aren-dodge-recovery' as ActionId, hard_landing: 'aren-hard-landing' as ActionId,
  stumble_recovery: 'aren-stumble-recovery' as ActionId, light_1: 'aren-light-1' as ActionId,
  light_2: 'aren-light-2' as ActionId, light_3: 'aren-light-3' as ActionId, heavy: 'aren-heavy' as ActionId,
  charged_heavy: 'aren-charged-heavy' as ActionId, root_tether: 'aren-root-tether' as ActionId,
  ferocity: 'aren-ferocity' as ActionId, corruption: 'aren-corruption' as ActionId, cleanse: 'aren-cleanse' as ActionId,
  possession_break: 'aren-possession-break' as ActionId, vault_counter: 'aren-staff-vault-downward-strike' as ActionId,
  cartwheel_counter: 'aren-cartwheel-staff-sweep' as ActionId,
  'actor-idle': 'wild-crown:actor-idle' as ActionId,
  ...Object.fromEntries(Object.keys(ATTACKS).map(id=>[`boss:${id}`,`wild-crown:${id}` as ActionId])),
  ...Object.fromEntries(COMPANION_ROSTER.map(companion=>[`${companion.id}-idle`,`${companion.id}:idle` as ActionId])),
  ...Object.fromEntries(Object.values(BOSS_ENCOUNTERS).map(encounter=>[`${encounter.bossId}-idle`,`${encounter.bossId}:idle` as ActionId])),
};
export const COMBAT_ACTION_CLIPS = ACTION_CLIPS;

export interface CameraBasis { forward: Vec3; right: Vec3 }
export interface CombatInput extends InputFrame { dodgeDirection?: EvasionDirection; heavyHeldTicks?: number; targetCycle?: -1 | 1; tetherPressed?: boolean; cleansePressed?: boolean; ferocityPressed?: boolean; corruptionPressed?: boolean; interactTargetId?: ActorId; interactionId?:string; interactionTargetId?:string; choiceOptionId?:string; traversalId?: string }
export interface CombatActor extends ActorSnapshot {
  radius: number; collisionHeight:number; maxVitality: number; large: boolean; aerial: boolean; command?: CompanionCommand; corruptionCoreIds?: readonly string[]; cleansedCoreIds?: string[];
  recoveringUntil: number; invulnerableUntil: number; staggerUntil: number; possessedUntil: number; weakPointUntil?:number; possessionInstanceId?:string; possessionSourceId?:ActorId; actionStartedTick: number; actionEndsTick: number;
}
export interface LiveHazard extends HazardDefinition {
  id: string; attackId: AttackId; sourceId: ActorId; startTick: number; activeFrom: number; activeUntil: number;
  target: Vec3; origin: Vec3; direction: Vec3; hitIds: string[]; threatTicks: number[]; cue: string; targetActorId?:ActorId;
}
export interface LiveTelegraph { id: string; attackId: AttackId; sourceId: ActorId; targetPosition: Vec3; phase: 'windup'|'commit'|'active'|'recovery'; remainingTicks: number; cue: string }
export interface CombatEvent { id: string; tick: number; kind: 'cue'|'damage'|'perfect-dodge'|'counter-open'|'action'|'companion'|'traversal'|'world'|'attack-interrupted'; actorId?: ActorId; targetId?: ActorId; actionId?: string; attackId?: AttackId; message: string; worldEvent?: WorldEvent }
export interface EncounterCheckpoint { tick: number; worldTick: number; lastAttackTick: number; counterUntil: number; actors: CombatActor[]; player: PlayerResources; phaseIndex: number; phaseLatch: number; phaseActionFlags: string[]; rewardEmitted: boolean; companions: CompanionRosterState; }
export interface PlayerResources { vitality: number; maxVitality: number; instinct: number; ferocity: number; corruption: number; dodgeCharges: number; maxDodgeCharges: number; nextDodgeRechargeTick: number; }
export interface PendingImpact { activeAt: number; activeUntil: number; target: ActorId; action: string; range: number; radius: number; damage: number; interrupt: boolean; counter:boolean; startVitality: number; resolved: boolean; interactionId?:string; interactionPosition?:Vec3; }
export interface LiveMovableObject extends MovableObjectSnapshot {
  authored: RegionMovableObjectDefinition;
  startedAtWorldTick?: number;
  interactionId?: string;
  actorId?: ActorId;
}
export interface EngineState {
  schemaVersion: 2; tick: number; worldTick:number; worldTimeScale:number; timePolicy:CombatSnapshot['worldClock']['policy']; slowMotionRemainingTicks:number; slowMotionElapsedTicks:number; accumulator: number; regionId: RegionId; runId: string; encounterId?: string; encounter: BossEncounterDefinition | null; worldFacts: Readonly<Record<string,boolean|number|string>>;
  actors: CombatActor[]; playerId: ActorId; player: PlayerResources; targetId?: ActorId; arena: CombatArena; hazards: LiveHazard[]; telegraphs: LiveTelegraph[];
  movableObjects: LiveMovableObject[];
  events: CombatEvent[]; worldEvents: WorldEvent[]; seenWorldKeys: string[]; perfectDodgeKeys: string[]; phaseIndex: number; phaseLatch: number; phaseActionFlags:string[];
  actionId: string; actionUntil: number; actionRecoveryUntil: number; actionCancelable: boolean; counterUntil: number; lastAttackTick: number; heavyChargeStartTick: number | null; lastResolvedActionId?:string; lastResolvedTargetId?:ActorId; lastResolvedActionTick?:number; lightIndex?:number; bufferedAction?:{action:string;targetId?:ActorId;expiresTick:number};
  companionState: CompanionRosterState; companionSlots: { combat?: CompanionId; utility?: CompanionId; scout?: 'vara' };
  eventSequence: number; rewardEmitted: boolean; checkpoint: EncounterCheckpoint | null; traversalGates: TraversalGate[]; pendingImpact?: PendingImpact; presentationCues: StoryCue[];
}
export type EngineStateSeed = Partial<Omit<EngineState, 'schemaVersion'>> & { schemaVersion?: 1 | 2 };
export interface TraversalGate { id:string; routeId:string; from:Vec3; to:Vec3; anchors:readonly Vec3[]; fromRegion:RegionId; toRegion:RegionId; width:number; rise:number; unlocked:boolean; unlockFact?:string; traversalEvent:string; colliderIds:readonly string[] }
export interface EncounterStart { encounterId:string; regionId:RegionId; runId:string; playerPosition?:Vec3; bossPosition?:Vec3; companionSlots?:{combat?:CompanionId;utility?:CompanionId;scout?:'vara'}; actors?:readonly CombatActor[]; worldFacts?:Readonly<Record<string,boolean|number|string>>;}
export interface RegionLoadInput { regionId:RegionId;runId:string;presentActorIds:readonly string[];playerPosition?:Vec3;companionSlots?:{combat?:CompanionId;utility?:CompanionId;scout?:'vara'};chapter?:number;wardenCall?:boolean;bond?:number;dominionUsed?:boolean;worldFacts?:Readonly<Record<string,boolean|number|string>>; }
export interface AttackImpact { targetId: ActorId; damage: number; avoided: boolean; interrupt: boolean; }

export class CombatEngine {
  private state: EngineState;
  constructor(seed?: EngineStateSeed) { this.state = seed ? hydrateEngineState(seed) : createEngineState(); }

  loadRegion(input:RegionLoadInput):void{
    const region=REGIONS.find(candidate=>candidate.id===input.regionId);
    if(!region)throw new Error(`Unknown authored region: ${input.regionId}`);
    const presence=new Set(input.presentActorIds);
    const entry=input.playerPosition??region.entrances[0]?.from??region.navigation.nodes[0]?.position;
    if(!entry)throw new Error(`Region ${region.id} has no authored player entry`);
    const arena=arenaFromRegion(region,this.state.arena.cameraBasis);
    const playerGround=groundHeightAt(arena,entry.x,entry.z,entry.y);
    const playerPosition=vec(entry.x,playerGround??entry.y,entry.z);
    const actors=[makeActor('aren','human','player',playerPosition,false,false,100)];
    const slots=input.companionSlots??{};
    for(const id of [slots.combat,slots.utility,slots.scout])if(id&&region.entities.filter(entity=>entity.actorId===id&&presence.has(entity.id)).length!==1)throw new Error('Party companion '+id+' must resolve to one explicitly present region instance');
    for(const instanceId of presence){
      if(instanceId==='aren')continue;
      const entity=region.entities.find(candidate=>candidate.id===instanceId);
      if(!entity)throw new Error('Actor '+instanceId+' has no explicitly present placement in region '+region.id);
      const archetypeId=entity.actorId??(instanceId as ActorId);
      const definition=ACTORS[archetypeId];
      if(!definition)throw new Error('No authored actor definition for '+archetypeId);
      const requested=entity.position;
      const elevation=groundHeightAt(arena,requested.x,requested.z,requested.y)??requested.y;
      const large=isLargeSpecies(definition.species);
      const actor=makeActor(instanceId as ActorId,definition.species,definition.allegiance,vec(requested.x,elevation,requested.z),large,definition.species==='hornbill',100,archetypeId);
      actor.visible=entity?.visibleWhen===undefined||input.worldFacts?.[entity.visibleWhen]===true;
      actors.push(actor);
    }
    this.state.regionId=region.id;
    this.state.runId=input.runId;
    this.state.timePolicy='normal';this.state.slowMotionRemainingTicks=0;this.state.slowMotionElapsedTicks=0;this.state.worldTimeScale=1;this.state.accumulator=0;
    this.state.worldFacts=structuredClone(input.worldFacts??{});
    this.state.movableObjects=region.movableObjects.map(definition=>{
      const settled=input.worldFacts?.[definition.movedFactId]===true;
      return {objectId:definition.id,position:copy(settled?definition.to:definition.from),phase:settled?'settled':'resting',authored:structuredClone(definition)};
    });
    this.state.encounterId=undefined;
    this.state.encounter=null;
    this.state.arena=arena;
    this.state.actors=actors;
    this.state.playerId='aren';
    this.state.targetId=actors.find(actor=>actor.allegiance==='hostile'&&actor.visible)?.id;
    this.state.companionSlots={...slots};
    const previousCompanions=this.state.companionState;
    const chapter=input.chapter??previousCompanions.chapter;
    const wardenCall=input.wardenCall??previousCompanions.wardenCall;
    const bond=input.bond??previousCompanions.bond;
    const dominionUsed=input.dominionUsed??previousCompanions.dominionUsed;
    this.state.companionState=createCompanionState(slots,chapter);
    this.state.companionState.wardenCall=wardenCall;this.state.companionState.bond=bond;this.state.companionState.dominionUsed=dominionUsed;
    configureCompanions(this.state,{chapter,wardenCall,bond,dominionUsed,navNodes:region.navigation.nodes});
    this.setTraversalGates(region.traversalArcs,input.worldFacts??{});
    this.state.phaseIndex=0;
    this.state.phaseLatch=0;
    this.state.phaseActionFlags=[];
    this.state.rewardEmitted=false;
    this.state.hazards=[];
    this.state.telegraphs=[];
    this.state.pendingImpact=undefined;
    this.state.bufferedAction=undefined;this.state.heavyChargeStartTick=null;this.state.lightIndex=0;this.state.actionId='idle';this.state.actionUntil=this.state.tick;this.state.actionRecoveryUntil=0;this.state.actionCancelable=false;
    this.state.events=[];
    this.state.worldEvents=[];
    this.state.presentationCues=[];
    this.state.checkpoint=this.captureEncounterCheckpoint();
    this.enforceCaps();
  }
  startEncounter(input:EncounterStart):void{
    const definition=BOSS_ENCOUNTERS[input.encounterId]??WILDLIFE_ENCOUNTERS[input.encounterId];
    if(!definition)throw new Error(`Unknown authored encounter: ${input.encounterId}`);
    if(definition.regionId!==input.regionId)throw new Error(`Encounter ${input.encounterId} does not belong to ${input.regionId}`);
    const region=REGIONS.find(candidate=>candidate.id===input.regionId);
    if(!region)throw new Error(`Unknown authored region: ${input.regionId}`);
    this.setTimePolicy('normal');
    const mustLoadRegion=this.state.runId!==input.runId||this.state.regionId!==input.regionId||this.state.arena.surfaces.length===0;
    if(input.actors)this.state.actors=input.actors.map(cloneActor);
    else if(mustLoadRegion){
      const placedActors=[...definition.actorIds,...(definition.supportActorIds??[])].filter(id=>id!=='aren'&&region.entities.some(entity=>entity.id===id));
      const presentActorIds=[...new Set<ActorId>([...placedActors,...[input.companionSlots?.combat,input.companionSlots?.utility,input.companionSlots?.scout].filter((id):id is CompanionId=>id!==undefined)])];
      this.loadRegion({regionId:input.regionId,runId:input.runId,presentActorIds,playerPosition:input.playerPosition,companionSlots:input.companionSlots,worldFacts:input.worldFacts});
    }
    this.state.regionId=region.id;
    this.state.runId=input.runId;
    this.state.arena=arenaFromRegion(region,this.state.arena.cameraBasis);
    let player=this.playerActor();
    if(!player){
      const entry=input.playerPosition??region.entrances[0]?.from??region.navigation.nodes[0]?.position;
      if(!entry)throw new Error(`Region ${region.id} has no authored player entry`);
      const floor=groundHeightAt(this.state.arena,entry.x,entry.z,entry.y)??entry.y;
      player=makeActor('aren','human','player',vec(entry.x,floor,entry.z),false,false,100);
      this.state.actors.unshift(player);
    }else if(input.playerPosition){player.position=copy(input.playerPosition);}
    const bossId=definition.bossId;
    let boss=this.state.actors.find(actor=>actor.id===bossId);
    if(!boss){
      const placement=region.entities.find(entity=>entity.id===bossId||entity.actorId===bossId);
      const archetypeId=placement?.actorId??bossId;
      const source=ACTORS[archetypeId];
      if(!placement||!source)throw new Error(`Boss ${bossId} has no authored actor placement in ${region.id}`);
      const position=input.bossPosition??placement.position;
      const floor=groundHeightAt(this.state.arena,position.x,position.z,position.y)??position.y;
      boss=makeActor(bossId,source.species,'hostile',vec(position.x,floor,position.z),definition.largeActors.includes(bossId),source.species==='hornbill',100,archetypeId);
      this.state.actors.push(boss);
    }
    for(const actorId of definition.actorIds){
      if(actorId==='aren'||actorId===bossId)continue;
      let participant=this.state.actors.find(actor=>actor.id===actorId);
      if(!participant){
        const placement=region.entities.find(entity=>entity.id===actorId);
        const archetypeId=placement?.actorId??actorId;
        const source=ACTORS[archetypeId];
        if(!placement||!source)throw new Error(`Encounter ${input.encounterId} has no authored placement for ${actorId}`);
        const requested=placement.position;
        const floor=groundHeightAt(this.state.arena,requested.x,requested.z,requested.y)??requested.y;
        participant=makeActor(actorId,source.species,'hostile',vec(requested.x,floor,requested.z),definition.largeActors.includes(actorId),source.species==='hornbill',100,archetypeId);
        this.state.actors.push(participant);
      }
      participant.allegiance='hostile';participant.downed=false;participant.vitality=participant.maxVitality;participant.ferocity=participant.species==='human'?undefined:100;participant.recoveringUntil=0;
    }
    boss.allegiance='hostile';boss.downed=false;boss.vitality=boss.maxVitality;
    boss.ferocity=100;
    boss.corruptionCoreIds=definition.corruptionCoreIds?[...definition.corruptionCoreIds]:undefined;
    boss.cleansedCoreIds=[];
    boss.corruption=boss.corruptionCoreIds?.length?100:60;
    boss.large=definition.largeActors.includes(boss.id);
    this.state.encounterId=input.encounterId;
    this.state.encounter=structuredClone(definition);
    this.state.companionSlots={...input.companionSlots};
    const previous=this.state.companionState;
    const companions=createCompanionState(this.state.companionSlots,previous.chapter);
    companions.wardenCall=previous.wardenCall;
    companions.bond=previous.bond;
    companions.dominionUsed=previous.dominionUsed;
    companions.navNodes=structuredClone(region.navigation.nodes);
    this.state.companionState=companions;
    for(const id of [this.state.companionSlots.combat,this.state.companionSlots.utility,this.state.companionSlots.scout]){
      if(id&&!this.actorForId(id))throw new Error('Selected companion '+id+' is absent; encounter startup will not summon it');
    }
    this.enforceCaps();
    this.state.phaseIndex=0;
    this.state.phaseLatch=0;
    this.state.phaseActionFlags=[];
    this.state.rewardEmitted=false;
    this.state.hazards=[];
    this.state.telegraphs=[];
    this.state.pendingImpact=undefined;
    this.state.bufferedAction=undefined;this.state.heavyChargeStartTick=null;this.state.lightIndex=0;this.state.actionId='idle';this.state.actionUntil=this.state.tick;this.state.actionRecoveryUntil=0;this.state.actionCancelable=false;
    this.state.events=[];
    this.state.worldEvents=[];
    this.state.presentationCues=[];
    this.state.targetId=bossId;
    this.state.checkpoint=this.captureEncounterCheckpoint();
    const initialPhase=this.state.encounter.phases[0];
    if(initialPhase)this.emitPhaseEvent(initialPhase.id,0,'entered');
  }
  setCompanionSlots(slots:{combat?:CompanionId;utility?:CompanionId;scout?:'vara'},presentActorIds:readonly string[]):boolean{
    const present=new Set(presentActorIds);
    const region=REGIONS.find(candidate=>candidate.id===this.state.regionId);
    if(!region)return false;
    for(const id of [slots.combat,slots.utility,slots.scout])if(id&&(region.entities.filter(entity=>entity.actorId===id&&present.has(entity.id)).length!==1||!this.actorForId(id)))return false;
    return configureCompanionSlots(this.state,slots);
  }
  setCameraBasis(basis:CameraBasis):void{this.state.arena.cameraBasis=basis;}
  syncWorldFacts(facts:Readonly<Record<string,boolean|number|string>>):void{
    this.state.worldFacts={...this.state.worldFacts,...structuredClone(facts)};
    const region=REGIONS.find(candidate=>candidate.id===this.state.regionId);
    if(!region)return;
    this.setTraversalGates(region.traversalArcs,this.state.worldFacts);
    for(const actor of this.state.actors){
      const placement=region.entities.find(entity=>entity.id===actor.id)??region.entities.find(entity=>entity.actorId===actor.id);
      if(placement?.visibleWhen!==undefined)actor.visible=this.state.worldFacts[placement.visibleWhen]===true;
    }
  }
  setTraversalGates(routes:readonly RegionRouteDefinition[],worldFacts:Readonly<Record<string,boolean|number|string>>={}):void{
    this.state.traversalGates=routes.map(route=>({id:route.id,routeId:route.id,from:route.from,to:route.to,anchors:structuredClone(route.anchors),fromRegion:this.state.regionId,toRegion:route.destinationRegionId,width:2,rise:Math.abs(route.to.y-route.from.y),unlocked:route.unlockFact===undefined||worldFacts[route.unlockFact]===true,unlockFact:route.unlockFact,traversalEvent:route.traversalEvent,colliderIds:structuredClone(route.colliderIds)}));
  }
  commandCompanion(companionId:CompanionId,command:CompanionCommand,targetId?:ActorId):boolean{
    const companion=this.actorForId(companionId);
    if(companion?.possessed&&(command==='ask'||command==='signal')&&!this.state.companionState.wardenCall&&this.state.companionState.bond>=10){
      this.breakPossession(companion);
      return true;
    }
    if(companionId==='koro'&&command==='special'){
      if(!targetId)return false;
      const object=this.state.movableObjects.find(candidate=>candidate.objectId===targetId);
      const interaction=object&&INTERACTIONS.find(candidate=>candidate.id===object.authored.koroInteractionId);
      if(!companion||!object||!interaction||!this.canStartMovableObjectMove(object,interaction,companion))return false;
      if(!companionCommand(this.state,companionId,command,targetId))return false;
      return this.startMovableObjectMove(object,interaction,companion);
    }
    return companionCommand(this.state,companionId,command,targetId);
  }
  resolveInteraction(interactionId:string,targetId:string,choiceOptionId?:string):boolean{
    const interaction=INTERACTIONS.find(candidate=>candidate.id===interactionId);
    if(!interaction||interaction.regionId!==this.state.regionId)return false;
    const actor=this.interactionTargetActor(interaction,targetId);
    const hasAuthoredActor=this.state.actors.some(candidate=>candidate.id===interaction.targetId||candidate.archetypeId===interaction.targetId);
    if(targetId!==interaction.targetId&&!actor)return false;
    if(targetId===interaction.targetId&&hasAuthoredActor&&!actor)return false;
    if(interaction.requiresFacts.some(fact=>this.state.worldFacts[fact]!==true))return false;
    if(interaction.requiresActors.some(id=>{const required=this.actorForId(id);return !required||!required.visible||required.downed||required.possessed;}))return false;
    const player=this.playerActor();
    if(actor&&actor.id===this.state.encounter?.bossId&&!this.state.rewardEmitted&&!actor.downed)return false;
    const region=REGIONS.find(candidate=>candidate.id===this.state.regionId);
    const entity=region?.entities.find(candidate=>candidate.interactionId===interactionId||candidate.id===interactionId)??region?.entities.find(candidate=>candidate.actorId===targetId||candidate.id===targetId);
    const position=actor?.position??entity?.position;
    if(!player||!position||distance2(player.position,position)>interaction.radiusMeters)return false;
    if(interactionId==='koro-thorn'){
      const koro=this.actorForId('koro');
      if(!koro?.visible||koro.downed||koro.possessed)return false;
    }
    if(interaction.actionId&&!this.interactionMechanicSatisfied(interaction,actor))return false;
    const success=interaction.success;
    if(success.type==='object-move'){
      const object=this.state.movableObjects.find(candidate=>candidate.objectId===success.objectId);
      if(!object||targetId!==success.objectId||interaction.targetId!==success.objectId||interaction.id!==object.authored.playerInteractionId||interaction.playerActionId!=='staff-heavy'||this.koroAssignedToParty()||!this.hasRecentHeavyImpact(success.objectId))return false;
      if(!this.canStartMovableObjectMove(object,interaction,player))return false;
      return this.startMovableObjectMove(object,interaction,player);
    }
    if(success.type==='semantic-interaction'){
      if(success.kind!==interaction.kind)return false;
      if(['repair','restore','break','move-object','shelter'].includes(success.kind)&&!this.interactionMechanicSatisfied(interaction,actor))return false;
      if(success.kind==='cleanse'&&(actor?.corruption??0)>0)return false;
      const eventId=this.interactionEventId(interaction);
      const signalActor=success.kind==='signal'?interaction.requiresActors.map(id=>this.actorForId(id)).find((candidate):candidate is CombatActor=>!!candidate&&candidate.visible&&!candidate.downed&&!candidate.possessed):undefined;
      const eventActor=signalActor??player;
      return this.emitWorldEvent({type:'semantic-interaction',eventId,idempotencyKey:eventId,actorId:eventActor.id,interactionId:interaction.id,kind:success.kind,targetId:success.targetId,position:copy(eventActor.position),facts:choiceOptionId?{choiceOptionId}:undefined});
    }
    if(success.type==='rescue'){
      const rescueTarget=this.actorForId(success.targetId as ActorId);
      const freed=this.state.worldFacts[`${interactionId}:freed`]===true;
      if(!rescueTarget&&!freed)return false;
      if(success.targetId==='tali'&&(!rescueTarget||this.state.worldFacts.taliInBamboo!==true))return false;
      const safe=success.targetId==='tali'?this.isTaliSafe(rescueTarget!.position):!!rescueTarget?.downed&&!rescueTarget.possessed&&!this.hasActiveThreatNear(rescueTarget.position);
      if(!safe)return false;
      const eventId=this.interactionEventId(interaction);
      const emitted=this.emitWorldEvent({type:'rescue',eventId,idempotencyKey:eventId,targetId:rescueTarget?.id??success.targetId,locationId:success.locationId,safe});
      if(emitted&&safe&&rescueTarget){rescueTarget.downed=false;rescueTarget.possessed=false;rescueTarget.allegiance='ally';}
      return emitted;
    }
    if(success.type==='fragment'){
      if(this.state.worldFacts[`fragment:${success.fragmentId}`]===true)return false;
      const fragmentId:FragmentId=success.fragmentId;
      const eventId=this.interactionEventId(interaction);
      return this.emitWorldEvent({type:'fragment',eventId,idempotencyKey:eventId,fragmentId,sourceId:success.sourceId});
    }
    if(success.type==='restoration'){
      if(!this.interactionMechanicSatisfied(interaction,actor))return false;
      const eventId=this.interactionEventId(interaction);
      return this.emitWorldEvent({type:'restoration',eventId,idempotencyKey:eventId,regionId:success.regionId,state:success.state,causeId:success.causeId});
    }
    if(success.type==='choice'){
      if(!choiceOptionId||!success.optionIds.includes(choiceOptionId))return false;
      const eventId=this.interactionEventId(interaction);
      return this.emitWorldEvent({type:'choice',eventId,idempotencyKey:eventId,choiceId:success.choiceId,optionId:choiceOptionId,leaderId:choiceOptionId.startsWith('dominion-')?choiceOptionId.slice('dominion-'.length):choiceOptionId,dominion:choiceOptionId.startsWith('dominion-')||choiceOptionId==='dominion'});
    }
    if(success.type==='traversal')return this.traverse(success.routeId);
    if(success.type==='checkpoint'){this.state.checkpoint=this.captureEncounterCheckpoint();return true;}
    return false;
  }
  applyRecoveryRequest(snapshot:Pick<CampaignSnapshot,'runId'|'recoveryRequest'|'lastSafeCheckpoint'>):boolean{
    const request=snapshot.recoveryRequest;
    const checkpoint=snapshot.lastSafeCheckpoint;
    if(!request||request.kind!=='restart-checkpoint'||request.reason!=='tali-safety'||!checkpoint)return false;
    if(checkpoint.runId!==snapshot.runId||checkpoint.checkpointId!==request.checkpointId)return false;
    const party=checkpoint.progress.party;
    const presentActorIds=[...new Set<ActorId>(['aren',...checkpoint.encounterReset.actorIds,party.combat,party.utility,party.scout].filter((id):id is ActorId=>id!==undefined))];
    this.loadRegion({regionId:checkpoint.safeSpawn.regionId,runId:checkpoint.runId,presentActorIds,playerPosition:checkpoint.safeSpawn.position,companionSlots:party,chapter:checkpoint.progress.chapter,worldFacts:checkpoint.progress.worldFacts});
    this.state.seenWorldKeys=[...checkpoint.progress.eventKeys];
    const encounterId=checkpoint.encounterReset.encounterId;
    if(encounterId)this.startEncounter({encounterId,regionId:checkpoint.safeSpawn.regionId,runId:checkpoint.runId,playerPosition:checkpoint.safeSpawn.position,companionSlots:party});
    return true;
  }
  useAbility(kind: 'root-tether'|'ferocity'|'corruption'|'cleanse'|'ask'|'signal', targetId?: ActorId): boolean {
    switch(kind) {
      case 'root-tether': return this.startPlayerAction('root_tether', targetId);
      case 'ferocity': return this.startPlayerAction('ferocity', targetId);
      case 'corruption': return this.startPlayerAction('corruption', targetId);
      case 'cleanse': return this.startPlayerAction('cleanse', targetId);
      case 'ask': return this.commandCompanionForInput(targetId, 'ask');
      case 'signal': return this.commandCompanionForInput(targetId, 'signal');
    }
  }
  step(input: CombatInput, deltaSeconds = FIXED_STEP_SECONDS, basis?: CameraBasis): number {
    if (basis) this.setCameraBasis(basis);
    if(this.state.timePolicy==='paused'){this.state.accumulator=0;return 0;}
    this.state.accumulator = Math.min(this.state.accumulator + Math.max(0, deltaSeconds), FIXED_STEP_SECONDS * MAX_CATCH_UP_TICKS);
    let steps = 0;
    while (this.state.accumulator + 1e-10 >= FIXED_STEP_SECONDS && steps < MAX_CATCH_UP_TICKS) {
      this.fixedStep(input); this.state.accumulator -= FIXED_STEP_SECONDS; steps++;
    }
    return steps;
  }
  fixedStep(input: CombatInput = { tick: this.state.tick+1, move: vec(0,0,0), dodgePressed:false, lightPressed:false, heavyPressed:false, heavyHeld:false, heavyReleased:false, interactPressed:false }): void {
    if(this.state.timePolicy==='paused')return;
    const firstEvent=this.state.events.length;
    this.state.tick++;
    if(this.state.timePolicy==='perfect-dodge-slow'&&this.state.slowMotionRemainingTicks<=0)this.state.timePolicy='normal';
    const slowMotionActive=this.state.timePolicy==='perfect-dodge-slow';
    const worldScale=this.effectiveWorldTimeScale();
    this.state.worldTimeScale=worldScale;
    this.state.worldTick+=worldScale;
    if(this.state.player.dodgeCharges<this.state.player.maxDodgeCharges&&this.state.tick>=this.state.player.nextDodgeRechargeTick){
      this.state.player.dodgeCharges++;
      this.state.player.nextDodgeRechargeTick=this.state.player.dodgeCharges<this.state.player.maxDodgeCharges?this.state.tick+DODGE_RECHARGE_TICKS:0;
    }
    this.updateActors(worldScale);
    this.updateHazards();
    this.updateBossAI();
    this.updatePlayer(input);
    stepCompanions(this.state);
    this.updateMovableObjects();
    this.updatePhase();
    if(this.state.actionRecoveryUntil>0&&this.state.tick>=this.state.actionRecoveryUntil&&this.state.actionId!=='idle')this.finishAction();
    if(slowMotionActive&&this.state.timePolicy==='perfect-dodge-slow'){
      this.state.slowMotionRemainingTicks=Math.max(0,this.state.slowMotionRemainingTicks-1);
      this.state.slowMotionElapsedTicks++;
      if(this.state.slowMotionRemainingTicks===0){this.state.timePolicy='normal';this.state.slowMotionElapsedTicks=0;}
    }
    this.state.worldTimeScale=this.effectiveWorldTimeScale();
    for(const event of this.state.events.slice(firstEvent).flatMap(item=>item.worldEvent?[item.worldEvent]:[])){
      if(!this.state.worldEvents.some(existing=>existing.idempotencyKey===event.idempotencyKey))this.state.worldEvents.push(structuredClone(event));
    }
  }
  snapshot(): CombatSnapshot {
    const currentPhase=this.state.encounter?.phases[this.state.phaseIndex];
    const actors=this.state.actors.map(actor=>{
      const variantId=actor.id===this.state.encounter?.bossId?currentPhase?.actorVariantId:undefined;
      const renderVariantId=variantId??ACTORS[actor.archetypeId]?.assetId;
      const weakPointExposed=this.state.worldTick<(actor.weakPointUntil??0);
      return {id:actor.id,archetypeId:actor.archetypeId,species:actor.species,allegiance:actor.allegiance,position:copy(actor.position),velocity:copy(actor.velocity),facing:copy(actor.facing),actionId:actor.actionId,phase:actor.phase,normalizedTime:actor.normalizedTime,vitality:actor.vitality,ferocity:actor.ferocity,corruption:actor.corruption,targetId:actor.targetId,renderVariantId,sockets:structuredClone(actor.sockets),interactionRequirements:structuredClone(actor.interactionRequirements),visible:actor.visible,downed:actor.downed,possessed:actor.possessed,weakPointExposed};
    });
    const boss=this.currentBoss();
    return {
      actors,
      movableObjects:this.state.movableObjects.map(object=>({objectId:object.objectId,position:copy(object.position),phase:object.phase,...(object.rotationY===undefined?{}:{rotationY:object.rotationY})})),
      worldClock:{simulationTick:this.state.tick,worldTick:this.state.worldTick,worldTimeSeconds:this.state.worldTick*FIXED_STEP_SECONDS,timeScale:this.state.worldTimeScale,policy:this.state.timePolicy},
      player:{vitality:this.state.player.vitality,maxVitality:this.state.player.maxVitality,instinct:this.state.player.instinct,dodgeCharges:this.state.player.dodgeCharges,maxDodgeCharges:this.state.player.maxDodgeCharges},
      encounterId:this.state.encounterId,
      boss:boss?{actorId:boss.id,phaseId:currentPhase?.id??'resolved',phaseIndex:this.state.phaseIndex,ferocity:boss.ferocity??0,maxFerocity:100,corruption:boss.corruption??0,exposed:this.state.worldTick<boss.staggerUntil||this.state.worldTick<(boss.weakPointUntil??0),...(boss.corruptionCoreIds?{corruptionCores:boss.corruptionCoreIds.map(id=>({id,cleansed:boss.cleansedCoreIds?.includes(id)??false}))}:{})}:undefined,
      telegraphs:this.state.telegraphs.map(telegraph=>({id:telegraph.id,attackId:telegraph.attackId,sourceId:telegraph.sourceId,targetPosition:copy(telegraph.targetPosition),phase:telegraph.phase,remainingTicks:telegraph.remainingTicks})),
      hazards:this.state.hazards.map(hazard=>({id:hazard.id,kind:hazard.kind==='cone'?'area':hazard.kind,bounds:{min:copy(hazard.bounds.min),max:copy(hazard.bounds.max)},active:this.state.worldTick>=hazard.activeFrom&&this.state.worldTick<hazard.activeUntil})),
      targetId:this.state.targetId,events:structuredClone(this.state.worldEvents),
    };
  }
  serialize(): string { return JSON.stringify(this.state); }
  restore(serialized: string): void { this.state = hydrateEngineState(JSON.parse(serialized) as EngineStateSeed); }
  consumeEvents(): CombatEvent[] { const events = structuredClone(this.state.events); this.state.events.length=0; return events; }
  consumeWorldEvents(): WorldEvent[] { const events = structuredClone(this.state.worldEvents); this.state.worldEvents.length=0; return events; }
  drainPresentationCues(): readonly StoryCue[] { const cues=structuredClone(this.state.presentationCues);this.state.presentationCues.length=0;return cues; }
  queuePresentationCue(cue:Omit<StoryCue,'instanceId'|'tick'|'worldTimeSeconds'>):StoryCue{
    const normalized=structuredClone(cue);
    const hazard=cue.attackId?ATTACKS[cue.attackId]?.hazard:undefined;
    const footprint=normalized.shape==='sector'&&normalized.footprint&&hazard?{...normalized.footprint,length:2*(hazard.range??hazard.depth),sectorRadians:((hazard.angleDeg??70)*Math.PI)/180}:normalized.footprint;
    const instanceId=this.state.runId+':'+(this.state.encounterId??'free')+':cue:'+this.state.tick+':'+(++this.state.eventSequence);
    const event:StoryCue={...normalized,...(footprint?{footprint}:{}),instanceId,tick:this.state.tick,worldTimeSeconds:this.state.worldTick*FIXED_STEP_SECONDS};
    this.state.presentationCues.push(event);
    return structuredClone(event);
  }
  private captureEncounterCheckpoint(): EncounterCheckpoint {
    return { tick: this.state.tick, worldTick:this.state.worldTick, lastAttackTick:this.state.lastAttackTick, counterUntil:this.state.counterUntil, actors: this.state.actors.map(cloneActor), player: structuredClone(this.state.player), phaseIndex: this.state.phaseIndex, phaseLatch: this.state.phaseLatch, phaseActionFlags:[...this.state.phaseActionFlags], rewardEmitted: this.state.rewardEmitted, companions: structuredClone(this.state.companionState) };
  }
  resetToCheckpoint(): void {
    const checkpoint = this.state.checkpoint;
    if (!checkpoint) return;
    this.setTimePolicy('normal');
    this.state.tick = checkpoint.tick;
    const worldOffset=this.state.worldTick-checkpoint.worldTick;
    this.state.actors = checkpoint.actors.map(cloneActor);
    for(const actor of this.state.actors){actor.recoveringUntil=shiftDeadline(actor.recoveringUntil,worldOffset);if(actor.id!==this.state.playerId)actor.invulnerableUntil=shiftDeadline(actor.invulnerableUntil,worldOffset);actor.staggerUntil=shiftDeadline(actor.staggerUntil,worldOffset);actor.possessedUntil=shiftDeadline(actor.possessedUntil,worldOffset);if(actor.weakPointUntil!==undefined)actor.weakPointUntil=shiftDeadline(actor.weakPointUntil,worldOffset);if(actor.actionEndsTick>0){actor.actionStartedTick+=worldOffset;actor.actionEndsTick+=worldOffset;}}
    // This checkpoint value selects the next authored attack; it is not a world-clock deadline.
    this.state.lastAttackTick=checkpoint.lastAttackTick;
    this.state.counterUntil=checkpoint.counterUntil;
    this.state.player = structuredClone(checkpoint.player);
    this.state.phaseIndex = checkpoint.phaseIndex;
    this.state.phaseLatch = checkpoint.phaseLatch;
    this.state.phaseActionFlags = [...checkpoint.phaseActionFlags];
    this.state.rewardEmitted = checkpoint.rewardEmitted;
    this.state.companionState = structuredClone(checkpoint.companions);
    this.state.hazards = [];
    this.state.telegraphs = [];
    this.state.events = [];
    this.state.worldEvents = [];
    this.state.bufferedAction=undefined;this.state.heavyChargeStartTick=null;this.state.lightIndex=0;this.state.pendingImpact=undefined;this.state.actionCancelable=false;
    this.state.presentationCues = [];
    this.state.actionUntil = this.state.tick;
    this.state.actionRecoveryUntil = 0;
  }
  snapshotState(): EngineState { return structuredClone(this.state); }
  getActionClipMapping(): Readonly<Record<string,ActionId>> { return ACTION_CLIPS; }
  get pendingAssets(): readonly { action: string; clip: ActionId; status:'pending' }[] { return Object.entries(ACTION_CLIPS).map(([action,clip])=>({action,clip,status:'pending'})); }
  get simulationTick(): number { return this.state.tick; }
  setTimePolicy(policy:'normal'|'paused'):void{
    this.state.timePolicy=policy;this.state.slowMotionRemainingTicks=0;this.state.slowMotionElapsedTicks=0;this.state.worldTimeScale=policy==='paused'?0:1;this.state.accumulator=0;
  }
  private effectiveWorldTimeScale():number{
    if(this.state.timePolicy==='paused')return 0;
    if(this.state.timePolicy==='perfect-dodge-slow'&&this.state.slowMotionRemainingTicks>0)return PERFECT_DODGE_EFFECTS.worldTimeScale;
    return 1;
  }
  get companions(): CompanionRosterState { return structuredClone(this.state.companionState); }
  private updateActors(worldScale:number):void{
    for(const actor of this.state.actors){
      if(actor.downed)continue;
      if(actor.possessed&&actor.possessedUntil>0&&this.state.worldTick>=actor.possessedUntil)this.breakPossession(actor,true);
      const actionDuration=Math.max(1,actor.actionEndsTick-actor.actionStartedTick);
      if(actor.actionEndsTick>0)actor.normalizedTime=Math.min(1,actor.normalizedTime+worldScale/actionDuration);
      if(actor.actionEndsTick>0&&actor.normalizedTime>=1){
        actor.phase='idle';
        actor.actionId=ACTION_CLIPS.idle!;
        actor.normalizedTime=0;
        actor.actionStartedTick=this.state.worldTick;
        actor.actionEndsTick=0;
      }
    }
  }
  private updatePlayer(input: CombatInput): void {
    const player=this.playerActor();
    if(!player)return;
    if(input.targetCycle)this.cycleTarget(input.targetCycle);
    if(input.dodgePressed){this.tryDodge(player,input.dodgeDirection??directionFromMove(input.move));return;}
    if(this.state.counterUntil>this.state.tick&&(input.lightPressed||input.heavyPressed&&!input.heavyHeld)){
      const counterAction=input.heavyPressed?'heavy':'light_1';
      this.state.counterUntil=0;
      this.startPlayerAction(counterAction,this.state.targetId,true);
      return;
    }
    if(this.state.bufferedAction&&this.state.tick>this.state.bufferedAction.expiresTick)this.state.bufferedAction=undefined;
    const focusedInteraction=input.interactionId?INTERACTIONS.find(item=>item.id===input.interactionId):undefined;
    const staticTarget=focusedInteraction&&input.interactionTargetId===focusedInteraction.targetId&&!this.state.actors.some(actor=>actor.id===focusedInteraction.targetId||actor.archetypeId===focusedInteraction.targetId);
    const focusedActionId=focusedInteraction?.playerActionId??focusedInteraction?.actionId;
    if(staticTarget&&focusedActionId==='staff-heavy'&&input.heavyPressed&&!input.heavyHeld){
      if(focusedInteraction?.playerActionId==='staff-heavy')this.startPlayerObjectHeavyAction(focusedInteraction,'heavy',input.interactTargetId);
      else this.startInteractionAction(focusedInteraction,'heavy');
      return;
    }
    if(staticTarget&&focusedActionId==='cleanse-pulse'&&input.cleansePressed){this.startInteractionAction(focusedInteraction,'cleanse');return;}
    if(this.state.bufferedAction&&this.state.tick>=this.state.actionRecoveryUntil){
      const queued=this.state.bufferedAction;
      this.state.bufferedAction=undefined;
      if(this.startPlayerAction(queued.action,queued.targetId))return;
    }
    if(this.state.tick<this.state.actionRecoveryUntil){
      const remaining=this.state.actionRecoveryUntil-this.state.tick;
      if(remaining<=8){
        let action:string|undefined;
        let targetId=this.state.targetId;
        if(input.lightPressed){const next=(this.state.lightIndex??0)%3+1;this.state.lightIndex=next;action=`light_${next}`;}
        else if(input.heavyPressed)action='heavy';
        else if(input.tetherPressed)action='root_tether';
        else if(input.ferocityPressed)action='ferocity';
        else if(input.corruptionPressed)action='corruption';
        else if(input.cleansePressed){action='cleanse';targetId=input.interactTargetId??this.state.targetId;}
        if(action)this.state.bufferedAction={action,targetId,expiresTick:this.state.tick+8};
      }
    }
    if(input.heavyPressed&&input.heavyHeld&&this.state.heavyChargeStartTick===null&&this.state.tick>=this.state.actionRecoveryUntil){
      this.state.heavyChargeStartTick=this.state.tick;
      this.state.actionId='charged-heavy-charge';
      this.state.actionUntil=this.state.tick+3600;
      this.state.actionRecoveryUntil=this.state.actionUntil;
      this.state.actionCancelable=true;
      player.actionId='aren-charged-heavy-charge' as ActionId;
      player.actionStartedTick=this.state.worldTick;player.normalizedTime=0;
      player.actionEndsTick=this.state.worldTick+(this.state.actionUntil-this.state.tick);
      player.phase='anticipation';
      this.emit('cue','Charged Heavy: release Heavy to strike; Dodge cancels the charge.',player.id,this.state.targetId,'charged_heavy');
      return;
    }
    if(input.heavyReleased&&this.state.heavyChargeStartTick!==null){
      const heldTicks=input.heavyHeldTicks??this.state.tick-this.state.heavyChargeStartTick;
      this.state.heavyChargeStartTick=null;
      this.state.actionId='idle';
      this.state.actionUntil=this.state.tick;
      this.state.actionCancelable=false;
      this.state.actionRecoveryUntil=this.state.tick;
      if(staticTarget&&focusedActionId==='staff-heavy'){
        if(focusedInteraction?.playerActionId==='staff-heavy')this.startPlayerObjectHeavyAction(focusedInteraction,heldTicks>=36?'charged_heavy':'heavy',input.interactTargetId);
        else this.startInteractionAction(focusedInteraction,heldTicks>=36?'charged_heavy':'heavy');
      }
      else this.startPlayerAction(heldTicks>=36?'charged_heavy':'heavy',this.state.targetId);
      return;
    }
    if(this.state.heavyChargeStartTick!==null)return;
    const basis=this.state.arena.cameraBasis??{forward:vec(0,0,-1),right:vec(1,0,0)};
    let dx=input.move.x*basis.right.x+input.move.z*basis.forward.x;
    let dz=input.move.x*basis.right.z+input.move.z*basis.forward.z;
    const length=Math.hypot(dx,dz);
    if(length>1){dx/=length;dz/=length;}
    const locked=this.state.tick<this.state.actionRecoveryUntil;
    if(!locked){
      const speed=4.1;
      const moved=moveCircle(this.state.arena,player.position,vec(dx*speed*FIXED_STEP_SECONDS,0,dz*speed*FIXED_STEP_SECONDS),PLAYER_RADIUS,player.collisionHeight);
      const prior=player.position;
      player.velocity=vec((moved.x-prior.x)/FIXED_STEP_SECONDS,0,(moved.z-prior.z)/FIXED_STEP_SECONDS);
      player.position=moved;
      const target=this.state.actors.find(actor=>actor.id===this.state.targetId&&actor.visible&&!actor.downed);
      if(target)player.facing=facingFrom(sub(target.position,player.position));
      else if(Math.hypot(dx,dz)>.05)player.facing=facingFrom(vec(dx,0,dz));
      const moving=Math.hypot(dx,dz)>.05;
      if(moving){
        player.actionId=(target?'aren-strafe':'aren-walk') as ActionId;
        player.phase='idle';player.actionStartedTick=this.state.worldTick;player.actionEndsTick=0;player.normalizedTime=0;
      }else if(player.actionEndsTick===0||player.normalizedTime>=1){
        player.actionId=ACTION_CLIPS.idle!;player.phase='idle';
      }
      const attackIndex=this.state.lightIndex??0;
      if(input.lightPressed){const next=attackIndex%3+1;this.state.lightIndex=next;this.startPlayerAction(`light_${next}`,this.state.targetId);}
      else if(input.heavyPressed)this.startPlayerAction('heavy',this.state.targetId);
      else if(input.tetherPressed)this.startPlayerAction('root_tether',this.state.targetId);
      else if(input.ferocityPressed)this.startPlayerAction('ferocity',this.state.targetId);
      else if(input.corruptionPressed)this.startPlayerAction('corruption',this.state.targetId);
      else if(input.cleansePressed)this.startPlayerAction('cleanse',input.interactTargetId??this.state.targetId);
      else if(input.command)this.commandCompanion(input.command.companionId,input.command.command,input.command.targetId);
      else if(input.interactPressed&&input.traversalId)this.traverse(input.traversalId);
    }
  }
  private startPlayerObjectHeavyAction(interaction:InteractionDefinition,action:'heavy'|'charged_heavy',targetId?:ActorId):boolean{
    const success=interaction.success;
    if(success.type!=='object-move')return false;
    const object=this.state.movableObjects.find(candidate=>candidate.objectId===success.objectId);
    const player=this.playerActor();
    if(!object||!player||player.downed||this.koroAssignedToParty()||interaction.regionId!==this.state.regionId||!targetId||targetId!==object.objectId||interaction.id!==object.authored.playerInteractionId||interaction.targetId!==object.objectId||interaction.playerActionId!=='staff-heavy'||interaction.actionId!==undefined||object.phase!=='resting'||this.state.worldFacts[object.authored.movedFactId]===true||object.authored.requiredFacts.some(fact=>this.state.worldFacts[fact]!==true)||interaction.requiresFacts.some(fact=>this.state.worldFacts[fact]!==true)||this.state.tick<this.state.actionRecoveryUntil)return false;
    if(interaction.requiresActors.some(id=>{const required=this.actorForId(id);return !required||!required.visible||required.downed||required.possessed;}))return false;
    if(distance2(player.position,object.position)>interaction.radiusMeters)return false;
    const range=action==='charged_heavy'?2.8:2.5;
    const radius=action==='charged_heavy'?1.15:1;
    const duration=action==='charged_heavy'?58:45;
    const activeAt=this.state.tick+(action==='charged_heavy'?36:20);
    const attackId=('aren-'+action) as AttackId;
    const target=object.objectId as ActorId;
    this.state.targetId=target;this.state.actionId=action;this.state.actionUntil=this.state.tick+duration;this.state.actionRecoveryUntil=this.state.actionUntil+18;this.state.actionCancelable=false;
    player.actionId=ACTION_CLIPS[action]!;player.actionStartedTick=this.state.worldTick;player.normalizedTime=0;player.actionEndsTick=this.state.worldTick+duration+18;player.phase='anticipation';player.targetId=target;
    const cue='Aren draws the staff back toward the loose snare.';
    const id=this.state.runId+':'+this.state.tick+':'+interaction.id+':'+action;
    this.state.telegraphs.push({id,attackId,sourceId:player.id,targetPosition:copy(object.position),phase:'windup',remainingTicks:activeAt-this.state.tick,cue});
    this.state.pendingImpact={activeAt,activeUntil:activeAt+6,target,action,range,radius,damage:0,interrupt:false,counter:false,startVitality:this.state.player.vitality,resolved:false,interactionId:interaction.id,interactionPosition:copy(object.position)};
    this.emit('cue',cue,player.id,target,action,attackId);
    this.queuePresentationCue({kind:'anticipation',phase:'anticipation',actorId:player.id,targetId:target,position:copy(object.position),from:copy(player.position),to:copy(object.position),scopeId:this.state.encounterId,attackId,actionId:ACTION_CLIPS[action],footprint:{width:1,length:action==='charged_heavy'?2.8:2.5},durationTicks:activeAt-this.state.tick,priority:'essential',shape:'trail'});
    return true;
  }
  private startInteractionAction(interaction:InteractionDefinition,action:'heavy'|'charged_heavy'|'cleanse'):boolean{
    const player=this.playerActor();
    const playerAction=action==='cleanse'?'cleanse-pulse':'staff-heavy';
    if(!player||player.downed||interaction.actionId!==playerAction||this.state.tick<this.state.actionRecoveryUntil)return false;
    const region=REGIONS.find(candidate=>candidate.id===this.state.regionId);
    if(!region)return false;
    const targetActor=this.actorForId(interaction.targetId as ActorId);
    if(targetActor?.visible&&!targetActor.downed)return false;
    const entity=region.entities.find(candidate=>candidate.interactionId===interaction.id||candidate.id===interaction.id)??region.entities.find(candidate=>candidate.id===interaction.targetId);
    const position=entity?.position;
    if(!position||distance2(player.position,position)>interaction.radiusMeters)return false;
    if(action==='cleanse'&&this.state.player.instinct<20)return false;
    const duration=action==='charged_heavy'?58:action==='heavy'?45:90;
    const activeAt=this.state.tick+(action==='charged_heavy'?36:action==='heavy'?20:35);
    const attackId=`aren-${action}` as AttackId;
    this.state.targetId=interaction.targetId as ActorId;
    this.state.actionId=action;this.state.actionUntil=this.state.tick+duration;this.state.actionRecoveryUntil=this.state.actionUntil+18;this.state.actionCancelable=false;
    player.actionId=ACTION_CLIPS[action]!;player.actionStartedTick=this.state.worldTick;player.normalizedTime=0;player.actionEndsTick=this.state.worldTick+duration+18;player.phase='anticipation';player.targetId=this.state.targetId;player.facing=facingFrom(sub(position,player.position));
    const cue=action==='cleanse'?'Root light gathers around the world mechanism.':'Aren draws back the staff for a heavy strike.';
    const id=`${this.state.runId}:${this.state.tick}:${interaction.id}:${action}`;
    this.state.telegraphs.push({id,attackId,sourceId:player.id,targetPosition:copy(position),phase:'windup',remainingTicks:activeAt-this.state.tick,cue});
    this.state.pendingImpact={activeAt,activeUntil:activeAt+6,target:this.state.targetId,action,range:interaction.radiusMeters,radius:0,damage:action==='charged_heavy'?36:action==='heavy'?22:0,interrupt:action!=='cleanse',counter:false,startVitality:this.state.player.vitality,resolved:false,interactionId:interaction.id,interactionPosition:copy(position)};
    this.emit('cue',cue,player.id,this.state.targetId,action,attackId);
    this.queuePresentationCue({kind:action==='cleanse'?'cleanse':'anticipation',phase:'anticipation',actorId:player.id,targetId:this.state.targetId,position:copy(position),from:copy(player.position),to:copy(position),scopeId:this.state.encounterId,attackId,actionId:ACTION_CLIPS[action],footprint:{width:1,length:action==='charged_heavy'?2.8:2.5},durationTicks:activeAt-this.state.tick,priority:'essential',shape:action==='cleanse'?'pulse':'trail'});
    return true;
  }
  private tryDodge(player: CombatActor,direction:EvasionDirection): void {
    if(this.state.tick<this.state.actionUntil&&!this.state.actionCancelable)return;
    if(this.state.player.dodgeCharges<=0){this.emit('cue','No Dodge charges; create distance until one recovers.',player.id);return;}
    const profile=resolveProfile(direction,this.state.arena.traversalAffordances??[],player.position,this.state.hazards,this.state.worldTick);
    const start=copy(player.position);
    const vector=profileVector(profile.id,direction,player.facing,this.state.arena.cameraBasis);
    const moved=moveCircle(this.state.arena,player.position,scale(vector,profile.distance),PLAYER_RADIUS,profile.collisionHeight??player.collisionHeight);
    if(this.state.heavyChargeStartTick!==null){this.state.heavyChargeStartTick=null;this.emit('action','Charged Heavy cancelled by Dodge.',player.id,undefined,'charged_heavy');}
    this.state.player.dodgeCharges--;
    this.state.player.nextDodgeRechargeTick=this.state.tick+DODGE_RECHARGE_TICKS;
    this.state.bufferedAction=undefined;
    player.position=moved;
    player.velocity=scale(sub(moved,start),1/(profile.durationTicks*FIXED_STEP_SECONDS));
    player.actionStartedTick=this.state.worldTick;
    player.normalizedTime=0;
    player.actionEndsTick=this.state.worldTick+profile.durationTicks+profile.recoveryTicks;
    player.actionId=(ACTION_CLIPS[profile.id]??ACTION_CLIPS.stumble_recovery!) as ActionId;
    player.phase='start';
    player.invulnerableUntil=this.state.tick+profile.iframes;
    this.state.actionId=profile.id;
    this.state.actionUntil=this.state.tick+profile.durationTicks;
    this.state.actionRecoveryUntil=this.state.tick+profile.durationTicks+profile.recoveryTicks;
    this.state.actionCancelable=true;
    const threatened=this.findThreatenedHazard(start,player,profile.id);
    if(threatened){
      const key=threatened.sourceId+':'+threatened.attackId+':'+threatened.startTick+':'+threatened.hitGroup;
      if(!this.state.perfectDodgeKeys.includes(key)){
        this.state.perfectDodgeKeys.push(key);
        if(this.state.timePolicy!=='perfect-dodge-slow')this.state.slowMotionElapsedTicks=0;
        this.state.timePolicy='perfect-dodge-slow';
        const extension=Math.min(PERFECT_DODGE_EFFECTS.slowMotionTicks,PERFECT_DODGE_EFFECTS.maxSlowMotionTicks-this.state.slowMotionElapsedTicks-this.state.slowMotionRemainingTicks);
        this.state.slowMotionRemainingTicks+=Math.max(0,extension);
        this.state.worldTimeScale=this.effectiveWorldTimeScale();
        this.state.player.instinct=Math.min(100,this.state.player.instinct+PERFECT_DODGE_EFFECTS.instinctGain);
        this.state.counterUntil=this.state.tick+PERFECT_DODGE_EFFECTS.counterWindowTicks;
        const recoveryReduction=Math.min(PERFECT_DODGE_EFFECTS.playerRecoveryReductionTicks,Math.max(0,this.state.actionRecoveryUntil-this.state.tick));
        this.state.actionRecoveryUntil-=recoveryReduction;
        const companionId=this.state.companionState.combat??this.state.companionState.utility;
        const companionSlot=companionId?this.state.companionState.slots[companionId]:undefined;
        if(companionSlot)companionSlot.readyAt=Math.max(this.state.tick,companionSlot.readyAt-PERFECT_DODGE_EFFECTS.petRecoveryReductionTicks);
        const weakPointTarget=this.state.actors.find(actor=>actor.id===threatened.sourceId);
        if(weakPointTarget)weakPointTarget.weakPointUntil=Math.max(weakPointTarget.weakPointUntil??0,this.state.worldTick+PERFECT_DODGE_EFFECTS.weakPointDurationTicks);
        const side=dot(vector,this.state.arena.cameraBasis?.right??vec(1,0,0))<0?'left':'right';
        const perfectAction=`perfect_dodge_${side}` as EvasionProfileId;
        player.actionId=ACTION_CLIPS[perfectAction]!;
        this.emit('perfect-dodge','Perfect Dodge — threat cleared; counter window open.',player.id,threatened.sourceId,perfectAction,threatened.attackId);
        this.emit('counter-open','Choose a quick counter or coordinate with a ready companion.',player.id,threatened.sourceId);
        const possessed=this.state.actors.find(actor=>actor.id===threatened.sourceId&&actor.possessed);
        if(possessed)this.breakPossession(possessed);
      }
    }
    if(distance2(start,moved)<.05){player.actionId=ACTION_CLIPS.stumble_recovery!;player.phase='recovery';}
    this.emit('action',`Evasion: ${profile.id}`,player.id,undefined,profile.id);
  }
  private findThreatenedHazard(start:Vec3,player:CombatActor,profile:EvasionProfileId):LiveHazard|undefined{
    const initial={...player,position:start};
    return this.state.hazards.find(h=>{
      const threatened=hazardThreatens(h,initial);
      const iframes=EVASION_PROFILES[profile].iframes;
      const key=h.sourceId+':'+h.attackId+':'+h.startTick+':'+h.hitGroup;
      const grantsEffect=!this.state.perfectDodgeKeys.includes(key);
      const remainingSlowTicks=this.state.timePolicy==='perfect-dodge-slow'?this.state.slowMotionRemainingTicks:0;
      const episodeElapsed=this.state.timePolicy==='perfect-dodge-slow'?this.state.slowMotionElapsedTicks:0;
      const projectedSlowTicks=grantsEffect?remainingSlowTicks+Math.max(0,Math.min(PERFECT_DODGE_EFFECTS.slowMotionTicks,PERFECT_DODGE_EFFECTS.maxSlowMotionTicks-episodeElapsed-remainingSlowTicks)):remainingSlowTicks;
      const slowedIFrames=Math.min(iframes,projectedSlowTicks);
      const evasionUntil=this.state.worldTick+slowedIFrames*PERFECT_DODGE_EFFECTS.worldTimeScale+(iframes-slowedIFrames);
      const timely=this.state.worldTick<h.activeUntil&&evasionUntil>h.activeFrom;
      const cleared=!hazardThreatens(h,player)||avoids(profile,h);
      return timely&&threatened&&cleared&&!h.hitIds.includes(player.id);
    });
  }
  private startPlayerAction(action:string,targetId?:ActorId,counter=false):boolean{
    const player=this.playerActor();
    if(!player||player.downed)return false;
    if(!counter&&this.state.tick<this.state.actionRecoveryUntil)return false;
    if(action==='ferocity'&&this.state.player.ferocity<30)return false;
    if(action==='corruption'&&this.state.player.corruption<25)return false;
    if(action==='cleanse'&&this.state.player.instinct<20)return false;
    const target=targetId===undefined?undefined:this.actorForId(targetId);
    if(!target||!target.visible||target.downed)return false;
    if(action==='cleanse'&&(target.corruption??0)<=0&&!target.possessed)return false;
    if(action==='root_tether'){
      const telegraph=this.state.telegraphs.find(item=>item.sourceId===target.id&&(item.phase==='windup'||item.phase==='commit'));
      if(!telegraph)return false;
    }
    this.state.targetId=target.id;
    const duration=action.startsWith('light_')?27:action==='charged_heavy'?58:action==='heavy'?45:action==='cleanse'?90:action==='root_tether'?36:42;
    this.state.actionId=action;
    this.state.actionUntil=this.state.tick+duration;
    this.state.actionRecoveryUntil=this.state.actionUntil+18;
    this.state.actionCancelable=false;
    player.actionId=(ACTION_CLIPS[action]??`aren-${action}`) as ActionId;
    player.actionStartedTick=this.state.worldTick;player.normalizedTime=0;
    player.actionEndsTick=this.state.worldTick+duration+18;
    player.phase='anticipation';
    player.targetId=target.id;
    player.facing=facingFrom(sub(target.position,player.position));
    const attack=action==='light_1'?{range:2.1,radius:.75,damage:8,interrupt:true}:action==='light_2'?{range:2.3,radius:.85,damage:10,interrupt:true}:action==='light_3'?{range:2.6,radius:1,damage:14,interrupt:true}:action==='heavy'?{range:2.5,radius:1,damage:22,interrupt:true}:action==='charged_heavy'?{range:2.8,radius:1.15,damage:36,interrupt:true}:action==='ferocity'?{range:2.5,radius:1,damage:24,interrupt:true}:action==='corruption'?{range:2.5,radius:1,damage:18,interrupt:true}:action==='root_tether'?{range:6,radius:.4,damage:0,interrupt:true}:{range:2.5,radius:1,damage:0,interrupt:false};
    const activeAt=this.state.tick+(action==='charged_heavy'?36:action==='heavy'?20:action==='cleanse'?35:12);
    const attackId=`aren-${action}` as AttackId;
    const cue=action==='cleanse'?'Root light gathers around the target.':'Staff draws back before the strike.';
    this.state.telegraphs.push({id:`${this.state.runId}:${this.state.tick}:${action}`,attackId,sourceId:player.id,targetPosition:copy(target.position),phase:'windup',remainingTicks:activeAt-this.state.tick,cue});
    this.emit('cue',action==='cleanse'?'Cleanse: stay within reach until the pulse completes.':`Aren prepares ${action.replaceAll('_',' ')}.`,player.id,target.id,action,attackId);
    this.state.pendingImpact={activeAt,activeUntil:activeAt+6,target:target.id,action,range:attack.range,radius:attack.radius,damage:attack.damage,interrupt:attack.interrupt,counter,startVitality:this.state.player.vitality,resolved:false};
    return true;
  }
  private updateHazards():void{
    for(const hazard of this.state.hazards){
      if(this.state.worldTick<hazard.activeFrom||this.state.worldTick>=hazard.activeUntil)continue;
      const targetClass=ATTACKS[hazard.attackId]?.targetClass;
      for(const actor of this.state.actors){
        if(actor.downed||hazard.hitIds.includes(actor.id)||(targetClass==='companion'?actor.id!==hazard.targetActorId:actor.id!==this.state.playerId))continue;
        if(!hazardThreatens(hazard,actor))continue;
        const profileId=actor.id==='aren'?this.state.actionId as EvasionProfileId:'stumble_recovery';
        if((actor.id===this.state.playerId?this.state.tick:this.state.worldTick)<actor.invulnerableUntil&&avoids(profileId,hazard))continue;
        hazard.hitIds.push(actor.id);
        if(targetClass==='companion'&&hazard.attackId==='orun-crown-possession'){
          const phaseId=this.state.encounter?.phases[this.state.phaseIndex]?.id??'unknown';
          actor.possessed=true;actor.allegiance='hostile';actor.possessedUntil=this.state.worldTick+180;actor.targetId=this.state.playerId;actor.possessionInstanceId=hazard.id;actor.possessionSourceId=hazard.sourceId;
          const eventId=`${this.state.runId}:${this.state.encounterId}:possession:${hazard.id}:began`;
          this.emitWorldEvent({type:'possession',eventId,idempotencyKey:eventId,actorId:hazard.sourceId,targetId:actor.id,phaseId,state:'began',simulationTick:this.state.tick});
          this.emit('companion','Orun’s Crown holds the companion briefly; cleanse or coordinate a break before the hold ends.',hazard.sourceId,actor.id,'possession',hazard.attackId);
          this.queuePresentationCue({kind:'possession',phase:'hit',actorId:hazard.sourceId,targetId:actor.id,position:copy(actor.position),scopeId:this.state.encounterId,durationTicks:180,priority:'essential',shape:'pulse'});
          continue;
        }
        if(actor.id===this.state.playerId)this.state.player.vitality=Math.max(0,this.state.player.vitality-hazard.damage);
        else if(actor.possessed){this.breakPossession(actor);continue;}
        else actor.vitality=Math.max(0,(actor.vitality??100)-hazard.damage);
        this.emit('damage',hazard.cue,actor.id,hazard.sourceId,undefined,hazard.attackId);
        this.queuePresentationCue({kind:'hit',phase:'hit',actorId:hazard.sourceId,targetId:actor.id,position:copy(actor.position),from:copy(hazard.origin),to:copy(actor.position),scopeId:this.state.encounterId,attackId:hazard.attackId,footprint:{width:hazard.width,length:hazard.depth,angleRadians:Math.atan2(hazard.direction.x,hazard.direction.z)},priority:'essential',shape:storyShape(hazard.kind)});
      }
    }
    this.state.hazards=this.state.hazards.filter(hazard=>{const attack=ATTACKS[hazard.attackId];return this.state.worldTick<hazard.activeUntil+(attack?.recoveryTicks??0);});
    this.state.telegraphs=this.state.telegraphs.filter(telegraph=>{
      if(telegraph.sourceId===this.state.playerId)return !!this.state.pendingImpact;
      const hazard=this.state.hazards.find(current=>current.id===telegraph.id);
      if(!hazard)return false;
      const attack=ATTACKS[telegraph.attackId];
      return this.state.worldTick<hazard.activeUntil+(attack?.recoveryTicks??0);
    });
    for(const telegraph of this.state.telegraphs){
      if(telegraph.sourceId===this.state.playerId){
        const pending=this.state.pendingImpact;
        if(!pending)continue;
        telegraph.phase=this.state.tick<pending.activeAt?'windup':this.state.tick<pending.activeUntil?'active':'recovery';
        telegraph.remainingTicks=Math.max(0,(telegraph.phase==='windup'?pending.activeAt:telegraph.phase==='active'?pending.activeUntil:this.state.actionRecoveryUntil)-this.state.tick);
        const actor=this.playerActor();
        if(actor)actor.phase=telegraph.phase==='active'?'active':telegraph.phase==='recovery'?'recovery':'anticipation';
        continue;
      }
      const hazard=this.state.hazards.find(current=>current.id===telegraph.id);
      if(!hazard)continue;
      const attack=ATTACKS[telegraph.attackId];
      const commitAt=hazard.startTick+(attack?.windupTicks??0);
      const priorPhase=telegraph.phase;
      telegraph.phase=this.state.worldTick<commitAt?'windup':this.state.worldTick<hazard.activeFrom?'commit':this.state.worldTick<hazard.activeUntil?'active':'recovery';
      const phaseEnd=telegraph.phase==='windup'?commitAt:telegraph.phase==='commit'?hazard.activeFrom:telegraph.phase==='active'?hazard.activeUntil:hazard.activeUntil+(attack?.recoveryTicks??0);
      telegraph.remainingTicks=Math.max(0,phaseEnd-this.state.worldTick);
      const source=this.state.actors.find(actor=>actor.id===telegraph.sourceId);
      if(source)source.phase=telegraph.phase==='active'?'active':telegraph.phase==='recovery'?'recovery':'anticipation';
      if(priorPhase==='windup'&&telegraph.phase==='commit')this.queuePresentationCue({kind:'commit',phase:'commit',actorId:telegraph.sourceId,targetId:this.state.playerId,position:copy(telegraph.targetPosition),scopeId:this.state.encounterId,attackId:telegraph.attackId,footprint:{width:hazard.width,length:hazard.depth,angleRadians:Math.atan2(hazard.direction.x,hazard.direction.z)},priority:'essential',shape:storyShape(hazard.kind)});
    }
    const pending=this.state.pendingImpact;
    const player=this.playerActor();
    if(pending&&player&&pending.action==='cleanse'&&this.state.player.vitality<pending.startVitality){
      this.emit('cue','Cleanse interrupted by the incoming hit.',player.id,pending.target,'cleanse');
      this.state.pendingImpact=undefined;
    }else if(pending&&this.state.tick>=pending.activeAt&&!pending.resolved){
      this.resolvePlayerImpact(pending);
      pending.resolved=true;
    }
    if(pending?.resolved&&this.state.tick>=pending.activeUntil)this.state.pendingImpact=undefined;
  }
  private resolvePlayerImpact(p:PendingImpact):void{
    const player=this.playerActor();
    const target=this.state.actors.find(actor=>actor.id===p.target);
    const objectTarget=!target&&(p.action==='heavy'||p.action==='charged_heavy')?this.state.movableObjects.find(object=>object.objectId===p.target&&object.phase==='resting'&&object.authored.playerInteractionId===p.interactionId):undefined;
    const targetPosition=target?.position??objectTarget?.position??p.interactionPosition;
    const targetRadius=objectTarget?.authored.radiusMeters??0;
    if(!player||!targetPosition||target?.downed||distance2(player.position,targetPosition)>p.range+p.radius+targetRadius)return;
    const face=facingFrom(sub(targetPosition,player.position));
    const facingMiss=dot(face,player.facing)<.5;
    if(objectTarget?facingMiss:distance2(player.position,targetPosition)>.01&&facingMiss)return;
    if(!target){
      if(!p.interactionId)return;
      this.recordResolvedAction(p.action,p.target);
      if(p.action==='cleanse')this.state.player.instinct=Math.max(0,this.state.player.instinct-20);
      this.emit('action',`${p.action.replaceAll('_',' ')} lands on ${p.target}.`,player.id,p.target,p.action,`aren-${p.action}` as AttackId);
      this.queuePresentationCue({kind:p.action==='cleanse'?'cleanse':'hit',phase:'hit',actorId:player.id,targetId:p.target,position:copy(targetPosition),from:copy(player.position),to:copy(targetPosition),scopeId:this.state.encounterId,attackId:`aren-${p.action}` as AttackId,actionId:(ACTION_CLIPS[p.action]??'aren-hit') as ActionId,footprint:{width:1,length:p.range},priority:'essential',shape:p.action==='cleanse'?'pulse':'burst'});
      this.resolveInteraction(p.interactionId,p.target);
      return;
    }
    if(p.action==='cleanse'){
      if(target.possessed){
        this.breakPossession(target);
        this.recordResolvedAction(p.action,target.id);
        this.markPhaseAction('cleanse');
        this.queuePresentationCue({kind:'cleanse',phase:'resolve',actionId:'aren-cleanse' as ActionId,actorId:player.id,targetId:target.id,position:copy(target.position),scopeId:this.state.encounterId,priority:'essential',shape:'pulse'});
        return;
      }
      if((target.corruption??0)<=0)return;
      const coreIds=target.corruptionCoreIds;
      if(coreIds?.length){
        const cleansed=target.cleansedCoreIds??[];
        const nextCoreId=coreIds.find(id=>!cleansed.includes(id));
        if(!nextCoreId)return;
        target.cleansedCoreIds=[...cleansed,nextCoreId];
        target.corruption=Math.round(100*(coreIds.length-target.cleansedCoreIds.length)/coreIds.length);
      }else target.corruption=Math.max(0,(target.corruption??0)-40);
      this.recordResolvedAction(p.action,target.id);
      this.state.player.instinct-=20;
      this.emit('world','Corruption eased; environmental repair and trust remain separate.',player.id,target.id,'cleanse');
      const required=this.state.encounter?.phases[this.state.phaseIndex]?.requiredAction;
      if(target.corruption===0||required==='cleanse')this.markPhaseAction('cleanse');
      if(target.corruption===0&&target.id===this.state.encounter?.bossId)this.resolveEncounter('cleansed',target);
      this.queuePresentationCue({kind:'cleanse',phase:'resolve',actionId:'aren-cleanse' as ActionId,actorId:player.id,targetId:target.id,position:copy(target.position),scopeId:this.state.encounterId,intensity:target.corruption===0?1:.55,priority:'essential',shape:'pulse'});
      return;
    }
    if(p.action==='root_tether'){
      if(this.interruptAttack(target,'root_tether')){
        this.markPhaseAction('tether');
        this.recordResolvedAction(p.action,target.id);
        this.queuePresentationCue({kind:'tether',phase:'hit',actionId:'aren-root-tether' as ActionId,actorId:player.id,targetId:target.id,from:copy(player.position),to:copy(target.position),scopeId:this.state.encounterId,attackId:this.state.telegraphs.find(item=>item.sourceId===target.id)?.attackId,priority:'essential',shape:'beam'});
      }
      return;
    }
    if(p.action==='ferocity')this.state.player.ferocity-=30;
    if(p.action==='corruption')this.state.player.corruption-=25;
    const damage=target.weakPointUntil!==undefined&&target.weakPointUntil>this.state.worldTick?Math.ceil(p.damage*PERFECT_DODGE_EFFECTS.weakPointDamageMultiplier):p.damage;
    target.vitality=Math.max(0,(target.vitality??100)-damage);
    this.recordResolvedAction(p.action,target.id);
    if(target.ferocity!==undefined)target.ferocity=Math.max(0,target.ferocity-damage);
    if(p.counter)this.markPhaseAction('counter');
    if(p.action.startsWith('light_'))this.state.player.instinct=Math.min(100,this.state.player.instinct+8);
    if(p.interrupt)this.interruptAttack(target,p.action);
    if(target.vitality===0||target.ferocity===0){
      target.downed=true;
      target.allegiance='neutral';
      const participants=this.state.encounter?.actorIds.filter(id=>id!==this.state.playerId)??[];
      if(participants.length>0&&participants.every(id=>{const actor=this.state.actors.find(candidate=>candidate.id===id);return !!actor&&(actor.downed||actor.allegiance!=='hostile');}))this.resolveEncounter('subdued',target);
    }
    this.emit('damage',`${p.action.replaceAll('_',' ')} connects.`,player.id,target.id,p.action,`aren-${p.action}` as AttackId);
    this.queuePresentationCue({kind:'hit',phase:'hit',actorId:player.id,targetId:target.id,position:copy(target.position),from:copy(player.position),to:copy(target.position),scopeId:this.state.encounterId,attackId:`aren-${p.action}` as AttackId,actionId:(ACTION_CLIPS[p.action]??'aren-hit') as ActionId,footprint:{width:1.2,length:p.range},intensity:Math.min(1,p.damage/36),priority:'essential',shape:'burst'});
  }
  private updateBossAI():void{
    const encounter=this.state.encounter;
    if(!encounter||this.state.rewardEmitted)return;
    const phase=encounter.phases[this.state.phaseIndex];
    if(!phase)return;
    for(const sourceId of encounter.actorIds){
      if(sourceId===this.state.playerId)continue;
      const source=this.state.actors.find(actor=>actor.id===sourceId&&actor.visible&&actor.allegiance==='hostile');
      if(!source||source.downed||this.state.worldTick<source.recoveringUntil||this.state.telegraphs.some(telegraph=>telegraph.sourceId===source.id))continue;
      const attackIds=phase.attackIds.filter(id=>ATTACKS[id]?.bossId===source.id);
      if(!attackIds.length)continue;
      const attackIndex=Math.floor(this.state.lastAttackTick/120)%attackIds.length;
      const attackId=attackIds[attackIndex];if(!attackId)continue;
      let def:AttackDefinition|undefined=ATTACKS[attackId];
      if(def?.targetClass==='companion'&&!this.selectedCompanion())def=attackIds.map(id=>ATTACKS[id]).find(attack=>attack&&attack.targetClass!=='companion');
      if(!def)continue;
      this.beginAttack(source,def);
      this.state.lastAttackTick=this.state.worldTick;
    }
  }
  private beginAttack(source:CombatActor,def:AttackDefinition):void{
    const target=def.targetClass==='companion'?this.selectedCompanion():this.playerActor();
    if(!target)return;
    const id=`${source.id}:${def.id}:${this.state.tick}`;
    const aim=copy(target.position);
    const origin=copy(source.position);
    const direction=facingFrom(sub(aim,origin));
    const shape=structuredClone(def.hazard);
    const longAxis=shape.kind==='sweep'||shape.kind==='wave';
    const center=longAxis?vec((origin.x+aim.x)/2,aim.y,(origin.z+aim.z)/2):aim;
    const right={x:-direction.z,y:0,z:direction.x};
    const longHalf=shape.depth/2+shape.radius;
    const wideHalf=shape.width/2+shape.radius;
    const extentX=Math.abs(direction.x)*longHalf+Math.abs(right.x)*wideHalf;
    const extentZ=Math.abs(direction.z)*longHalf+Math.abs(right.z)*wideHalf;
    shape.bounds={min:vec(center.x-extentX,center.y-.15,center.z-extentZ),max:vec(center.x+extentX,center.y+Math.max(.1,shape.heightAboveGround),center.z+extentZ)};
    this.state.telegraphs.push({id,attackId:def.id as AttackId,sourceId:source.id,targetPosition:aim,phase:'windup',remainingTicks:def.windupTicks+def.commitTicks,cue:def.cue});
    this.emit('cue',def.cue,source.id,target.id,undefined,def.id as AttackId);
    this.queuePresentationCue({kind:'anticipation',phase:'anticipation',actorId:source.id,targetId:target.id,position:copy(aim),from:copy(origin),to:copy(aim),scopeId:this.state.encounterId,attackId:def.id as AttackId,footprint:{width:shape.width,length:shape.depth,angleRadians:Math.atan2(direction.x,direction.z)},durationTicks:def.windupTicks+def.commitTicks,intensity:1,priority:'essential',shape:storyShape(shape.kind)});
    const h:LiveHazard={...shape,id,attackId:def.id as AttackId,sourceId:source.id,startTick:this.state.worldTick,activeFrom:this.state.worldTick+def.windupTicks+def.commitTicks,activeUntil:this.state.worldTick+def.windupTicks+def.commitTicks+def.activeTicks,target:aim,origin,direction,range:shape.depth,angleDeg:shape.angleDeg??70,hitIds:[],threatTicks:[this.state.worldTick+def.windupTicks+def.commitTicks-8,this.state.worldTick+def.windupTicks+def.commitTicks-4],cue:def.cue,targetActorId:target.id};
    this.state.hazards.push(h);
    if(def.targetClass==='companion'&&this.state.encounterId){
      const phaseId=this.state.encounter?.phases[this.state.phaseIndex]?.id??'unknown';
      const eventId=`${this.state.runId}:${this.state.encounterId}:possession:${id}:telegraphed`;
      this.emitWorldEvent({type:'possession',eventId,idempotencyKey:eventId,actorId:source.id,targetId:target.id,phaseId,state:'telegraphed',simulationTick:this.state.tick});
    }
    source.actionId=ACTION_CLIPS[`boss:${def.id}`]!;
    source.phase='anticipation';
    source.targetId=target.id;
    source.facing=h.direction;
    source.recoveringUntil=h.activeUntil+def.recoveryTicks;
    source.normalizedTime=0;
    source.actionStartedTick=this.state.worldTick;
    source.actionEndsTick=source.recoveringUntil;
  }
  private interruptAttack(source:CombatActor,action:string):boolean{
    const tele=this.state.telegraphs.find(t=>t.sourceId===source.id);if(!tele)return false;
    const def=ATTACKS[tele.attackId];if(def?.interruptibleBy.length&&!def.interruptibleBy.includes(action as never))return false;
    const hazard=this.state.hazards.find(h=>h.id===tele.id);if(hazard)hazard.activeUntil=this.state.worldTick;
    this.state.telegraphs=this.state.telegraphs.filter(t=>t.id!==tele.id);source.phase='recovery';source.actionId=(source.id+'-stagger') as ActionId;source.normalizedTime=0;source.actionStartedTick=this.state.worldTick;source.staggerUntil=this.state.worldTick+42;source.recoveringUntil=source.staggerUntil;source.actionEndsTick=source.recoveringUntil;this.emit('attack-interrupted',tele.attackId+' interrupted before its active window.',this.state.playerId,source.id,action,tele.attackId);return true;
  }
  private markPhaseAction(action:string):void{
    if(!this.state.phaseActionFlags.includes(action))this.state.phaseActionFlags.push(action);
  }
  private updatePhase():void{
    const boss=this.currentBoss();if(!boss||!this.state.encounter)return;
    const expected=Math.min(this.state.encounter.phases.length-1,Math.floor((100-(boss.ferocity??100))/Math.max(1,100/this.state.encounter.phases.length)));
    if(expected<=this.state.phaseIndex)return;
    const phase=this.state.encounter.phases[this.state.phaseIndex];
    const required=phase?.requiredAction;
    if(required&&required!=='none'&&!this.state.phaseActionFlags.includes(required))return;
    const completed=this.state.encounter.phases[this.state.phaseIndex];
    if(completed)this.emitPhaseEvent(completed.id,this.state.phaseIndex,'cleared');
    const next=this.state.phaseIndex+1;
    this.state.phaseIndex=next;
    this.state.phaseLatch=next;
    this.state.phaseActionFlags=[];
    this.state.hazards=[];
    this.state.telegraphs=[];
    const nextPhase=this.state.encounter.phases[next];
    if(nextPhase)this.emitPhaseEvent(nextPhase.id,next,'entered');
    this.emit('cue',`Boss phase changed: ${nextPhase?.id}.`,boss.id);
    this.queuePresentationCue({kind:'phase',phase:'resolve',actorId:boss.id,targetId:this.state.playerId,position:copy(boss.position),scopeId:this.state.encounterId,priority:'essential',shape:'pulse'});
  }
  private emitPhaseEvent(phaseId:string,phaseIndex:number,state:'entered'|'cleared'):void{
    if(!this.state.encounterId)return;
    const eventId=`${this.state.runId}:${this.state.encounterId}:phase:${phaseIndex}:${state}`;
    this.emitWorldEvent({type:'encounter-phase',eventId,idempotencyKey:eventId,encounterId:this.state.encounterId,actorId:this.state.encounter?.bossId??'orun' as ActorId,phaseId,phaseIndex,state,simulationTick:this.state.tick});
  }
  private resolveEncounter(resolution:'cleansed'|'subdued'|'escaped'|'dominated',actor:CombatActor):void{
    if(this.state.rewardEmitted)return;
    this.state.rewardEmitted=true;
    const finalPhase=this.state.encounter?.phases[this.state.phaseIndex];
    if(finalPhase)this.emitPhaseEvent(finalPhase.id,this.state.phaseIndex,'cleared');
    const eventId=`${this.state.runId}:${this.state.encounterId}:resolved`;
    const actorIds=this.state.encounter?.actorIds.filter(id=>id!==this.state.playerId)??[actor.id];
    const event:WorldEvent={type:'encounter-resolved',eventId,idempotencyKey:eventId,encounterId:this.state.encounterId??'unknown',resolution,actorIds};
    this.emitWorldEvent(event);
    if(resolution==='cleansed'){
      const restoration:WorldEvent={type:'restoration',eventId:`${eventId}:restoration`,idempotencyKey:`${eventId}:restoration`,regionId:this.state.regionId,state:'restored',causeId:this.state.encounterId??'encounter'};
      this.emitWorldEvent(restoration);
    }
  }
  private traverse(id:string):boolean{
    const gate=this.state.traversalGates.find(g=>g.id===id);if(!gate||!gate.unlocked)return false;const player=this.playerActor();if(!player)return false;
    const d=distance2(player.position,gate.from);if(d>gate.width+1)return false;
    const moved=moveCircle(this.state.arena,player.position,sub(gate.to,player.position),PLAYER_RADIUS,player.collisionHeight);if(distance2(moved,gate.to)>1.25)return false;
    player.position=moved;this.emit('traversal',`Traversal ${id} completed.`,player.id,undefined,id);return true;
  }
  private cycleTarget(direction:-1|1):void{const candidates=this.state.actors.filter(a=>a.allegiance==='hostile'&&a.visible&&!a.downed).sort((a,b)=>distance2(this.playerActor()?.position??vec(0,0,0),a.position)-distance2(this.playerActor()?.position??vec(0,0,0),b.position));if(!candidates.length)return;let i=candidates.findIndex(a=>a.id===this.state.targetId);i=(i+direction+candidates.length)%candidates.length;const player=this.playerActor();const next=candidates[i]!;if(player&&dot(facingFrom(sub(next.position,player.position)),player.facing)<-.2)return;this.state.targetId=next.id;}
  private selectedCompanion():CombatActor|undefined{
    for(const id of [this.state.companionSlots.combat,this.state.companionSlots.utility,this.state.companionSlots.scout]){
      if(!id)continue;
      const actor=this.actorForId(id);
      if(actor?.visible&&!actor.downed&&!actor.possessed)return actor;
    }
    return undefined;
  }
  private currentBoss():CombatActor|undefined{return this.state.actors.find(a=>a.id===this.state.encounter?.bossId);}
  private playerActor():CombatActor|undefined{return this.state.actors.find(a=>a.id===this.state.playerId);}
  private emit(kind:CombatEvent['kind'],message:string,actorId?:ActorId,targetId?:ActorId,actionId?:string,attackId?:AttackId):void{const id=`${this.state.runId}:combat:${this.state.tick}:${++this.state.eventSequence}`;this.state.events.push({id,tick:this.state.tick,kind,message,actorId,targetId,actionId,attackId});}
  private recordResolvedAction(actionId:string,targetId:ActorId):void{this.state.lastResolvedActionId=actionId;this.state.lastResolvedTargetId=targetId;this.state.lastResolvedActionTick=this.state.tick;}
  private actorForId(id:ActorId):CombatActor|undefined{
    const exact=this.state.actors.find(actor=>actor.id===id);
    if(exact)return exact;
    let match:CombatActor|undefined;
    for(const actor of this.state.actors){
      if(actor.archetypeId!==id)continue;
      if(match)return undefined;
      match=actor;
    }
    return match;
  }

  private koroAssignedToParty():boolean{return this.state.companionSlots.combat==='koro'||this.state.companionSlots.utility==='koro';}
  private hasRecentHeavyImpact(targetId:string):boolean{
    const tick=this.state.lastResolvedActionTick;
    return (this.state.lastResolvedActionId==='heavy'||this.state.lastResolvedActionId==='charged_heavy')&&this.state.lastResolvedTargetId===targetId&&tick!==undefined&&this.state.tick>=tick&&this.state.tick-tick<=12;
  }
  private canStartMovableObjectMove(object:LiveMovableObject,interaction:InteractionDefinition,actor:CombatActor):boolean{
    const definition=object.authored;
    if(object.phase!=='resting'||this.state.worldFacts[definition.movedFactId]===true||definition.requiredFacts.some(fact=>this.state.worldFacts[fact]!==true)||interaction.requiresFacts.some(fact=>this.state.worldFacts[fact]!==true))return false;
    if(interaction.regionId!==this.state.regionId||interaction.targetId!==object.objectId||interaction.success.type!=='object-move'||interaction.success.objectId!==object.objectId||distance2(object.position,definition.from)>.02)return false;
    if(!actor.visible||actor.downed||actor.possessed||distance2(actor.position,object.position)>interaction.radiusMeters)return false;
    if(interaction.requiresActors.some(id=>{const required=this.actorForId(id);return !required||!required.visible||required.downed||required.possessed;}))return false;
    const commandGate=interaction.requiresCompanionCommand;
    const koroAction=actor.archetypeId===definition.requiredCompanionId&&definition.requiredCompanionId==='koro'&&interaction.id===definition.koroInteractionId&&this.state.companionSlots.utility==='koro'&&commandGate?.companionId==='koro'&&commandGate.slot==='utility'&&commandGate.command==='special';
    const playerAction=actor.id===this.state.playerId&&interaction.id===definition.playerInteractionId&&interaction.playerActionId==='staff-heavy'&&!this.koroAssignedToParty()&&this.hasRecentHeavyImpact(object.objectId);
    return (koroAction||playerAction)&&this.movableObjectPathClear(object,actor.id);
  }
  private movableObjectPathClear(object:LiveMovableObject,initiatorId:ActorId):boolean{
    const definition=object.authored;
    const surface=this.state.arena.surfaces.find(candidate=>candidate.id===definition.supportSurfaceId&&candidate.walkable);
    if(!surface||!pointInPolygonXZ(definition.from,surface.points)||!pointInPolygonXZ(definition.to,surface.points))return false;
    let previous=copy(definition.from);
    for(let index=1;index<=definition.animationTicks;index++){
      const progress=index/definition.animationTicks;
      const desired=vec(definition.from.x+(definition.to.x-definition.from.x)*progress,definition.from.y+(definition.to.y-definition.from.y)*progress,definition.from.z+(definition.to.z-definition.from.z)*progress);
      const swept=moveCircle(this.state.arena,previous,sub(desired,previous),definition.radiusMeters,.3);
      if(distance2(swept,desired)>.02||Math.abs(swept.y-desired.y)>.12||!pointInPolygonXZ(swept,surface.points)||this.movableObjectOccupied(object,swept,initiatorId))return false;
      previous=swept;
    }
    return true;
  }
  private movableObjectOccupied(object:LiveMovableObject,position:Vec3,initiatorId:ActorId):boolean{
    const definition=object.authored;
    for(const actor of this.state.actors){
      if(!actor.visible||actor.id===initiatorId||actor.id===definition.effect.targetActorInstanceId||distance2(actor.position,definition.from)<=definition.radiusMeters)continue;
      if(distance2(actor.position,position)<definition.radiusMeters+actor.radius)return true;
    }
    return false;
  }
  private startMovableObjectMove(object:LiveMovableObject,interaction:InteractionDefinition,actor:CombatActor):boolean{
    object.phase='in-flight';object.position=copy(object.authored.from);object.startedAtWorldTick=this.state.worldTick;object.interactionId=interaction.id;object.actorId=actor.id;
    return true;
  }
  private updateMovableObjects():void{
    for(const object of this.state.movableObjects){
      if(object.phase!=='in-flight')continue;
      const definition=object.authored;
      const startedAtWorldTick=object.startedAtWorldTick;
      const actorId=object.actorId;
      if(startedAtWorldTick===undefined||actorId===undefined||!object.interactionId){object.phase='resting';object.position=copy(definition.from);delete object.startedAtWorldTick;delete object.actorId;delete object.interactionId;continue;}
      const progress=Math.min(1,(this.state.worldTick-startedAtWorldTick)/definition.animationTicks);
      const desired=vec(definition.from.x+(definition.to.x-definition.from.x)*progress,definition.from.y+(definition.to.y-definition.from.y)*progress,definition.from.z+(definition.to.z-definition.from.z)*progress);
      const surface=this.state.arena.surfaces.find(candidate=>candidate.id===definition.supportSurfaceId&&candidate.walkable);
      const swept=moveCircle(this.state.arena,object.position,sub(desired,object.position),definition.radiusMeters,.3);
      if(!surface||distance2(swept,desired)>.02||Math.abs(swept.y-desired.y)>.12||!pointInPolygonXZ(swept,surface.points)||this.movableObjectOccupied(object,swept,actorId)){
        object.phase='resting';object.position=copy(definition.from);delete object.startedAtWorldTick;delete object.actorId;delete object.interactionId;continue;
      }
      object.position=progress>=1?copy(definition.to):copy(swept);
      if(progress<1)continue;
      object.phase='settled';
      const target=this.state.actors.find(candidate=>candidate.id===definition.effect.targetActorInstanceId&&candidate.visible&&!candidate.downed&&!candidate.possessed);
      const telegraphIndex=target&&distance2(target.position,object.position)<=definition.effect.radiusMeters?this.state.telegraphs.findIndex(candidate=>candidate.sourceId===target.id&&candidate.phase==='windup'):-1;
      if(telegraphIndex>=0&&target){
        const telegraph=this.state.telegraphs[telegraphIndex]!;
        this.state.telegraphs.splice(telegraphIndex,1);
        const hazardIndex=this.state.hazards.findIndex(candidate=>candidate.id===telegraph.id);
        if(hazardIndex>=0)this.state.hazards.splice(hazardIndex,1);
        this.state.counterUntil=this.state.tick+definition.effect.interruptRangedWindupTicks;
        target.staggerUntil=this.state.worldTick+definition.effect.interruptRangedWindupTicks;
        this.emit('attack-interrupted','The thrown snare distracts the ranged hunter and opens a counter.',actorId,target.id,'object-distraction',telegraph.attackId);
      }
      const eventId=this.state.runId+':object-moved:'+object.objectId;
      this.emitWorldEvent({type:'object-moved',eventId,idempotencyKey:eventId,regionId:this.state.regionId,objectId:object.objectId,interactionId:object.interactionId,actorId,from:copy(definition.from),to:copy(definition.to)});
    }
  }

  private interactionTargetActor(interaction:InteractionDefinition,targetId:string):CombatActor|undefined{
    const actor=this.actorForId(targetId as ActorId);
    return actor&&(actor.id===interaction.targetId||actor.archetypeId===interaction.targetId)&&actor.visible?actor:undefined;
  }
  private interactionTargetIdMatches(interaction:InteractionDefinition,targetId?:ActorId):boolean{
    if(targetId===interaction.targetId)return true;
    return targetId!==undefined&&this.actorForId(targetId)?.archetypeId===interaction.targetId;
  }
  private interactionMechanicSatisfied(interaction:InteractionDefinition,target?:CombatActor):boolean{
    if(this.state.worldFacts[`${interaction.id}:solved`]===true)return true;
    if(interaction.actionId==='contextual-interact'){
      if(interaction.kind==='inspect')return true;
      const success=interaction.success;
      if(success.type==='rescue'){
        if(success.targetId==='tali')return target?.archetypeId==='tali'&&this.isTaliSafe(target.position);
        const rescueTarget=this.actorForId(success.targetId as ActorId);
        return this.state.worldFacts[interaction.id+':freed']===true||!!rescueTarget?.downed;
      }
      if(success.type==='semantic-interaction'&&success.kind==='signal')return this.state.regionId===interaction.regionId&&interaction.requiresActors.some(id=>{const required=this.actorForId(id);return !!required&&required.visible&&!required.downed&&!required.possessed;});
      return false;
    }
    const tick=this.state.lastResolvedActionTick;
    if(tick===undefined||this.state.tick-tick<0||this.state.tick-tick>12||!this.interactionTargetIdMatches(interaction,this.state.lastResolvedTargetId))return false;
    if(interaction.actionId==='cleanse-pulse'){
      if(this.state.lastResolvedActionId!=='cleanse')return false;
      if(interaction.success.type==='restoration')return true;
      return (target?.corruption??1)<=0;
    }
    if(interaction.actionId==='staff-heavy')return this.state.lastResolvedActionId==='heavy'||this.state.lastResolvedActionId==='charged_heavy';
    return false;
  }
  private interactionEventId(interaction:InteractionDefinition):string{return `${this.state.runId}:interaction:${interaction.id}${interaction.repeatable?`:${this.state.tick}`:''}`;}
  private emitWorldEvent(worldEvent:WorldEvent):boolean{
    if(this.state.seenWorldKeys.includes(worldEvent.idempotencyKey))return false;
    this.state.seenWorldKeys.push(worldEvent.idempotencyKey);
    this.state.events.push({id:worldEvent.eventId,tick:this.state.tick,kind:'world',message:`World event: ${worldEvent.type}.`,worldEvent});
    this.state.worldEvents.push(structuredClone(worldEvent));
    return true;
  }
  private isTaliSafe(position:Vec3):boolean{
    const campDisable=INTERACTIONS.find(interaction=>interaction.id==='camp-disable');
    if(!campDisable||this.state.worldFacts.taliInBamboo!==true)return false;
    const disabled=this.state.seenWorldKeys.includes(this.interactionEventId(campDisable))||this.state.worldFacts['interaction:camp-disable']===true;
    const hostileHunters=this.state.actors.some(actor=>(actor.archetypeId==='poacher-hunter'||actor.archetypeId==='poacher-scout')&&actor.allegiance==='hostile'&&!actor.downed);
    return disabled&&!hostileHunters&&!this.hasActiveThreatNear(position);
  }
  private hasActiveThreatNear(position:Vec3):boolean{
    const player=this.playerActor();
    const probe=player?{...player,position}:makeActor('aren','human','player',position,false,false,100);
    return this.state.hazards.some(hazard=>this.state.worldTick<hazard.activeUntil&&hazardThreatens(hazard,probe))||this.state.telegraphs.some(telegraph=>(telegraph.phase==='windup'||telegraph.phase==='commit')&&distance2(position,telegraph.targetPosition)<=Math.max(ATTACKS[telegraph.attackId]?.hazard.width??0,ATTACKS[telegraph.attackId]?.hazard.depth??0)/2+1);
  }
  private finishAction():void{this.state.actionId='idle';this.state.actionUntil=this.state.tick;this.state.actionRecoveryUntil=0;this.state.actionCancelable=false;}
  private commandCompanionForInput(targetId:ActorId|undefined,command:CompanionCommand):boolean{const actor=this.state.companionSlots.combat??this.state.companionSlots.utility;if(!actor)return false;return this.commandCompanion(actor,command,targetId);}
  private breakPossession(actor:CombatActor,escaped=false):void{
    const instance=actor.possessionInstanceId;
    const source=actor.possessionSourceId;
    if(actor.possessed&&instance&&this.state.encounterId){
      const phaseId=this.state.encounter?.phases[this.state.phaseIndex]?.id??'unknown';
      const state=escaped?'escaped':'broken';
      const eventId=`${this.state.runId}:${this.state.encounterId}:possession:${instance}:${state}`;
      this.emitWorldEvent({type:'possession',eventId,idempotencyKey:eventId,actorId:source??('orun' as ActorId),targetId:actor.id,phaseId,state,simulationTick:this.state.tick});
    }
    actor.possessed=false;actor.allegiance='ally';actor.possessedUntil=0;actor.possessionInstanceId=undefined;actor.possessionSourceId=undefined;actor.staggerUntil=this.state.worldTick+24;
    this.emit('attack-interrupted',escaped?'Orun’s hold releases the companion; they escape unharmed.':'Orun’s hold breaks. Your companion is safe.',actor.id,source??('orun' as ActorId),'possession-break');
  }
  private enforceCaps():void{
    const hostiles=this.state.actors.filter(actor=>actor.allegiance==='hostile');
    const large=this.state.actors.filter(actor=>actor.large);
    const groundedLarge=large.filter(actor=>!actor.aerial);
    const aerialLarge=large.filter(actor=>actor.aerial);
    if(hostiles.length>MAX_HOSTILES)throw new Error(`Encounter exceeds ${MAX_HOSTILES} hostile actors.`);
    if(large.length>MAX_TOTAL_LARGE)throw new Error(`Encounter exceeds ${MAX_TOTAL_LARGE} total large actors.`);
    if(groundedLarge.length>MAX_GROUNDED_LARGE)throw new Error(`Encounter exceeds ${MAX_GROUNDED_LARGE} grounded large actors.`);
    if(aerialLarge.length>1)throw new Error('Encounter exceeds one aerial large actor.');
  }
}

export function createEngineState():EngineState{
  const player=makeActor('aren','human','player',vec(0,0,0),false,false,100);
  return {
    schemaVersion:2,tick:0,worldTick:0,worldTimeScale:1,timePolicy:'normal',slowMotionRemainingTicks:0,slowMotionElapsedTicks:0,accumulator:0,regionId:'greenwake',runId:'unstarted',encounter:null,worldFacts:{},
    actors:[player],playerId:'aren',player:{vitality:100,maxVitality:100,instinct:0,ferocity:100,corruption:0,dodgeCharges:2,maxDodgeCharges:2,nextDodgeRechargeTick:0},
    movableObjects:[],
    arena:{bounds:{min:vec(-12,0,-12),max:vec(12,0,12)},groundY:0,surfaces:[],colliders:[],routes:[],obstacles:[],cameraBasis:{forward:vec(0,0,-1),right:vec(1,0,0)},traversalAffordances:[]},
    hazards:[],telegraphs:[],events:[],worldEvents:[],seenWorldKeys:[],perfectDodgeKeys:[],phaseIndex:0,phaseLatch:0,phaseActionFlags:[],
    actionId:'idle',actionUntil:0,actionRecoveryUntil:0,actionCancelable:false,counterUntil:0,lastAttackTick:0,heavyChargeStartTick:null,
    companionState:createCompanionState({}),companionSlots:{},eventSequence:0,rewardEmitted:false,checkpoint:null,traversalGates:[],presentationCues:[],
  };
}
export function hydrateEngineState(seed:EngineStateSeed):EngineState{
  const base=createEngineState();const state={...base,...structuredClone(seed)} as EngineState;
  const legacy=seed.schemaVersion===1||seed.worldTick===undefined;
  state.schemaVersion=2;
  state.worldTick=legacy?seed.tick??base.tick:seed.worldTick??base.worldTick;
  state.timePolicy=legacy?'normal':seed.timePolicy??base.timePolicy;
  state.slowMotionRemainingTicks=legacy?0:seed.slowMotionRemainingTicks??base.slowMotionRemainingTicks;
  state.slowMotionElapsedTicks=legacy?0:seed.slowMotionElapsedTicks??0;
  if(state.timePolicy==='perfect-dodge-slow'&&state.slowMotionRemainingTicks<=0)state.timePolicy='normal';
  state.worldTimeScale=state.timePolicy==='paused'?0:state.timePolicy==='perfect-dodge-slow'?PERFECT_DODGE_EFFECTS.worldTimeScale:1;
  state.actors=(seed.actors??base.actors).map(cloneActor);state.player={...base.player,...seed.player};state.arena={...base.arena,...seed.arena};state.hazards=seed.hazards??[];state.telegraphs=seed.telegraphs??[];state.events=seed.events??[];state.worldEvents=seed.worldEvents??[];state.worldFacts=seed.worldFacts??{};state.seenWorldKeys=seed.seenWorldKeys??[];state.perfectDodgeKeys=seed.perfectDodgeKeys??[];state.phaseActionFlags=seed.phaseActionFlags??[];state.presentationCues=(seed.presentationCues??[]).map(cue=>({...cue,worldTimeSeconds:cue.worldTimeSeconds??cue.tick/60}));state.movableObjects=(seed.movableObjects??[]).map(object=>{const migrated={...object};if(migrated.startedAtWorldTick===undefined&&'startedAtTick' in migrated)migrated.startedAtWorldTick=(migrated as typeof migrated & {startedAtTick:number}).startedAtTick;delete (migrated as typeof migrated & {startedAtTick?:number}).startedAtTick;return migrated;});if(state.checkpoint){state.checkpoint.worldTick=state.checkpoint.worldTick??state.checkpoint.tick;state.checkpoint.lastAttackTick=state.checkpoint.lastAttackTick??state.checkpoint.tick;state.checkpoint.counterUntil=state.checkpoint.counterUntil??0;}return state;
}
export function makeActor(id:ActorId,species:string,allegiance:CombatActor['allegiance'],position:Vec3,large:boolean,aerial:boolean,vitality:number,archetypeId:ActorId=id):CombatActor{
  const idle=ACTION_CLIPS[`${archetypeId}-idle`]??ACTION_CLIPS['actor-idle']!;
  const collisionHeight=large?2.4:aerial?0.8:species==='macaque'?1:1.6;
  return {id,archetypeId,species,allegiance,position:copy(position),velocity:vec(0,0,0),facing:vec(0,0,-1),actionId:(id==='aren'?ACTION_CLIPS.idle:idle) as ActionId,phase:'idle',normalizedTime:0,vitality,ferocity:id==='aren'||species==='human'?undefined:100,corruption:undefined,targetId:undefined,sockets:{root:copy(position),head:vec(position.x,position.y+1.5,position.z)},interactionRequirements:[],visible:true,downed:false,possessed:false,radius:large?1.1:.42,collisionHeight,maxVitality:vitality,large,aerial,corruptionCoreIds:undefined,cleansedCoreIds:[],recoveringUntil:0,invulnerableUntil:0,staggerUntil:0,possessedUntil:0,actionStartedTick:0,actionEndsTick:0};
}
function cloneActor(a:CombatActor):CombatActor{return structuredClone(a);}
function copy(v:Vec3):Vec3{return{x:v.x,y:v.y,z:v.z};}
function pointInPolygonXZ(point:Vec3,points:readonly Vec3[]):boolean{
  if(points.length<3)return false;
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i]!,b=points[j]!;
    if((a.z>point.z)!==(b.z>point.z)&&point.x<(b.x-a.x)*(point.z-a.z)/(b.z-a.z)+a.x)inside=!inside;
  }
  return inside;
}
function sub(a:Vec3,b:Vec3):Vec3{return{x:a.x-b.x,y:a.y-b.y,z:a.z-b.z};}
function scale(v:Vec3,s:number):Vec3{return{x:v.x*s,y:v.y*s,z:v.z*s};}
function dot(a:Vec3,b:Vec3):number{return a.x*b.x+a.y*b.y+a.z*b.z;}
function directionFromMove(move:Vec3):EvasionDirection{
  const x=move.x,z=move.z;
  if(Math.abs(x)<.2&&Math.abs(z)<.2)return'back';
  if(Math.abs(x)>.2&&Math.abs(z)>.2)return z>0?(x<0?'forward-left':'forward-right'):(x<0?'back-left':'back-right');
  if(Math.abs(x)>Math.abs(z))return x<0?'left':'right';
  return z>0?'forward':'back';
}
function resolveProfile(direction:EvasionDirection,affordances:readonly {kind:string;bounds:Rect}[],position:Vec3,hazards:readonly LiveHazard[],worldTick:number):EvasionProfile{
  const nearby=hazards.find(h=>worldTick<h.activeUntil&&distance2(position,h.origin)<4.5);
  if(nearby?.kind==='wave'&&affordances.some(a=>a.kind==='staff-vault'&&pointInRect(position,a.bounds)))return EVASION_PROFILES.staff_vault;
  if(nearby?.kind==='sweep'&&affordances.some(a=>a.kind==='low-slide'&&pointInRect(position,a.bounds)))return EVASION_PROFILES.low_slide;
  if(direction==='forward-left')return EVASION_PROFILES.forward_left_dive_roll;
  if(direction==='forward-right')return EVASION_PROFILES.forward_right_dive_roll;
  if(direction==='back-left')return EVASION_PROFILES.back_left_pivot_roll;
  if(direction==='back-right')return EVASION_PROFILES.back_right_pivot_roll;
  if(nearby?.kind==='sweep'&&nearby.depth>nearby.width*1.4&&direction==='left')return EVASION_PROFILES.left_cartwheel;
  if(nearby?.kind==='sweep'&&nearby.depth>nearby.width*1.4&&direction==='right')return EVASION_PROFILES.right_cartwheel;
  if(direction==='left')return EVASION_PROFILES.quick_step_left;
  if(direction==='right')return EVASION_PROFILES.quick_step_right;
  return direction==='forward'?EVASION_PROFILES.forward_shoulder_roll:EVASION_PROFILES.back_handspring;
}
function shiftDeadline(deadline:number,offset:number):number{return deadline===0?0:deadline+offset;}
function pointInRect(p:Vec3,r:Rect):boolean{return p.x>=r.minX&&p.x<=r.maxX&&p.z>=r.minZ&&p.z<=r.maxZ;}
function profileVector(id:EvasionProfileId,direction:EvasionDirection,facing:Vec3,basis?:CameraBasis):Vec3{
  const right=basis?.right??vec(facing.z,0,-facing.x);
  const side=direction.includes('left')?-1:direction.includes('right')?1:0;
  const forward=direction.startsWith('forward')?1:direction.startsWith('back')?-1:0;
  if(id==='back_handspring')return scale(facing,-1);
  if(id==='forward_shoulder_roll'||id==='perfect_dodge_left'||id==='perfect_dodge_right'||id==='dodge_recovery'||id==='hard_landing'||id==='stumble_recovery')return id==='forward_shoulder_roll'?facing:vec(0,0,0);
  return normalize(add(scale(right,side),scale(facing,forward)));
}
function normalize(v:Vec3):Vec3{const n=Math.hypot(v.x,v.z)||1;return{x:v.x/n,y:0,z:v.z/n};}
function add(a:Vec3,b:Vec3):Vec3{return{x:a.x+b.x,y:a.y+b.y,z:a.z+b.z};}
function hazardThreatens(h:LiveHazard,a:CombatActor):boolean{
  const bodyTop=a.position.y+a.collisionHeight;
  const hazardBottom=h.origin.y-.15;
  const hazardTop=h.origin.y+Math.max(.15,h.heightAboveGround);
  if(bodyTop<hazardBottom||a.position.y>hazardTop)return false;
  if(h.kind==='strike'||h.kind==='projectile')return Math.abs(a.position.y-h.target.y)<=Math.max(.8,h.heightAboveGround)+a.radius&&distance2(a.position,h.target)<=h.radius+a.radius;
  if(h.kind==='cone')return pointInSector(a.position,h.origin,h.direction,h.range??h.depth,h.angleDeg??70);
  const dx=a.position.x-h.target.x;
  const dz=a.position.z-h.target.z;
  if(h.kind==='sweep'||h.kind==='wave'){
    const forward=dx*h.direction.x+dz*h.direction.z;
    const side=dx*-h.direction.z+dz*h.direction.x;
    return Math.abs(forward)<=h.depth/2+a.radius&&Math.abs(side)<=h.width/2+a.radius;
  }
  return Math.abs(dx)<=h.width/2+a.radius&&Math.abs(dz)<=h.depth/2+a.radius;
}
function avoids(id:EvasionProfileId,h:LiveHazard):boolean{
  const profile=EVASION_PROFILES[id];
  if(!profile)return false;
  if(h.kind==='wave')return id==='staff_vault';
  if(h.kind==='area'||h.kind==='cone')return false;
  if(h.kind==='sweep'&&id==='low_slide')return h.heightAboveGround>=.7;
  if(id==='staff_vault')return h.kind==='sweep';
  return profile.iframes>0||profile.verticalClearance>h.heightAboveGround;
}
function storyShape(kind:HazardDefinition['kind']):NonNullable<StoryCue['shape']>{
  switch(kind){
    case 'area':return 'ring';
    case 'cone':return 'sector';
    case 'sweep':return 'arc';
    case 'wave':return 'wave';
    case 'strike':case 'projectile':return 'burst';
  }
}
function isLargeSpecies(species:string):boolean{return species==='tiger'||species==='lion'||species==='boar'||species==='crocodile';}
