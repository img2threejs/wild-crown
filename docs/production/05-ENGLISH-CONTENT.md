# Wild Crown — English Content Cutover

## Decision

The user approved the Map, UI and Character concepts and requested that all game content be in English. Preserve the approved artwork and layout. English is now the sole player-facing release language.

This update does not begin gameplay implementation or Tripo model production. Concept approval does not replace multi-view, rigging, environment or runtime verification.

## Current English sources

- [Player copy catalog](content/PLAYER-COPY.en.json): menus, save/load, settings, accessibility, errors, HUD, commands, companion abilities, 17 evasion actions, counters, tutorials, interactions, map/journal, relationships, fragments, choices, ending requirements and endings.
- [Narrative content](content/GAME-NARRATIVE.en.md): world lore, character biographies, prologue, all eight chapters, 15 named main quests, five return beats, three final-boss phases, three endings, 12 side quests, existing dialogue, Echo phrases and trailer copy.
- [Map concepts](visual-review/01-MAPS.jpg).
- [UI concepts](visual-review/02-UI.jpg).
- [Character concepts](visual-review/03-CHARACTERS.jpg).

The narrative translates the content defined in the Bible and production plan, preserving the status of new proposals. It is not a claim that an as-yet-unwritten full conversation/voiceover script has been produced. Any further dialogue authoring and any recorded voice lines must also be English.

## Visual update

All 11 curated plates in `visual-review/plates/` and all three overview sheets now use English. The four UI plates include English navigation, objectives, interaction prompts, ability labels/descriptions, party roles, relationship labels and controls. The world map's underground annotation is English. Editorial footers now record concept approval rather than pending user approval.

No generative rerender was used for this language change. Raster text/backings were replaced locally; artwork outside the declared copy regions was verified unchanged. Names, characters, terrain, scene composition and approved silhouettes were not redesigned.

## Terminology

| Meaning | English label |
|---|---|
| Player survival resource | Vitality |
| Evasion action/resource | Dodge / Dodge Charges |
| Combat opportunity resource | Instinct |
| Boss resistance | Ferocity |
| Black Sap hold | Corruption |
| Navigation | Map / Journal / Companions / Settings |
| Asha abilities shown | Pounce / Charge Block / Break Obstacles |
| Active party roles | Combat / Utility / Scout |
| Voluntary relationship | Bond / Trusted / Covenant |
| Post-Grove cooperation | Ask / Signal |

English proper names and established titles are retained, including Chapter 7: The Living Pact. Chapter 7 forms the Wild March coalition; it does not automatically award the Living Pact ending.

## Verification performed

- Viewed the localized map and all four UI plates.
- Decoded all 11 PNG plates and three JPEG overview sheets.
- Verified image hashes and unchanged pixels outside declared copy-edit regions.
- Ran local Apple Vision OCR across all 11 plates: 188 observed text lines. Reviewed the extracted text; a strict scoped scan found no Vietnamese-specific diacritics or searched Vietnamese UI labels. OCR is supporting evidence and does not replace visual review.
- Parsed the catalog with duplicate-key rejection: 847 nonempty string leaves, including the locale value; locale `en`; 17 evasion actions; 33 Living Pact requirement entries.
- Verified canonical navigation, Ask and Asha ability labels, and inspected the irreversible Dominion wording and ending conditions.
- Scoped scans of both English source files found no Vietnamese-specific diacritics or TODO/TBD/placeholder markers.

Evidence:

- `visual-review/ENGLISH-IMAGE-AUDIT.json`: edit regions, English text, concept approval and artwork-preservation assertions.
- `visual-review/ENGLISH-OCR-EVIDENCE.json`: actual OCR observations.
- `visual-review/IMAGE-MEASUREMENTS.json`: current image dimensions, hashes, language and approval status.

## Historical-source policy

The original Vietnamese Bible, engineering notes, generated source images and original generation prompts remain provenance. They are not the source of player-facing copy for implementation. The current curated plates and English content files supersede their Vietnamese display text.

Engineering discussion can remain Vietnamese. Do not reintroduce Vietnamese into game screens, subtitles, objectives, descriptions, warnings, credits or player-facing error messages. Do not silently treat English concept copy as implemented UI behavior.
