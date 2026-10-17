// Source packs for the shipped audio library. Every pack here was checked on its own download page on the
// download date below; only CC0 (or CC-BY, none used so far) material is allowed. NC / ND / unclear licences are rejected.
export const DOWNLOAD_DATE = '2026-10-14';
export const CC0 = { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' };

const OGA = 'https://opengameart.org/sites/default/files/';
const kenney = (slug, title) => ({ page: `https://kenney.nl/assets/${slug}`, author: 'Kenney Vleugels (kenney.nl)', title, license: CC0 });
const oga = (slug, title, author) => ({ page: `https://opengameart.org/content/${slug}`, author, title, license: CC0 });

/** id -> { file (cache name), url, page, author, title, license, archive?: true } */
export const PACKS = {
  'kenney-impact-sounds': { ...kenney('impact-sounds', 'Impact Sounds 1.0'), file: 'kenney-impact-sounds.zip', url: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip', archive: true },
  'kenney-rpg-audio': { ...kenney('rpg-audio', 'RPG Audio'), file: 'kenney-rpg-audio.zip', url: 'https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip', archive: true },
  'kenney-interface-sounds': { ...kenney('interface-sounds', 'Interface Sounds 1.0'), file: 'kenney-interface-sounds.zip', url: 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip', archive: true },
  'oga-creature-sfx-1': { ...oga('80-cc0-creature-sfx', '80 CC0 creature SFX', 'rubberduck'), file: 'oga-creature-sfx-1.zip', url: OGA + '80-CC0-creature-SFX_0.zip', archive: true },
  'oga-creature-sfx-2': { ...oga('80-cc0-creture-sfx-2', '80 CC0 creture SFX #2', 'rubberduck'), file: 'oga-creature-sfx-2.zip', url: OGA + '80-CC0-creature-sfx-2.zip', archive: true },
  'oga-rpg-sfx-80': { ...oga('80-cc0-rpg-sfx', '80 CC0 RPG SFX', 'rubberduck'), file: 'oga-rpg-sfx-80.zip', url: OGA + '80-CC0-RPG-SFX_0.zip', archive: true },
  'oga-swishes': { ...oga('swishes-sound-pack', 'Swishes Sound Pack', 'artisticdude'), file: 'oga-swishes.zip', url: OGA + 'swishes.zip', archive: true },
  'oga-melee-sounds': { ...oga('3-melee-sounds', '3 Melee sounds', 'remaxim (original by qubodup)'), file: 'oga-melee-sounds.zip', url: OGA + 'melee%20sounds.zip', archive: true },
  'oga-mud-sfx': { ...oga('25-cc0-mud-sfx', '25 CC0 mud sfx', 'rubberduck'), file: 'oga-mud-sfx.zip', url: OGA + '25-CC0-mud-sfx.zip', archive: true },
  'oga-water-slime-sfx': { ...oga('40-cc0-water-splash-slime-sfx', '40 CC0 water / splash / slime SFX', 'rubberduck'), file: 'oga-water-slime-sfx.zip', url: OGA + 'water-splash-slime-sfx.zip', archive: true },
  'oga-bat-screeches': { ...oga('bat-screeches', 'Bat Screeches', 'AntumDeluge'), file: 'oga-bat-screeches.zip', url: OGA + 'bat.zip', archive: true },
  'oga-deep-monster-roar': { ...oga('cc0-deep-monster-roar', 'CC0 Deep Monster Roar', 'trazzz123'), file: 'oga-deep-monster-roar.wav', url: OGA + 'monster_roar.wav', original: 'monster_roar.wav' },
  // Music
  'oga-lost-in-the-meadows': { ...oga('lost-in-the-meadows', 'Lost in the meadows (dual-licensed OGA-BY 3.0 / CC0; used under CC0)', 'HaelDB'), file: 'oga-lost-in-the-meadows.flac', url: OGA + 'lost%20in%20the%20meadows_0.flac', original: 'lost in the meadows_0.flac' },
  'oga-forest-whisper': { ...oga('forest-whisper-theme', 'Forest Whisper Theme', 'CleytonKauffman'), file: 'oga-forest-whisper.zip', url: OGA + 'forest_whisper_theme.zip', archive: true },
  'oga-beautiful-forest': { ...oga('beautiful-forest-orchestra', 'Beautiful Forest [Orchestra]', 'nene'), file: 'oga-beautiful-forest.ogg', url: OGA + 'beautiful_forest_16bit_44.1khz_1.ogg', original: 'beautiful_forest_16bit_44.1khz_1.ogg' },
  'oga-rising-moon': { ...oga('fantasy-rising-moon', 'Fantasy: Rising Moon', 'RandomMind'), file: 'oga-rising-moon.mp3', url: OGA + 'Rising_Moon.mp3', original: 'Rising_Moon.mp3' },
  'oga-echoes-of-the-past': { ...oga('echoes-of-the-past', 'Echoes of the Past', 'isaiah658'), file: 'oga-echoes-of-the-past.wav', url: OGA + 'echoes_of_the_past.wav', original: 'echoes_of_the_past.wav' },
  'oga-at-home': { ...oga('at-home-orchestral', 'At Home - Orchestral', 'Wolfgang_'), file: 'oga-at-home.mp3', url: OGA + 'cinematic-calm.mp3', original: 'cinematic-calm.mp3' },
  'oga-exploration-theme': { ...oga('exploration-theme', 'Exploration Theme', 'CleytonKauffman'), file: 'oga-exploration-theme.ogg', url: OGA + 'exploration_theme.ogg', original: 'exploration_theme.ogg' },
  'oga-battle-theme-a': { ...oga('battle-theme-a', 'Battle Theme A', 'cynicmusic'), file: 'oga-battle-theme-a.mp3', url: OGA + 'battleThemeA.mp3', original: 'battleThemeA.mp3' },
  'oga-battle-theme-b': { ...oga('battle-theme-b-for-rpg', 'Battle Theme B for RPG', 'cynicmusic'), file: 'oga-battle-theme-b.mp3', url: OGA + 'battleThemeB.mp3', original: 'battleThemeB.mp3' },
  'oga-determined-pursuit': { ...oga('determined-pursuit-epic-orchestra-loop', 'Determined Pursuit (epic orchestra loop)', 'Emma_MA'), file: 'oga-determined-pursuit.wav', url: OGA + 'determined_pursuit_loop.wav', original: 'determined_pursuit_loop.wav' },
  'oga-boss-battle-theme': { ...oga('boss-battle-theme', 'Boss Battle Theme', 'CleytonKauffman'), file: 'oga-boss-battle-theme.ogg', url: OGA + 'CleytonRX%20-%20Battle%20RPG%20Theme%20Var.ogg', original: 'CleytonRX - Battle RPG Theme Var.ogg' },
  'oga-adventure-intro': { ...oga('adventure-intro-title-cinematic-epic', 'Adventure Intro Title [Cinematic, Epic]', 'nene'), file: 'oga-adventure-intro.wav', url: OGA + 'Adventure%20Theme%20Intro.wav', original: 'Adventure Theme Intro.wav' },
  'oga-fanfare': { ...oga('just-a-random-fanfare', 'Just a random fanfare', 'Spring Spring'), file: 'oga-fanfare.ogg', url: OGA + 'fanfare.ogg', original: 'fanfare.ogg' },
  'oga-defeat-theme': { ...oga('medieval-defeat-theme', 'Medieval: Defeat Theme', 'RandomMind'), file: 'oga-defeat-theme.mp3', url: OGA + 'defeat.mp3', original: 'defeat.mp3' },
  'oga-piano-loop': { ...oga('emotional-piano-loop', 'Emotional piano loop', 'extenz'), file: 'oga-piano-loop.wav', url: OGA + 'Piano%20Loop.wav', original: 'Piano Loop.wav' },
  'oga-dungeon-ambience': { ...oga('dungeon-ambience', 'Dungeon Ambience', 'yd'), file: 'oga-dungeon-ambience.ogg', url: OGA + 'dungeon002.ogg', original: 'dungeon002.ogg' },
  'oga-forest-ambience': { ...oga('forest-ambience', 'Forest Ambience', 'TinyWorlds'), file: 'oga-forest-ambience.mp3', url: OGA + 'Forest_Ambience.mp3', original: 'Forest_Ambience.mp3' },
  'oga-icy-heights-wind': { ...oga('icy-heights', 'Icy Heights (wind loop)', 'Écrivain'), file: 'oga-icy-heights-wind.ogg', url: OGA + 'wind.ogg', original: 'wind.ogg' },
  'oga-swamp-theme-loop': { ...oga('swamp-theme-loop', 'Swamp Theme Loop', 'beardalaxy'), file: 'oga-swamp-theme-loop.ogg', url: OGA + 'swamp_in_game.ogg', original: 'swamp_in_game.ogg' },
};
