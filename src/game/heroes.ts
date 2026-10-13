import type { GameAction } from '../input/RuntimeInput.js';
import { EVASION_PROFILES } from './combat/evasion.js';
import { HEARTROOT } from './combat/HeartrootSkills.js';
import { HERO_COMBAT } from './combat/HeroProfiles.js';
import { SAKDA } from './combat/SakdaSkills.js';
import { VESPER } from './combat/VesperSkills.js';
import {
  CRESCENT_WAVE, JUDGEMENT, JUDGEMENT_INSTINCT, LIGHT_STEPS, MANA_PER_METRE, MAX_MANA,
  PLAYER_SKILLS, SIGIL, TARGETED_STRIKES, THUNDER_CLEAVE,
} from './combat/PlayerSkills.js';

/**
 * Playable heroes. The simulation keeps one player actor instance, `aren` (the player slot used by every system);
 * the chosen hero decides its skill kit, its render variant and the HUD/menus wording. A hero is chosen when a map is
 * entered and stays fixed for that run.
 */
export type HeroId = 'aren' | 'yara' | 'vesper' | 'sakda';

/** Visual family of a hero: its afterimage ghosts, weapon and VFX palette. */
export type HeroStyle = 'warden' | 'heartroot' | 'umbral' | 'ember';
/** How the hero's native weapon prop is held; `katana` is a one-handed blade held in a rigid fist. */
export type HeroWeaponGrip = 'glaive' | 'staff' | 'katana';

export interface HeroSkillSummary {
  /** The bound game action that triggers the skill (HUD and select screen show its key). */
  readonly action: GameAction;
  readonly name: string;
  readonly description: string;
  /** Mana or Instinct price as shown on the select screen. */
  readonly cost: string;
  /** Live combat numbers, derived from the simulation constants. */
  readonly detail: string;
  /** Native action ids the select-screen preview plays, in order. */
  readonly previewActionIds: readonly string[];
}

export interface HeroStat { readonly label: string; readonly value: string }
/** Relative playstyle rating between all four heroes, 1–5. */
export interface HeroRating { readonly label: string; readonly value: 1 | 2 | 3 | 4 | 5 }

export interface HeroDefinition {
  readonly id: HeroId;
  readonly name: string;
  readonly title: string;
  /** One line playstyle summary. */
  readonly summary: string;
  readonly role: string;
  readonly power: string;
  readonly reach: string;
  readonly difficulty: string;
  readonly playstyle: string;
  readonly strengths: readonly string[];
  readonly cautions: readonly string[];
  /** Canon biography paragraphs (Game Bible §5, narrative §4). */
  readonly biography: readonly string[];
  readonly quote: { readonly text: string; readonly speaker: string };
  /** CSS colour of the hero's element (glaive edge / Heartroot sap-light). */
  readonly accent: string;
  readonly stats: readonly HeroStat[];
  readonly ratings: readonly HeroRating[];
  /** Render variant (manifest `variantOf: 'actor-aren'`, `actorId: 'aren'`) drawn for the player slot; absent = canonical `actor-aren`. */
  readonly variantAssetId?: string;
  /** Native weapon prop attached to the hero's hand; absent for an unarmed hero (Sakda). */
  readonly weaponAssetId?: string;
  readonly weaponGrip?: HeroWeaponGrip;
  /** Afterimage, weapon and VFX palette family. */
  readonly style: HeroStyle;
  /** True when the dodge hides the body mid-way (Petal Step, Mist Blink) instead of showing a roll. */
  readonly dodgeVanish: boolean;
  /** Name of the F skill on the HUD and the select screen. */
  readonly dodgeLabel: string;
  /** Health pool shown on the select screen; the simulation uses the same `HERO_COMBAT` value. */
  readonly maxVitality: number;
  /** Authored NPC actor removed from a map while this hero is played (Yara cannot meet herself). */
  readonly npcActorId?: string;
  /** Select-screen portrait (served by the dev server) and the CSS background-position that frames its head at 300 % size. */
  readonly portraitUrl: string;
  readonly portraitCrop: string;
  /** Preview idle loop and the flourish played when the hero is brought forward. */
  readonly idleActionId: string;
  readonly revealActionIds: readonly string[];
  readonly skills: readonly HeroSkillSummary[];
}

