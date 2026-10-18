/**
 * Presentation-only copy and colour for the five playable maps: the map intro and the loading scene read from here and
 * nowhere else. Nothing in this module touches simulation, quests or save data.
 */
export type RegionSceneId = 'greenwake' | 'canopy' | 'bamboo' | 'grove' | 'moonpine' | 'mistveil';

export type RegionAtmosphere = 'fireflies' | 'leaves' | 'pollen' | 'snow' | 'mist';

export interface RegionPresentation {
  readonly id: RegionSceneId;
  readonly chapterLabel: string;
  readonly title: string;
  readonly tagline: string;
  /** 2–4 short story lines shown, in order, by the map intro. */
  readonly introBeats: readonly string[];
  /** 4–8 rotating lore/tip lines shown under the loading progress. */
  readonly loadingLore: readonly string[];
  /** Who waits there. */
  readonly threatLine: string;
  /** Any CSS colour: `sky` tints the top of the grade, `mid` the body, `accent` the rune bar and rules, `glow` the bloom. */
  readonly palette: { readonly sky: string; readonly mid: string; readonly accent: string; readonly glow: string };
  readonly atmosphere: RegionAtmosphere;
  /** Backdrop art. The single place to change when higher-resolution wide art lands. */
  readonly artUrl: string;
}

const MAP_ART = '/asset-source/ui/maps/';

