# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Players of a single-player story action adventure, at a desktop browser with keyboard and mouse or a gamepad. Between fights they open menus to learn what to do next (quest, map), to manage companions, and to adjust settings; during fights they read the HUD at a glance.

## Product Purpose

Wild Crown: The Broken Pact is a cinematic action adventure in the forest world of Erya. The hero restores corrupted regions by cleansing creatures poisoned by Black Sap rather than killing them, recruiting them as companions and choosing Bond or Dominion. Success for the interface: a player always knows the current goal and how to reach it, and the menus feel like part of the game world rather than a web page.

## Positioning

Combat resolves by cleansing and bonding, not killing: Ferocity, Corruption, Root Tether and Cleanse are the core verbs, and the world visibly heals (restoration states) as the story advances.

## Operating Context

Built with TypeScript, Three.js and Vite; the UI is DOM over a live WebGL scene. Menus open over a paused world (Map, Journal, Companions, Settings, Pause, Save/Load, Defeat, story dialogue, tutorials). Input: keyboard/mouse and gamepad, remappable; menus are navigated with focus.

## Capabilities and Constraints

- English player copy from `docs/production/content/PLAYER-COPY.en.json`.
- Accessibility settings are live (reduced motion, high-contrast target ring, telegraph intensity, subtitles); motion must respect Reduced Motion.
- Candidate assets are not release-verified; a status banner must remain visible in candidate sessions.
- Scope confirmed 2026-10-15: redesign every menu screen and bring the HUD into the same language. No existing visual element is a binding commitment; content and function must be kept.

## Evidence on Hand

World map illustration `public/ui/world-map-game.webp`, companion portraits `public/ui/portrait-*.webp`, journal illustration `public/ui/map-journal-illustration.webp`, region presentation art and lore in `src/content/regionPresentation.ts`, hero catalogue in `src/game/heroes.ts`. No marketing claims, reviews or release dates exist and none may be invented.

## Product Principles

- The next step is never hidden: every menu answers "what do I do now".
- The interface belongs to Erya: living forest, Heartroot and the pact, not a website.
- Fast to operate with keyboard and gamepad; spectacle never delays input.
- Honest state: show only what the simulation and campaign actually know.

## Accessibility & Inclusion

Keyboard and gamepad parity, visible focus, Reduced Motion respected, readable contrast over the 3D scene.