export const YARA_HERO_ASSET_ID = 'actor-yara-hero';
export const HEARTROOT_STAFF_ASSET_ID = 'prop-heartroot-focus-staff';
export const WARDEN_GLAIVE_ASSET_ID = 'prop-warden-glaive';
export const VESPER_HERO_ASSET_ID = 'actor-vesper-hero';
export const SAKDA_HERO_ASSET_ID = 'actor-sakda-hero';
export const VESPER_KATANA_ASSET_ID = 'prop-vesper-katana';

const TICK_SECONDS = 1 / 60;
const metres = (value: number): string => `${Number(value.toFixed(1))} m`;
const seconds = (ticks: number): string => `${Number((ticks * TICK_SECONDS).toFixed(1))} s`;
const mana = (...costs: number[]): string => `${costs.join(' / ')} MP`;
const evade = EVASION_PROFILES.forward_left_dive_roll;
const thornReach = HEARTROOT.projectileSpeed * HEARTROOT.projectileTicks * TICK_SECONDS;
const bladeReach = `${metres(Math.min(...LIGHT_STEPS.map(step => step.reach))).replace(' m', '')}–${metres(Math.max(...LIGHT_STEPS.map(step => step.reach)))}`;
const evadeDetail = `${metres(evade.distance)} · ${seconds(evade.iframes)} untouchable`;
const tetherDetail = `Interrupts a winding-up foe within ${metres(TARGETED_STRIKES.root_tether.range)} · cleanses an exposed one`;
const commonStats = (id: HeroId): readonly HeroStat[] => [
  { label: 'Vitality', value: String(HERO_COMBAT[id].maxVitality) },
  { label: 'Mana', value: `${MAX_MANA} · regains ${MANA_PER_METRE} per metre moved` },
  { label: 'Movement', value: `${HERO_COMBAT[id].walkSpeed} m/s walk · ${HERO_COMBAT[id].runSpeed} m/s run` },
];
const iaiReach = `${Math.min(...VESPER.iai.steps.map(step => step.reach))}–${metres(Math.max(...VESPER.iai.steps.map(step => step.reach)))}`;
const limbReach = `${Math.min(...SAKDA.limbs.steps.map(step => step.reach))}–${metres(Math.max(...SAKDA.limbs.steps.map(step => step.reach)))}`;
const cutsTotal = VESPER.thousandCuts.strikeAt.length * VESPER.thousandCuts.strikeDamage + VESPER.thousandCuts.finisherDamage;
const elbowsTotal = SAKDA.hundredElbows.hitAt.length * SAKDA.hundredElbows.hitDamage + SAKDA.hundredElbows.uppercutDamage;