export const REGION_PRESENTATION: Readonly<Record<RegionSceneId, RegionPresentation>> = Object.freeze({
  greenwake: {
    id: 'greenwake',
    chapterLabel: 'Prologue',
    title: 'Greenwake',
    tagline: 'The night of a thousand roars.',
    introBeats: [
      'Every creature in the forest is roaring at once, and not one of them is roaring at you.',
      'A harpy eagle has fallen with a fragment of Heartroot in her talons. The Warden Staff is waiting.',
      'Something beneath Erya is waking. The animals are fleeing it, not each other.',
    ],
    loadingLore: [
      'The Wild Pact joined many voices without binding them to one.',
      'Black Sap does not change what an animal is. It makes what it already feels unbearable.',
      'Evade a charge at the last moment. A well-timed dodge opens the way to cleanse.',
      'Greenwake sits at the very edge of Erya, where the old paths still remember travellers.',
      'Vara carried the Sky fragment this far. Tend to her before you ask her to guide you.',
      'Every fight in Erya is nonlethal. You cleanse; you never kill.',
    ],
    threatLine: 'Ember Boar, Frost Sap-Stalker and the Root Rammer prowl the paths, driven mad by the sap.',
    palette: { sky: '#1b3a2a', mid: '#0c2016', accent: '#8fdc9c', glow: '#52f08a' },
    atmosphere: 'pollen',
    artUrl: '/ui/greenwake-entry.webp',
  },
  canopy: {
    id: 'canopy',
    chapterLabel: 'Chapter 1',
    title: 'Whispering Canopy',
    tagline: 'Rope bridges, waterfalls and a quarrel over the last seeds.',
    introBeats: [
      'High above the forest floor, birds and monkeys are fighting over the last seeds.',
      'The orchard is dying. Black Sap has poisoned its water, and hunters have trapped the source.',
      'Neither side is wholly wrong. Follow the bridges and find out what each one needs.',
    ],
    loadingLore: [
      'Koro tests strangers before he trusts them. A stolen fragment is only the first test.',
      'Cleansing a wound does not refill an empty orchard. The water and the seeds have to return too.',
      'Every attack in the Canopy is telegraphed. Read the wind-up, then move.',
      'Storm Hornbills strike from the high branches. Keep an eye on the sky as well as the bridge.',
      'Mire Vipers keep to the wet roots. Watch the ground ahead of the bridge, not only the sky.',
      'Birds hold the seeds. Monkeys hold the ropes. The Canopy needs both.',
    ],
    threatLine: 'Thornback Howlers, Storm Hornbills and Mire Vipers hold the bridges.',
    palette: { sky: '#294f4a', mid: '#0d2a24', accent: '#c9e48a', glow: '#9ef0b4' },
    atmosphere: 'leaves',
    artUrl: `${MAP_ART}whispering-canopy.jpg`,
  },
  bamboo: {
    id: 'bamboo',
    chapterLabel: 'Chapter 2',
    title: 'Blood Bamboo Valley',
    tagline: 'A mother searches. A camp waits.',
    introBeats: [
      'Snapped stems and a crushed jaw trap mark the way into the valley. Something small was dragged along this trail.',
      'Ash Hunters hold a cub in a cage at the edge of their camp, and a mother tiger is looking for her.',
      'No one here needs to die. Take away the traps, free the cub, and keep her out of the charge lane.',
    ],
    loadingLore: [
      'Take the long clear path to see Tali’s fur. The short lane is lined with armed jaw traps.',
      'Hunters can be subdued without killing. Disable the extraction rig before the camp wakes.',
      'Asha charges in a straight line. Wait for her to commit, then step out of the lane.',
      'Koro can drop the shrine bundle across the lane. If he is not with you, cut it free with a heavy strike.',
      'Tali is never in danger from you. Lead her to the shelter before the charge.',
    ],
    threatLine: 'Three Ash Hunters hold the camp, and Asha is driven wild by the Black Sap.',
    palette: { sky: '#5b3a22', mid: '#2a160c', accent: '#e8a35a', glow: '#ffb56e' },
    atmosphere: 'leaves',
    artUrl: '/ui/world-map-game.webp',
  },
  grove: {
    id: 'grove',
    chapterLabel: 'Sanctuary',
    title: 'The Grove',
    tagline: 'A young Heartroot, a quiet pool and a sanctuary worth defending.',
    introBeats: [
      'A young Heartroot stands where the fog is thickest. Nothing in the Grove hunts, and the sanctuary has never needed a wall.',
      'Black Sap is seeping into the Memory Pool, where the Grove keeps its record of every promise. It has reached the guardian that tends the water.',
      'Hollowheart is cracked, not lost. Spar with the Sprig, hold the blighted hollow, and defend the pool.',
    ],
    loadingLore: [
      'The Grove grows with what you restore. A quiet sanctuary is a promise kept, and sometimes a promise defended.',
      'Yara was Orun’s last apprentice. Ask her what she carries, and listen to how she answers.',
      'Koro’s help here is a favour, not a covenant. Trust is earned one bridge at a time.',
      'The Heartroot Sprig in the practice ring is a gentle sparring partner. Read its tells here, where nothing is at stake.',
      'Black Sap spreads along roots and water. The rootlings it reaches keep their shape, but not their gentleness.',
      'Hollowheart guards the Memory Pool. Its heart-light is cracked, not dark: free it of the sap and it remembers who it was.',
      'Birds nest. Monkeys build. Every companion that rests here makes the sanctuary louder and more alive.',
    ],
    threatLine: 'Nothing here hunts you. What the Black Sap has reached does: a blighted rootling in the hollow, and Hollowheart, the Sapbound Guardian, at the Memory Pool.',
    palette: { sky: '#3b4a2c', mid: '#14240f', accent: '#e8cf86', glow: '#bfe48a' },
    atmosphere: 'fireflies',
    artUrl: `${MAP_ART}the-grove.jpg`,
  },
  moonpine: {
    id: 'moonpine',
    chapterLabel: 'Chapter 3',
    title: 'Moonpine Ridge',
    tagline: 'Snowbound pines and a howl that comes from underground.',
    introBeats: [
      'Snow muffles the ridge, but the howl comes through it: three pulses, and the third rises from beneath the temple.',
      'Ruun, the elder wolf, lies chained below the pack he once led. His howl carries Black Sap into the roots.',
      'Two packs are splitting over his absence. Break the chains. Let the pack choose who leads.',
    ],
    loadingLore: [
      'Wolves answer a howl in threes. Count the pulses before you move.',
      'Frostfangs hunt as a pack. Keep moving, and never fight with your back to the cliff.',
      'A Howl Scout watches from the ridgeline. Where one howls, the pack is never far behind.',
      'Ruun lies chained below the temple. The pack he led still hears him, and so does the sap.',
      'Luma wants room to change. Ruun’s followers want shelter held. Both are afraid of the same winter.',
      'Ice cracks before it breaks. Listen for it.',
    ],
    threatLine: 'Frostfangs and Howl Scouts patrol the ridge. Ruun, the Chained Howl, waits below the temple.',
    palette: { sky: '#6f8aa6', mid: '#16273a', accent: '#bfe3ff', glow: '#a4d4ff' },
    atmosphere: 'snow',
    artUrl: `${MAP_ART}moonpine-ridge.jpg`,
  },
  mistveil: {
    id: 'mistveil',
    chapterLabel: 'Chapter 4',
    title: 'Mistveil Basin',
    tagline: 'Fog, great root trees and a river gone black.',
    introBeats: [
      'Fog hangs between the root trees, and lanterns drift where no one is carrying them.',
      'Upstream, the hunter Marek’s rig feeds Black Sap into the river. Whatever lives here is defending poisoned water.',
      'Nyra has been blamed for what she contained. Follow the evidence, not the accusation.',
    ],
    loadingLore: [
      'The Black River does not care who drinks from it. Its source is a choice, not a monster’s fault.',
      'Bog Lurkers wait in the shallows. Watch the water as closely as the path.',
      'Lantern Herons drift between the root trees. A light that moves is never a path.',
      'Ghor was a crocodile before the river changed it. It is a consequence, not an evil.',
      'Nyra hunted the infected to stop the sap from spreading. The marks around the wounds tell the story.',
      'The hunter Marek’s ledger still marks every supply line. Follow it upstream.',
    ],
    threatLine: 'Bog Lurkers and Lantern Herons haunt the causeways. Ghor, the Mire Maw, guards the black water.',
    palette: { sky: '#1f4a45', mid: '#071a1a', accent: '#7fe3d3', glow: '#4fe0c0' },
    atmosphere: 'mist',
    artUrl: `${MAP_ART}mistveil-basin.jpg`,
  },
});
