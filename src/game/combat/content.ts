import type { ActorId, RegionId } from '../contracts.js';
import type { HazardDefinition } from './evasion.js';
import { boss, strike } from './attack-builders.js';
import { ACT_ONE_ATTACKS, ASHA_ENCOUNTER, KORO_ENCOUNTER } from './ActOneBossContent.js';
import { GROVE_ATTACKS, GROVE_ENCOUNTERS } from './GroveContent.js';
import { MISTVEIL_ATTACKS, MISTVEIL_ENCOUNTERS } from './MistveilContent.js';
import { MOONPINE_ATTACKS, MOONPINE_ENCOUNTERS } from './MoonpineContent.js';
import { ORUN_ATTACKS, ORUN_ENCOUNTER, ORUN_ENCOUNTER_ID } from './OrunBossContent.js';

/** Monster elements plus the player elements: Aren's `arcane`/`lightning`, Yara's amber-green `heartroot` sorcery, Vesper's violet-black `umbral` and Sakda's flame-orange `ember`. */
export type AttackElement = 'fire' | 'ice' | 'wind' | 'poison' | 'arcane' | 'lightning' | 'heartroot' | 'umbral' | 'ember';

export interface AttackDefinition {
  id: string;
  bossId: ActorId;
  targetClass?: 'player' | 'companion';
  /** Elemental identity; undefined means a non-elemental physical attack. */
  element?: AttackElement;
  /** Hit cadence / pre-cast timing for sustained elemental attacks. */
  hitIntervalTicks?: number;
  castTicks?: number;
  /** Per-hit gameplay modifiers (slow, push). */
  onHit?: Readonly<{ slowFactor?: number; slowTicks?: number; pushMeters?: number }>;
  /** Committed lane shape: the sweep lane starts at the caster and reaches past the target instead of centring on it (trial monsters and Act I bosses). */
  laneFromSource?: boolean;
  /** Committed body movement (trial monsters and Act I bosses). `charge` runs the whole lane during the active window; `step` lunges up to `meters` during commit. */
  lunge?: Readonly<{ kind: 'charge' } | { kind: 'step'; meters: number }>;
  /** Environment hazard (a falling branch): the source only triggers it, no body clip plays. */
  environment?: boolean;
  /** Melee reach: the hazard centre lands at most this many metres from the caster's starting body (a slam or kick aimed past it falls short), never centred on a distant target. */
  reach?: number;
  windupTicks: number;
  commitTicks: number;
  activeTicks: number;
  recoveryTicks: number;
  cue: string;
  interruptibleBy: readonly string[];
  hazard: HazardDefinition;
}
export interface AuthoredBossPhase {id:string;attackIds:readonly string[];aspect?:string;actorVariantId?:string;requiredAction?:'cleanse'|'tether'|'counter'|'none';}
export interface BossEncounterDefinition {id:string;regionId:RegionId;bossId:ActorId;actorIds:readonly ActorId[];supportActorIds?:readonly ActorId[];phases:readonly AuthoredBossPhase[];largeActors:readonly ActorId[];playerOnlyCounters:readonly string[];safeAbsenceResolution:'cleansed'|'subdued'|'escaped';corruptionCoreIds?:readonly string[];/** Ordinary damage never downs, subdues or recruits this boss: only its authored cleanse sequence resolves it. */cleanseOnly?:true;/** The authored causal cleanse sequence this boss runs. */sequence?:'koro-thorn'|'asha-cub';/** Pressure-driven wildlife encounters (Greenwake and the Whispering Canopy playtest): shared cadence, concurrency caps and impact cues. */encounterFamily?:'wildlife';}
export const ATTACKS:Readonly<Record<string,AttackDefinition>>={
  'koro-fruit-burst':strike('koro-fruit-burst','koro','Koro winds up to scatter fruit. Watch the falling debris and move clear of the landing.',{kind:'area',width:3.4,depth:3.4,radius:0,heightAboveGround:.1,damage:10,hitGroup:'koro-fruit'},54,12,18,45),
  'ruun-track-charge':{...strike('ruun-track-charge','ruun','Ruun lowers his shoulders and tracks the committed line. Cross the path, do not retreat.',{kind:'sweep',width:2.2,depth:8,radius:0,heightAboveGround:1.2,damage:18,hitGroup:'ruun-charge'},66,18,15,60),laneFromSource:true,lunge:{kind:'charge'}},
  'ruun-pack-call':strike('ruun-pack-call','ruun','Ruun raises his head to call the pack. Keep moving as dust and arriving pounces converge.',{kind:'area',width:5,depth:5,radius:0,heightAboveGround:1,damage:13,hitGroup:'ruun-pack'},72,15,18,54),
  'ruun-claw-arc':{...strike('ruun-claw-arc','ruun','Ruun turns into a broad claw arc. Move beyond his paw or behind him.',{kind:'sweep',width:5.5,depth:2.6,radius:0,heightAboveGround:1.4,damage:13,hitGroup:'ruun-claw'},48,12,8,44),laneFromSource:true,lunge:{kind:'step',meters:1.5}},
  'ghor-hammering-charge':{...strike('ghor-hammering-charge','ghor','Ghor stamps a straight charge lane into the ground. Shift across the lane.',{kind:'sweep',width:2.7,depth:9,radius:0,heightAboveGround:1.6,damage:21,hitGroup:'ghor-charge'},72,18,18,63),laneFromSource:true,lunge:{kind:'charge'}},
  'ghor-stonefall':strike('ghor-stonefall','ghor','Ghor shakes loose stones. Watch the falling debris and leave the impact ground.',{kind:'area',width:4.3,depth:4.3,radius:0,heightAboveGround:0,damage:17,hitGroup:'ghor-stones'},60,18,15,54),
  'ghor-overhead-slam':{...strike('ghor-overhead-slam','ghor','Ghor lifts both forelegs. Retreat from the wide ground slam before they fall.',{kind:'area',width:6,depth:6,radius:0,heightAboveGround:0,damage:20,hitGroup:'ghor-slam'},66,18,12,57),lunge:{kind:'step',meters:3},reach:4.5},
  'solkar-commanding-roar':strike('solkar-commanding-roar','solkar','Solkar draws breath for a rallying roar. Step behind him or clear the space ahead.',{kind:'cone',width:8,depth:6,radius:0,heightAboveGround:2.5,damage:14,hitGroup:'solkar-roar'},60,15,15,54),
  'solkar-pride-rush':{...strike('solkar-pride-rush','solkar','Solkar crouches into a pride rush. Cross his facing line before he lunges.',{kind:'sweep',width:2.5,depth:8,radius:0,heightAboveGround:1.4,damage:18,hitGroup:'solkar-rush'},66,18,12,57),laneFromSource:true,lunge:{kind:'charge'}},
  'solkar-paw-slam':{...strike('solkar-paw-slam','solkar','Solkar raises one paw. Leave the ground he is aiming at before the slam.',{kind:'area',width:4.5,depth:4.5,radius:0,heightAboveGround:0,damage:18,hitGroup:'solkar-slam'},54,15,9,48),lunge:{kind:'step',meters:2},reach:3.4},
  ...ORUN_ATTACKS,
  'orun-root-surge':strike('orun-root-surge','orun','Heartroot roots gather beneath the earth. Move aside or jump as they surge upward.',{kind:'wave',width:7,depth:1.6,radius:0,heightAboveGround:.1,damage:18,hitGroup:'orun-root-surge'},66,18,12,54),
  'orun-crown-possession':{...strike('orun-crown-possession','orun','Orun reaches for the companion you brought. Avoid the gathering grasp or break the hold without harming your ally.',{kind:'area',width:4.8,depth:4.8,radius:0,heightAboveGround:1.4,damage:0,hitGroup:'orun-possession'},72,18,8,60),targetClass:'companion'},
  'boar-charge':{
    ...strike('boar-charge','corrupted-boar','The boar lowers its head and charges toward Aren’s last position. Dodge as it lunges.',{kind:'sweep',width:2.3,depth:7,radius:0,heightAboveGround:1.1,damage:16,hitGroup:'boar-charge'},60,15,24,48),
    laneFromSource:true,
    lunge:{kind:'charge'},
  },
  'boar-sap-thrash':strike('boar-sap-thrash','corrupted-boar','Black sap erupts beneath the place Aren stood. Dodge as the pulse lands.',{kind:'area',width:4.2,depth:4.2,radius:0,heightAboveGround:.2,damage:12,hitGroup:'boar-sap'},54,15,12,45),
  'boar-pounce':strike('boar-pounce','corrupted-boar','The corrupted boar bunches and pounces toward where Aren stood.',{kind:'strike',width:1.9,depth:1.9,radius:1.2,heightAboveGround:.2,damage:14,hitGroup:'boar-pounce'},54,15,9,48),
  'sap-vein-snap':strike('sap-vein-snap','greenwake-sap-stalker','The sap-stalker snaps a vein toward Aren’s last position. Keep moving.',{kind:'sweep',width:2.6,depth:2.4,radius:0,heightAboveGround:1.1,damage:11,hitGroup:'sap-vein'},48,12,8,42),
  'sap-vein-thrash':strike('sap-vein-thrash','greenwake-sap-stalker','Black sap bursts beneath the trail. Dodge before it erupts.',{kind:'area',width:3.4,depth:3.4,radius:0,heightAboveGround:.1,damage:10,hitGroup:'sap-vein-thrash'},54,15,12,45),
  'root-rammer-low-wave':{
    ...strike('root-rammer-low-wave','greenwake-root-rammer','The root rammer sends a low surge toward Aren’s last position. Dodge clear of its path.',{kind:'wave',width:5.4,depth:1.2,radius:0,heightAboveGround:.12,damage:13,hitGroup:'root-rammer-low-wave'},54,15,10,48),
    lunge:{kind:'step',meters:1.5},
  },
  'root-rammer-slam':strike('root-rammer-slam','greenwake-root-rammer','The root rammer drives its crown into the earth at Aren’s last position. Move before it lands.',{kind:'strike',width:2.2,depth:2.2,radius:1.05,heightAboveGround:.2,damage:15,hitGroup:'root-rammer-slam'},60,15,9,48),
  // Greenwake elemental attacks. Cue copy is plain English counterplay text; geometry and timing
  // are mirror-only metadata for downstream rendering/audio/presentation.
  'boar-ember-lance':{
    ...strike('boar-ember-lance','corrupted-boar','An ember torch glows on the boar’s crown. A narrow lane of fire sweeps toward where Aren stood. Sidestep or dive across before the flame fully ignites.',{kind:'sweep',width:1.7,depth:7,radius:0,heightAboveGround:1.1,damage:10,hitGroup:'boar-ember-lance'},54,15,18,48),
    element:'fire',
    laneFromSource:true,
  },
  'boar-gale-scythe':{
    ...strike('boar-gale-scythe','corrupted-boar','Wind gathers along the boar’s back before it skims a low crescent forward. Sidestep or jump as the gust rolls through.',{kind:'wave',width:6,depth:1.2,radius:0,heightAboveGround:.18,damage:9,hitGroup:'boar-gale-scythe'},54,15,18,48),
    element:'wind',
    onHit:{pushMeters:.9},
  },
  'sap-stalker-frost-bloom':{
    ...strike('sap-stalker-frost-bloom','greenwake-sap-stalker','Frost gathers around the stalker before crystals erupt where you stood. Move clear before the bloom; weave between the solid ice pillars.',{kind:'area',width:3,depth:3,radius:0,heightAboveGround:.65,damage:11,hitGroup:'sap-stalker-frost-bloom'},60,15,15,48),
    element:'ice',
    onHit:{slowFactor:.72,slowTicks:90},
  },
  'sap-stalker-venom-mist':{
    ...strike('sap-stalker-venom-mist','greenwake-sap-stalker','Toxic vapour gathers around the stalker before spilling where you stood. Leave the lingering cloud to avoid each poison pulse; the gas does not chase you.',{kind:'area',width:4,depth:4,radius:0,heightAboveGround:1.2,damage:4,hitGroup:'sap-stalker-venom-mist'},48,12,180,54),
    element:'poison',
    hitIntervalTicks:36,
    castTicks:12,
  },
  'root-rammer-cinder-burst':{
    ...strike('root-rammer-cinder-burst','greenwake-root-rammer','The root rammer stamps as embers gather around its body. Move clear of where you stood before the delayed cinder burst.',{kind:'strike',width:1.65,depth:1.65,radius:1.65,heightAboveGround:.2,damage:12,hitGroup:'root-rammer-cinder-burst'},60,15,18,48),
    element:'fire',
  },
  'root-rammer-gale-sweep':{
    ...strike('root-rammer-gale-sweep','greenwake-root-rammer','Wind curls around the rammer before it lunges. Jump above the low gust or step across its path.',{kind:'wave',width:6.8,depth:1.4,radius:0,heightAboveGround:.18,damage:10,hitGroup:'root-rammer-gale-sweep'},54,15,14,48),
    element:'wind',
    onHit:{pushMeters:1.2},
    lunge:{kind:'step',meters:1.2},
  },
  // Whispering Canopy playtest monsters. Non-elemental attacks carry earth/wind/poison visuals only; cues are plain counterplay text.
  'howler-rock-hurl':strike('howler-rock-hurl','canopy-howler','The howler heaves a sap-bound rock toward where Aren stood. Move off the mark before it lands.',{kind:'strike',width:1.5,depth:1.5,radius:1.4,heightAboveGround:.2,damage:12,hitGroup:'howler-rock-hurl'},48,12,10,40),
  'howler-leap-slam':{
    ...strike('howler-leap-slam','canopy-howler','The howler crouches and leaps toward where Aren stood. Dive away from the landing.',{kind:'strike',width:2.2,depth:2.2,radius:2,heightAboveGround:.2,damage:15,hitGroup:'howler-leap-slam'},54,12,9,48),
    lunge:{kind:'step',meters:5},
  },
  'howler-branch-sweep':strike('howler-branch-sweep','canopy-howler','The howler drags a low branch across the ground. Jump over it or step across.',{kind:'wave',width:6,depth:1.3,radius:0,heightAboveGround:.18,damage:11,hitGroup:'howler-branch-sweep'},48,12,12,44),
  'hornbill-dive-bomb':{
    ...strike('hornbill-dive-bomb','canopy-hornbill','The hornbill folds its wings for a dive along a straight lane. Sidestep the lane.',{kind:'sweep',width:2,depth:9,radius:0,heightAboveGround:1.1,damage:15,hitGroup:'hornbill-dive-bomb'},60,15,20,48),
    element:'wind',
    laneFromSource:true,
    lunge:{kind:'charge'},
  },
  'hornbill-feather-volley':{
    ...strike('hornbill-feather-volley','canopy-hornbill','Storm feathers fan out ahead of the hornbill. Get behind or beside it.',{kind:'cone',width:6,depth:7,radius:0,heightAboveGround:1.2,damage:10,hitGroup:'hornbill-feather-volley'},54,12,10,44),
    element:'wind',
  },
  'hornbill-gale-flap':{
    ...strike('hornbill-gale-flap','canopy-hornbill','A wingbeat drives a low gale along the ground. Jump it or move aside.',{kind:'wave',width:7,depth:1.6,radius:0,heightAboveGround:.2,damage:9,hitGroup:'hornbill-gale-flap'},54,15,14,48),
    element:'wind',
    onHit:{pushMeters:1.2},
  },
  'viper-venom-spit':{
    ...strike('viper-venom-spit','canopy-mire-viper','Venom splashes where Aren stood and lingers as a pool. Leave the pool to avoid each poison pulse; it does not chase you.',{kind:'area',width:3.6,depth:3.6,radius:0,heightAboveGround:1.2,damage:4,hitGroup:'viper-venom-spit'},48,12,180,54),
    element:'poison',
    hitIntervalTicks:36,
    castTicks:12,
  },
  'viper-tail-lash':strike('viper-tail-lash','canopy-mire-viper','The viper coils its tail low along the ground. Jump the lash.',{kind:'wave',width:6.5,depth:1.4,radius:0,heightAboveGround:.18,damage:12,hitGroup:'viper-tail-lash'},54,15,14,48),
  'viper-strike-lunge':{
    ...strike('viper-strike-lunge','canopy-mire-viper','The viper rears back for a lunging strike. Step out of the strike line.',{kind:'sweep',width:1.4,depth:6,radius:0,heightAboveGround:.8,damage:16,hitGroup:'viper-strike-lunge'},36,12,8,48),
    laneFromSource:true,
    lunge:{kind:'step',meters:3.5},
  },
  'poacher-scout-net':strike('poacher-scout-net','hunter-ranged','The ranged scout winds up a weighted net. Step across its flight before it closes.',{kind:'projectile',width:1.4,depth:7,radius:.65,heightAboveGround:1.5,damage:8,hitGroup:'poacher-net'},48,12,9,42),
  'poacher-hunter-spear':strike('poacher-hunter-spear','hunter-melee-west','The west hunter draws back his spear. Move beyond its reach before the sweep.',{kind:'sweep',width:2.4,depth:2.4,radius:0,heightAboveGround:1.3,damage:10,hitGroup:'poacher-spear-west'},42,12,8,42),
  'poacher-hunter-east-spear':strike('poacher-hunter-east-spear','hunter-melee-east','The east hunter turns into a side-on spear sweep. Move behind him or beyond its reach.',{kind:'sweep',width:2.4,depth:2.4,radius:0,heightAboveGround:1.3,damage:10,hitGroup:'poacher-spear-east'},48,12,8,42),
  ...ACT_ONE_ATTACKS, ...GROVE_ATTACKS, ...MOONPINE_ATTACKS, ...MISTVEIL_ATTACKS,
  // Nyra's Shadow Ambush as a hostile move (Chapter 6 possession): the CompanionSystem `shadow-ambush` support strike
  // (reach target radius + 2.4 m, 10 damage, SUPPORT_RECOVERY 45 ticks) turned on Aren from the rear.
  'nyra-shadow-ambush':{
    ...strike('nyra-shadow-ambush','nyra','Nyra sinks into the shadows behind Aren before an ambush lunge. Turn and step out of her line.',{kind:'strike',width:2,depth:2,radius:1.2,heightAboveGround:.6,damage:10,hitGroup:'nyra-ambush'},36,12,8,45),
    lunge:{kind:'step',meters:2.4},
  },
};
export const BOSS_ENCOUNTERS:Readonly<Record<string,BossEncounterDefinition>>={
  'encounter-koro':KORO_ENCOUNTER,
  'encounter-asha':ASHA_ENCOUNTER,
  // Ruun, Ghor and Solkar are cleanse-only: ordinary damage wears them down, and only a Cleanse in their final phase, after its
  // required action and once their ferocity is worn down, resolves them (CombatEngine `cleanseBlockFor`).
  'encounter-ruun':{...boss('ruun','moonpine-ridge',[{id:'separated-tracks',attackIds:['ruun-track-charge','ruun-claw-arc']},{id:'pack-pressure',attackIds:['ruun-pack-call','ruun-track-charge'],requiredAction:'counter'}],['ruun']),cleanseOnly:true},
  'encounter-ghor':{...boss('ghor','mistveil-basin',[{id:'marsh-territory',attackIds:['ghor-hammering-charge','ghor-stonefall']},{id:'flooded-den',attackIds:['ghor-overhead-slam','ghor-hammering-charge'],requiredAction:'tether'}],['ghor']),cleanseOnly:true},
  'encounter-solkar':{...boss('solkar','sunmane-expanse',[{id:'contested-leadership',attackIds:['solkar-commanding-roar','solkar-paw-slam']},{id:'pride-in-motion',attackIds:['solkar-pride-rush','solkar-commanding-roar'],requiredAction:'counter'}],['solkar']),cleanseOnly:true},
  [ORUN_ENCOUNTER_ID]:ORUN_ENCOUNTER,
  // Chapter 6 Fall of the Grove (Bible ch. 6): Orun seizes a present recruit through Aren's bond (`orun-crown-possession`);
  // the held ally attacks with its own authored move until a timed Cleanse, a Perfect Dodge or its Bond-timed escape breaks
  // the hold. With no eligible recruit present Orun turns `orun-root-surge` on Aren, answered by evading or countering it.
  // Phase 1 is protection-free: Tali reaches her shelter, the pillar is braced and Aren escapes onto the lookout pad.
  'encounter-fall':{...boss('orun','the-grove',[{id:'possession-pulse',aspect:'Possession pulse',attackIds:['orun-crown-possession','orun-root-surge']},{id:'collapse-escape',aspect:'Tali shelter, pillar brace and escape',attackIds:[]}],[],['player-dodge','player-cleanse','player-light']),id:'encounter-fall',safeAbsenceResolution:'escaped',cleanseOnly:true,supportActorIds:['tali']},
  'camp-hunters':{...boss('hunter-melee-west','blood-bamboo-valley',[{id:'camp-cordon',attackIds:['poacher-scout-net','poacher-hunter-spear','poacher-hunter-east-spear']}],[],['player-dodge','player-light','player-heavy']),id:'camp-hunters',actorIds:['aren','hunter-melee-west','hunter-melee-east','hunter-ranged'],supportActorIds:['tali']},
};
export const WILDLIFE_ENCOUNTERS:Readonly<Record<string,BossEncounterDefinition>>={
  'greenwake-boar':{
    ...boss('corrupted-boar','greenwake',[
      // Phase 1 (charge-lane): original physical lunges plus every elemental attack.
      {
        id:'charge-lane',
        attackIds:[
          'boar-charge','boar-pounce','sap-vein-snap','root-rammer-low-wave',
          'boar-ember-lance','boar-gale-scythe','sap-stalker-frost-bloom',
          'sap-stalker-venom-mist','root-rammer-cinder-burst','root-rammer-gale-sweep',
        ],
      },
      // Phase 2 (sap-opening, tether required): original physical coverage plus every elemental attack.
      {
        id:'sap-opening',
        attackIds:[
          'boar-sap-thrash','sap-vein-snap','sap-vein-thrash','root-rammer-slam',
          'boar-ember-lance','boar-gale-scythe','sap-stalker-frost-bloom',
          'sap-stalker-venom-mist','root-rammer-cinder-burst','root-rammer-gale-sweep',
        ],
        requiredAction:'tether',
      },
      // Phase 3 (root-pressure): original physical coverage plus every elemental attack.
      {
        id:'root-pressure',
        attackIds:[
          'boar-pounce','sap-vein-thrash','root-rammer-low-wave','root-rammer-slam',
          'boar-ember-lance','boar-gale-scythe','sap-stalker-frost-bloom',
          'sap-stalker-venom-mist','root-rammer-cinder-burst','root-rammer-gale-sweep',
        ],
      },
      // Phase 4 (cleanse-window, nonlethal): original physical coverage plus every elemental attack.
      {
        id:'cleanse-window',
        attackIds:[
          'boar-charge','sap-vein-snap','root-rammer-low-wave',
          'boar-ember-lance','boar-gale-scythe','sap-stalker-frost-bloom',
          'sap-stalker-venom-mist','root-rammer-cinder-burst','root-rammer-gale-sweep',
        ],
        requiredAction:'cleanse',
      },
    ],['corrupted-boar','greenwake-sap-stalker','greenwake-root-rammer'],['player-dodge','player-tether','player-cleanse','player-light']),
    id:'greenwake-boar',
    actorIds:['aren','corrupted-boar','greenwake-sap-stalker','greenwake-root-rammer'],
    encounterFamily:'wildlife',
  },
  // Whispering Canopy playtest: three combat trials (see CombatTrials.ts). Trial play drives the authored roster directly.
  'canopy-trials':{
    ...boss('canopy-howler','whispering-canopy',[
      {id:'howler-pool',attackIds:['howler-rock-hurl','howler-leap-slam','howler-branch-sweep']},
      {id:'hornbill-roost',attackIds:['hornbill-dive-bomb','hornbill-feather-volley','hornbill-gale-flap']},
      {id:'viper-temple',attackIds:['viper-venom-spit','viper-tail-lash','viper-strike-lunge']},
    ],[],['player-dodge','player-tether','player-cleanse','player-light']),
    id:'canopy-trials',
    actorIds:['aren','canopy-howler','canopy-hornbill','canopy-mire-viper'],
    encounterFamily:'wildlife',
  },
  ...GROVE_ENCOUNTERS, ...MOONPINE_ENCOUNTERS, ...MISTVEIL_ENCOUNTERS,
};
export const MAJOR_BOSS_ENCOUNTER_IDS:readonly string[]=['encounter-koro','encounter-asha','encounter-ruun','encounter-ghor','encounter-solkar','encounter-orun','encounter-fall'];
export const ENCOUNTER_IDS:readonly string[]=[...Object.keys(BOSS_ENCOUNTERS),...Object.keys(WILDLIFE_ENCOUNTERS)];