export const HEROES: readonly HeroDefinition[] = [
  {
    id: 'aren', name: 'Aren', title: 'Warden of the Wild',
    summary: 'A close-range Warden who keeps pressure on with glaive combos, homing sigils, Thunder Cleave and a dashing Judgement.',
    role: 'Close-range striker',
    power: 'Warden glaive and storm-lit sigils',
    reach: `${bladeReach} melee · sigils home to ${metres(SIGIL.homingRange)}`,
    difficulty: 'Standard',
    playstyle: 'Aren stays in the fight. The free four-step glaive chain ends in a travelling Crescent Wave, Root Tether answers a monster’s windup, and a full Instinct bar becomes an invulnerable dash that leaves detonating marks behind.',
    strengths: [
      'Free melee chain with a ranged Crescent Wave finisher',
      `Thunder Cleave adds lightning across ${metres(THUNDER_CLEAVE.radius)} to a charged strike`,
      'Judgement dashes through danger while untouchable',
    ],
    cautions: [
      'Most damage requires closing in to glaive reach',
      'A held Thunder Cleave roots Aren until it lands',
    ],
    biography: [
      'Yara found Aren near a ruined part of Heartroot and raised them. Aren is neither royal nor descended from Orun; Heartroot chose Aren for the ability to listen without imposing a will on others.',
      'Aren sets out believing troublemakers must be defeated and every leader gathered under one authority. The journey teaches harder truths: order is not justice, consent means little without the right to refuse, and leadership rests on trust rather than command.',
    ],
    quote: { text: 'Then what are they running from?', speaker: 'Aren, in Greenwake' },
    accent: '#5fe3ff',
    stats: [
      ...commonStats('aren'),
      { label: 'Attack reach', value: `${bladeReach} glaive · ${metres(CRESCENT_WAVE.travel)} wave · ${metres(SIGIL.homingRange)} sigils` },
      { label: 'Glaive chain', value: `${LIGHT_STEPS.map(step => step.damage).join(' / ')} damage` },
      { label: 'Heaviest blow', value: `Thunder Cleave ${TARGETED_STRIKES.charged_heavy.damage} + ${THUNDER_CLEAVE.damage} lightning` },
      { label: 'Evasion', value: `Dive ${evadeDetail}` },
      { label: 'Ultimate', value: `${metres(JUDGEMENT.dashDistance)} dash · ${JUDGEMENT.markCount} × ${JUDGEMENT.markDamage} damage marks` },
    ],
    ratings: [
      { label: 'Close combat', value: 4 }, { label: 'Reach', value: 2 }, { label: 'Crowd control', value: 3 },
      { label: 'Mobility', value: 3 }, { label: 'Ease of play', value: 4 },
    ],
    weaponAssetId: WARDEN_GLAIVE_ASSET_ID,
    weaponGrip: 'glaive',
    style: 'warden',
    dodgeVanish: false,
    dodgeLabel: 'DIVE',
    maxVitality: HERO_COMBAT.aren.maxVitality,
    portraitUrl: '/asset-source/ui/heroes/aren.png',
    portraitCrop: '75% 3%',
    idleActionId: 'aren-idle',
    revealActionIds: ['aren-light-3'],
    skills: [
      {
        action: 'light', name: 'Warden Blade', cost: 'Free',
        description: 'Four-step glaive combo; the third spins, the fourth throws a Crescent Wave.',
        detail: `${LIGHT_STEPS.map(step => step.damage).join(' / ')} damage at ${bladeReach} · wave ${CRESCENT_WAVE.damage} damage over ${metres(CRESCENT_WAVE.travel)} (${mana(CRESCENT_WAVE.manaCost)})`,
        previewActionIds: ['aren-light-1', 'aren-light-2', 'aren-light-3', 'aren-light-4'],
      },
      {
        action: 'heavy', name: 'Heavy / Thunder Cleave', cost: mana(PLAYER_SKILLS.heavy.manaCost, PLAYER_SKILLS.charged_heavy.manaCost),
        description: 'Tap for a heavy strike; hold to charge a lightning cleave.',
        detail: `${TARGETED_STRIKES.heavy.damage} damage · hold ${seconds(THUNDER_CLEAVE.holdTicks)}: ${TARGETED_STRIKES.charged_heavy.damage} + ${THUNDER_CLEAVE.damage} lightning in ${metres(THUNDER_CLEAVE.radius)}`,
        previewActionIds: ['aren-heavy', 'aren-charged-heavy'],
      },
      {
        action: 'ranged', name: 'Sigil Bolt / Barrage', cost: mana(SIGIL.boltMana, SIGIL.barrageMana),
        description: 'Tap for a homing bolt; hold for a three-bolt barrage.',
        detail: `${SIGIL.boltDamage} damage, homing to ${metres(SIGIL.homingRange)} · hold: ${SIGIL.barrageLaunchTicks.length} × ${SIGIL.barrageDamage}`,
        previewActionIds: ['aren-sigil-bolt', 'aren-sigil-barrage'],
      },
      {
        action: 'ability', name: 'Root Tether / Cleanse', cost: mana(PLAYER_SKILLS.root_tether.manaCost, PLAYER_SKILLS.cleanse.manaCost),
        description: 'Bind a winding-up foe or cleanse an exposed one.',
        detail: tetherDetail,
        previewActionIds: ['aren-root-tether', 'aren-cleanse'],
      },
      {
        action: 'dodge', name: 'Dive', cost: mana(PLAYER_SKILLS.dive.manaCost),
        description: 'A rolling dive with invulnerable frames.',
        detail: evadeDetail,
        previewActionIds: ['aren-forward-left-dive-roll'],
      },
      {
        action: 'ultimate', name: "Warden's Judgement", cost: `${JUDGEMENT_INSTINCT} Instinct`,
        description: 'At full Instinct: an invulnerable dash that leaves five detonating marks.',
        detail: `${metres(JUDGEMENT.dashDistance)} untouchable dash · ${JUDGEMENT.markCount} × ${JUDGEMENT.markDamage} damage in ${metres(JUDGEMENT.markRadius)}`,
        previewActionIds: ['aren-judgement'],
      },
    ],
  },
  {
    id: 'yara', name: 'Yara', title: 'Heartroot Mage',
    summary: 'A ranged Heartroot mage who shapes the fight with homing thorns, erupting roots, a piercing sap lance and a blooming meteor storm.',
    role: 'Ranged spellcaster and controller',
    power: 'Heartroot sap-light and living roots',
    reach: `Spells ${metres(HEARTROOT.spikeRange).replace(' m', '')}–${metres(thornReach)} · Bloom field ${metres(HEARTROOT.bloomRadius)}`,
    difficulty: 'Advanced',
    playstyle: 'Yara fights from a distance. Homing thorns build pressure, Root Spike and Heartroot Eruption carve lanes and zones that strike every foe inside them, and a full Instinct bar becomes a protected Bloom that rains seeds across the whole clearing.',
    strengths: [
      `Longest reach: homing thorns to ${metres(thornReach)}, a piercing ${metres(HEARTROOT.lanceRange)} lance`,
      'Lanes, rings and the Bloom field hit every foe inside them',
      `Heartroot Bloom keeps her untouchable for ${seconds(HEARTROOT.bloomTicks)}`,
    ],
    cautions: [
      `Long spell commitments: Root Spike takes ${seconds(HEARTROOT.spikeTicks)}, Eruption ${seconds(HEARTROOT.eruptionTicks)}`,
      'Bloom holds her in place until the final pulse',
    ],
    biography: [
      'Orun’s last apprentice and the guardian who raised Aren. Yara helped shape the Root Crown before she understood its cost; when she saw it would erase every free will, she broke the ritual and Heartroot shattered into six fragments.',
      'She has carried that truth ever since, spending her Heartroot craft to undo the Black Sap. Her path is one of responsibility and atonement, not blame.',
    ],
    quote: { text: 'A Warden does not tame the wild. A Warden listens until the wild chooses to answer.', speaker: 'Yara' },
    accent: '#f0b34a',
    stats: [
      ...commonStats('yara'),
      { label: 'Attack reach', value: `${metres(thornReach)} thorns · ${metres(HEARTROOT.lanceRange)} lance · ${metres(HEARTROOT.eruptionRange)} eruption` },
      { label: 'Thorn chain', value: `${HEARTROOT.thornDamage} / ${HEARTROOT.twinDamage} × 2 / ${HEARTROOT.seedDamage} burst damage` },
      { label: 'Heaviest blow', value: `Heartroot Eruption ${HEARTROOT.eruptionDamage} in ${metres(HEARTROOT.eruptionRadius)}` },
      { label: 'Evasion', value: `Petal Step ${evadeDetail}` },
      { label: 'Ultimate', value: `${HEARTROOT.meteorCount} × ${HEARTROOT.meteorDamage} meteors + ${HEARTROOT.bloomPulseDamage} pulse in ${metres(HEARTROOT.bloomRadius)}` },
    ],
    ratings: [
      { label: 'Close combat', value: 1 }, { label: 'Reach', value: 5 }, { label: 'Crowd control', value: 5 },
      { label: 'Mobility', value: 3 }, { label: 'Ease of play', value: 2 },
    ],
    variantAssetId: YARA_HERO_ASSET_ID,
    weaponAssetId: HEARTROOT_STAFF_ASSET_ID,
    weaponGrip: 'staff',
    style: 'heartroot',
    dodgeVanish: true,
    dodgeLabel: 'PETAL STEP',
    maxVitality: HERO_COMBAT.yara.maxVitality,
    npcActorId: 'yara',
    portraitUrl: '/asset-source/ui/heroes/yara.png',
    portraitCrop: '53% 10%',
    idleActionId: 'aren-idle',
    revealActionIds: ['yara-sap-lance'],
    skills: [
      {
        action: 'light', name: 'Thornshot', cost: 'Free',
        description: 'Homing thorn, twin thorns, then a seed that bursts into a blossom of spikes.',
        detail: `${HEARTROOT.thornDamage} / ${HEARTROOT.twinDamage} × 2 / ${HEARTROOT.seedDamage} damage burst in ${metres(HEARTROOT.seedRadius)} · homing to ${metres(thornReach)}`,
        previewActionIds: ['yara-thornshot-1', 'yara-thornshot-2', 'yara-thornshot-3'],
      },
      {
        action: 'heavy', name: 'Root Spike / Heartroot Eruption', cost: mana(PLAYER_SKILLS.heavy.manaCost, PLAYER_SKILLS.charged_heavy.manaCost),
        description: 'Tap: a line of roots tears forward. Hold: a ring of Heartroot erupts under the foe.',
        detail: `${HEARTROOT.spikeDamage} damage along ${metres(HEARTROOT.spikeRange)} · hold: ${HEARTROOT.eruptionDamage} in a ${metres(HEARTROOT.eruptionRadius)} ring up to ${metres(HEARTROOT.eruptionRange)} away`,
        previewActionIds: ['yara-root-spike', 'yara-root-charge', 'yara-root-eruption'],
      },
      {
        action: 'ranged', name: 'Sap Lance / Seed Storm', cost: mana(SIGIL.boltMana, SIGIL.barrageMana),
        description: 'Tap: a piercing lance of golden sap-light. Hold: six homing storm seeds.',
        detail: `${HEARTROOT.lanceDamage} damage piercing ${metres(HEARTROOT.lanceRange)} · hold: ${HEARTROOT.stormLaunches.length} × ${HEARTROOT.stormDamage} homing seeds`,
        previewActionIds: ['yara-sap-lance', 'yara-seed-charge', 'yara-seed-storm'],
      },
      {
        action: 'ability', name: 'Binding Vines / Cleanse', cost: mana(PLAYER_SKILLS.root_tether.manaCost, PLAYER_SKILLS.cleanse.manaCost),
        description: 'Vines bind a winding-up foe or burn away exposed corruption.',
        detail: tetherDetail,
        previewActionIds: ['yara-binding-vines', 'yara-cleanse'],
      },
      {
        action: 'dodge', name: 'Petal Step', cost: mana(PLAYER_SKILLS.dive.manaCost),
        description: 'Dissolve into petals and reappear further along, untouchable in between.',
        detail: evadeDetail,
        previewActionIds: ['aren-forward-left-dive-roll'],
      },
      {
        action: 'ultimate', name: 'Heartroot Bloom', cost: `${JUDGEMENT_INSTINCT} Instinct`,
        description: 'At full Instinct: rise on a giant Heartroot sigil and call a storm of blooming seeds.',
        detail: `${metres(HEARTROOT.bloomRadius)} field · ${HEARTROOT.meteorCount} × ${HEARTROOT.meteorDamage} meteors + ${HEARTROOT.bloomPulseDamage} pulse · ${seconds(HEARTROOT.bloomTicks)} untouchable`,
        previewActionIds: ['yara-heartroot-bloom'],
      },
    ],
  },
  {
    id: 'vesper', name: 'Vesper', title: 'Moonshade Blade',
    summary: 'A samurai assassin who blinks through shadow, marks his prey with every cut and ends fights with a single crimson execution.',
    role: 'Samurai assassin',
    power: 'Moonshade katana and umbral blink-steps',
    reach: `${iaiReach} katana · Shadow Step ${metres(VESPER.shadowStep.blinkRange)} · kunai ${metres(VESPER.kunaiFan.range)}`,
    difficulty: 'Expert',
    playstyle: `Vesper lives on tempo. Every Moonlit Iai cut cancels into Shadow Step or Mist Blink, three hits leave a Death Mark that the next strike turns into a ${VESPER.deathMark.executionDamage}-damage Shadow Execution, and a hit from behind lands ×${VESPER.backstab.multiplier}. Fragile and fast, he wins by never standing where the monster is aiming.`,
    strengths: [
      'Fastest hero: blink, dash and untouchable frames on every step of the chain',
      `Death Mark: three hits mark a foe for ${seconds(VESPER.deathMark.markTicks)}; the next hit executes for +${VESPER.deathMark.executionDamage}`,
      `Thousand Cuts and Crimson Requiem keep him untargetable for ${seconds(VESPER.thousandCuts.ticks)} and ${seconds(VESPER.requiem.ticks)}`,
    ],
    cautions: [
      `Lowest vitality of the four (${HERO_COMBAT.vesper.maxVitality})`,
      'His damage comes from marks and backstabs; rushing in front of a monster wastes it',
    ],
    biography: [
      'Born into the Shadow clans of the Erya borderlands, Vesper was trained from childhood to take a single life without being seen. He walked away from his clan the night they were ordered to cut down a village that had refused the Root Crown, and has been a ronin ever since, his katana the only name he still answers to.',
      'The Black Sap whispers to monsters in the same dark where his clan once worked, and Vesper hears it more clearly than most. He follows Aren and Yara because they ask what the monsters are running from, a question his old masters never allowed anyone to ask.',
    ],
    quote: { text: 'A cut you can see coming is a conversation. I do not talk.', speaker: 'Vesper' },
    accent: '#9b5cff',
    stats: [
      ...commonStats('vesper'),
      { label: 'Attack reach', value: `${iaiReach} katana · ${metres(VESPER.shadowStep.blinkRange)} Shadow Step · ${metres(VESPER.kunaiFan.range)} kunai` },
      { label: 'Iai chain', value: `${VESPER.iai.steps.map(step => step.damage).join(' / ')} damage` },
      { label: 'Heaviest blow', value: `Thousand Cuts ${VESPER.thousandCuts.strikeAt.length} × ${VESPER.thousandCuts.strikeDamage} + ${VESPER.thousandCuts.finisherDamage} finisher (${cutsTotal})` },
      { label: 'Evasion', value: `Mist Blink ${metres(VESPER.mistBlink.distance)} · ${seconds(VESPER.mistBlink.iframes)} untouchable` },
      { label: 'Ultimate', value: `${VESPER.requiem.slashCount} × ${VESPER.requiem.slashDamage} slashes + ${VESPER.requiem.detonationDamage} detonation within ${metres(VESPER.requiem.markRadius)}` },
    ],
    ratings: [
      { label: 'Close combat', value: 5 }, { label: 'Reach', value: 3 }, { label: 'Crowd control', value: 2 },
      { label: 'Mobility', value: 5 }, { label: 'Ease of play', value: 1 },
    ],
    variantAssetId: VESPER_HERO_ASSET_ID,
    weaponAssetId: VESPER_KATANA_ASSET_ID,
    weaponGrip: 'katana',
    style: 'umbral',
    dodgeVanish: true,
    dodgeLabel: 'MIST BLINK',
    maxVitality: HERO_COMBAT.vesper.maxVitality,
    portraitUrl: '/asset-source/ui/heroes/vesper.png',
    portraitCrop: '34% 30%',
    idleActionId: 'aren-idle',
    revealActionIds: ['vesper-shadow-step'],
    skills: [
      {
        action: 'light', name: 'Moonlit Iai', cost: 'Free',
        description: 'Four-step katana chain; the fourth, Crescent Rift, dashes through the foe.',
        detail: `${VESPER.iai.steps.map(step => step.damage).join(' / ')} damage at ${iaiReach} · step 4 dashes ${metres(VESPER.iai.riftDashDistance)} untouchable`,
        previewActionIds: ['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3', 'vesper-iai-4'],
      },
      {
        action: 'heavy', name: 'Shadow Step / Thousand Cuts', cost: mana(PLAYER_SKILLS.heavy.manaCost, PLAYER_SKILLS.charged_heavy.manaCost),
        description: 'Tap: blink behind a foe and strike. Hold: vanish into a storm of cuts.',
        detail: `${VESPER.shadowStep.damage} damage from up to ${metres(VESPER.shadowStep.blinkRange)} · hold ${seconds(THUNDER_CLEAVE.holdTicks)}: ${VESPER.thousandCuts.strikeAt.length} × ${VESPER.thousandCuts.strikeDamage} + ${VESPER.thousandCuts.finisherDamage}, untargetable`,
        previewActionIds: ['vesper-shadow-step', 'vesper-cuts-charge', 'vesper-thousand-cuts'],
      },
      {
        action: 'ranged', name: 'Kunai Fan / Shade Swap', cost: mana(SIGIL.boltMana, SIGIL.barrageMana),
        description: 'Tap: throw three kunai that each stack Death Mark. Hold: send a shade ahead and swap places with it.',
        detail: `${VESPER.kunaiFan.count} × ${VESPER.kunaiFan.damage} damage to ${metres(VESPER.kunaiFan.range)} · hold: shade dashes ${metres(VESPER.shadeSwap.dashDistance)} for ${VESPER.shadeSwap.damage}, then he swaps in`,
        previewActionIds: ['vesper-kunai-fan', 'vesper-shade-charge', 'vesper-shade-swap'],
      },
      {
        action: 'ability', name: 'Severing Shadow / Cleanse', cost: mana(PLAYER_SKILLS.root_tether.manaCost, PLAYER_SKILLS.cleanse.manaCost),
        description: 'Blink to a winding-up foe and cut its attack short, or cleanse an exposed one.',
        detail: `Interrupts a winding-up foe within ${metres(VESPER.severingShadow.range)} for ${VESPER.severingShadow.damage} · cleanses an exposed one`,
        previewActionIds: ['vesper-severing-shadow', 'vesper-cleanse'],
      },
      {
        action: 'dodge', name: 'Mist Blink', cost: mana(PLAYER_SKILLS.dive.manaCost),
        description: 'Dissolve into ink-black mist and reappear further along.',
        detail: `${metres(VESPER.mistBlink.distance)} · ${seconds(VESPER.mistBlink.iframes)} untouchable`,
        previewActionIds: ['vesper-mist-blink'],
      },
      {
        action: 'ultimate', name: 'Crimson Requiem', cost: `${JUDGEMENT_INSTINCT} Instinct`,
        description: 'At full Instinct: mark every foe nearby, cut each one in a blur of blinks, then detonate the marks.',
        detail: `${VESPER.requiem.slashCount} × ${VESPER.requiem.slashDamage} slashes + ${VESPER.requiem.detonationDamage} per marked foe within ${metres(VESPER.requiem.markRadius)} · ${seconds(VESPER.requiem.ticks)} untargetable`,
        previewActionIds: ['vesper-requiem'],
      },
    ],
  },
  {
    id: 'sakda', name: 'Sakda', title: 'Ember Fist',
    summary: 'A wandering Muay Thai monk who chains elbows, knees and kicks into a flurry, and drives through a monster with a flying knee.',
    role: 'Muay Thai brawler',
    power: 'Ember-wreathed fists, elbows and shins',
    reach: `${limbReach} strikes · Echo Wave ${metres(SAKDA.echoWave.range)} · Resonating Strike ${metres(SAKDA.resonatingStrike.maxDashRange)}`,
    difficulty: 'Advanced',
    playstyle: `Sakda never stops moving forward. Any skill primes Flurry, so the next ${SAKDA.flurry.charges} Eight Limbs hits come ${Math.round(SAKDA.flurry.speedBonus * 100)}% faster and refill mana; Echo Wave marks a foe so Resonating Strike can launch Sakda onto it, and Flying Knee and Guard Dash chain straight on from there.`,
    strengths: [
      `Flurry: ${SAKDA.flurry.charges} faster J hits after every skill, each restoring ${SAKDA.flurry.manaPerHit} mana`,
      `Guard Dash shields ${SAKDA.guardDash.shield} damage for ${seconds(SAKDA.guardDash.shieldTicks)} and chains into his dash skills`,
      `Tempest Stomp cripples monsters to ${Math.round(SAKDA.tempestStomp.crippleSpeedFactor * 100)}% speed for ${seconds(SAKDA.tempestStomp.crippleTicks)}`,
    ],
    cautions: [
      `Shortest reach of the four: strikes land within ${limbReach}`,
      `Tiger's Wrath leaves him exposed for ${seconds(SAKDA.tigersWrath.ticks - SAKDA.tigersWrath.untargetableTo)} after its kick`,
    ],
    biography: [
      'Sakda trained from boyhood in the Ember temples, where monks learn to fight with eight points of contact and to keep a lamp lit through a night of fighting. When the Black Sap spread to the temple groves he left the cloister to carry the flame outward, fighting only with what the body itself can give.',
      'He claims no title beyond the wandering monk, and no weapon beyond hands wrapped in cord. Those who have seen him fight say the ember on his knuckles is not a trick of the lamp-oil, and that it burns hotter the closer the monster comes.',
    ],
    quote: { text: 'A monk keeps the flame lit by walking into the wind.', speaker: 'Sakda' },
    accent: '#ff7a1a',
    stats: [
      ...commonStats('sakda'),
      { label: 'Attack reach', value: `${limbReach} strikes · ${metres(SAKDA.echoWave.range)} Echo Wave · ${metres(SAKDA.resonatingStrike.maxDashRange)} Resonating Strike` },
      { label: 'Eight Limbs chain', value: `${SAKDA.limbs.steps.map(step => step.damage).join(' / ')} damage` },
      { label: 'Heaviest blow', value: `Flying Knee ${SAKDA.flyingKnee.damage} + ${SAKDA.flyingKnee.ringDamage} in ${metres(SAKDA.flyingKnee.ringRadius)}` },
      { label: 'Evasion', value: `Guard Dash ${metres(SAKDA.guardDash.distance)} · ${seconds(SAKDA.guardDash.iframes)} untouchable · ${SAKDA.guardDash.shield} shield` },
      { label: 'Ultimate', value: `${SAKDA.tigersWrath.damage} damage · ${metres(SAKDA.tigersWrath.knockback)} knockback · ${SAKDA.tigersWrath.slideDamage} to foes in the way` },
    ],
    ratings: [
      { label: 'Close combat', value: 5 }, { label: 'Reach', value: 1 }, { label: 'Crowd control', value: 4 },
      { label: 'Mobility', value: 4 }, { label: 'Ease of play', value: 3 },
    ],
    variantAssetId: SAKDA_HERO_ASSET_ID,
    style: 'ember',
    dodgeVanish: false,
    dodgeLabel: 'GUARD DASH',
    maxVitality: HERO_COMBAT.sakda.maxVitality,
    portraitUrl: '/asset-source/ui/heroes/sakda.png',
    portraitCrop: '30% 14%',
    idleActionId: 'aren-idle',
    revealActionIds: ['sakda-limb-4'],
    skills: [
      {
        action: 'light', name: 'Eight Limbs', cost: 'Free',
        description: 'Four-step Muay Thai chain: jab-cross, rising elbow, clinch knee and a roundhouse ringed with ember.',
        detail: `${SAKDA.limbs.steps.map(step => step.damage).join(' / ')} damage at ${limbReach} · roundhouse ring ${metres(SAKDA.limbs.steps[3]!.ring!.radius)}`,
        previewActionIds: ['sakda-limb-1', 'sakda-limb-2', 'sakda-limb-3', 'sakda-limb-4'],
      },
      {
        action: 'heavy', name: 'Tempest Stomp / Flying Knee', cost: mana(PLAYER_SKILLS.heavy.manaCost, PLAYER_SKILLS.charged_heavy.manaCost),
        description: 'Tap: stamp a ring of fire that cripples. Hold: leap onto a foe with a flying knee.',
        detail: `${SAKDA.tempestStomp.damage} damage in ${metres(SAKDA.tempestStomp.radius)}, cripple ${seconds(SAKDA.tempestStomp.crippleTicks)} · hold ${seconds(THUNDER_CLEAVE.holdTicks)}: ${SAKDA.flyingKnee.damage} + ${SAKDA.flyingKnee.ringDamage} ring from ${metres(SAKDA.flyingKnee.range)}`,
        previewActionIds: ['sakda-tempest', 'sakda-knee-charge', 'sakda-flying-knee'],
      },
      {
        action: 'ranged', name: 'Echo Wave / Hundred Elbows', cost: mana(SIGIL.boltMana, SIGIL.barrageMana),
        description: 'Tap: send a sonic wave that marks a foe; tap again to launch onto it. Hold: lock on and unleash a hundred elbows.',
        detail: `${SAKDA.echoWave.damage} damage to ${metres(SAKDA.echoWave.range)} · recast: ${SAKDA.resonatingStrike.damage} + ${Math.round(SAKDA.resonatingStrike.missingHealthRatio * 100)}% missing health · hold: ${elbowsTotal} over ${SAKDA.hundredElbows.hitAt.length + 1} hits`,
        previewActionIds: ['sakda-echo-wave', 'sakda-resonating-strike', 'sakda-elbow-charge', 'sakda-hundred-elbows'],
      },
      {
        action: 'ability', name: 'Iron Clinch / Cleanse', cost: mana(PLAYER_SKILLS.root_tether.manaCost, PLAYER_SKILLS.cleanse.manaCost),
        description: 'Dash to a winding-up foe and clinch it out of its attack, or cleanse an exposed one.',
        detail: `Interrupts a winding-up foe within ${metres(SAKDA.ironClinch.range)} for ${SAKDA.ironClinch.damage} · cleanses an exposed one`,
        previewActionIds: ['sakda-iron-clinch', 'sakda-cleanse'],
      },
      {
        action: 'dodge', name: 'Guard Dash', cost: mana(PLAYER_SKILLS.dive.manaCost),
        description: 'A guarded dash that grants a flame shield absorbing damage before health.',
        detail: `${metres(SAKDA.guardDash.distance)} · ${seconds(SAKDA.guardDash.iframes)} untouchable · ${SAKDA.guardDash.shield} shield for ${seconds(SAKDA.guardDash.shieldTicks)}`,
        previewActionIds: ['sakda-guard-dash'],
      },
      {
        action: 'ultimate', name: "Tiger's Wrath", cost: `${JUDGEMENT_INSTINCT} Instinct`,
        description: 'At full Instinct: a tiger-shaped kick that hurls the foe back and burns everything in its path.',
        detail: `${SAKDA.tigersWrath.damage} damage · ${metres(SAKDA.tigersWrath.knockback)} knockback · stagger ${seconds(SAKDA.tigersWrath.staggerTicks)} · ${SAKDA.tigersWrath.slideDamage} to foes in the way`,
        previewActionIds: ['sakda-tigers-wrath'],
      },
    ],
  },
];

export const DEFAULT_HERO_ID: HeroId = 'aren';

export function heroById(id: HeroId): HeroDefinition {
  const hero = HEROES.find(candidate => candidate.id === id);
  if (!hero) throw new Error('Unknown hero ' + id);
  return hero;
}

export function isHeroId(value: unknown): value is HeroId {
  return HEROES.some(hero => hero.id === value);
}
