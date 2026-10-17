import type { AssetPlaytestId } from './AssetPlaytests.js';

/**
 * The campaign's map order (docs/production/content/GAME-NARRATIVE.en.md §6) as shown on the local map select. A chapter
 * with `playtestId` is playable; the others are listed as Coming Soon and never take part in unlocking.
 */
export interface StoryChapter {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  /** One-line setting from the narrative. */
  readonly setting: string;
  readonly playtestId?: AssetPlaytestId;
  /** Coming Soon art: the chapter's place on the illustrated world map (`/ui/world-map-game.webp`) as CSS background size/position. */
  readonly mapArt?: { readonly size: string; readonly position: string };
}

export const STORY_CHAPTERS: readonly StoryChapter[] = [
  { id: 'prologue', label: 'Prologue', name: 'Greenwake', setting: 'The night of a thousand roars at the edge of Erya.', playtestId: 'greenwake' },
  { id: 'chapter-1', label: 'Chapter 1', name: 'Whispering Canopy', setting: 'Rope bridges, waterfalls and a temple where monkeys and birds quarrel over the last seeds.', playtestId: 'canopy' },
  { id: 'sanctuary', label: 'Sanctuary', name: 'The Grove', setting: 'A young Heartroot, a quiet pool and Yara’s tent: the sanctuary that records the journey.', playtestId: 'grove' },
  { id: 'chapter-2', label: 'Chapter 2', name: 'Blood Bamboo Valley', setting: 'A red-lit bamboo valley, a hunting camp and Asha, the Broken Fang.', mapArt: { size: '260%', position: '19% 9%' } },
  { id: 'chapter-3', label: 'Chapter 3', name: 'Moonpine Ridge', setting: 'Snowbound pines, a frozen lake and a buried wolf temple where Ruun lies chained.', playtestId: 'moonpine' },
  { id: 'chapter-4', label: 'Chapter 4', name: 'Mistveil Basin', setting: 'Fog, great root trees and a river poisoned by Black Sap.', playtestId: 'mistveil' },
  { id: 'chapter-5', label: 'Chapter 5', name: 'Sunmane Expanse', setting: 'Grassland held in fearful order by Solkar, the Sunmane King.', mapArt: { size: '260%', position: '99% 72%' } },
  { id: 'chapter-6', label: 'Chapter 6', name: 'The Fall of the Grove', setting: 'Orun returns to the sanctuary, and the journey moves to the Refuge.', mapArt: { size: '260%', position: '52% 40%' } },
  { id: 'chapter-7', label: 'Chapter 7', name: 'The Living Pact', setting: 'Return to every region and ask each community whether it will march.', mapArt: { size: 'cover', position: '50% 50%' } },
  { id: 'chapter-8', label: 'Chapter 8', name: 'Heartroot Hollow', setting: 'Giant roots, streams of Black Sap and Orun, the Hollow King.', mapArt: { size: '260%', position: '0% 100%' } },
];
