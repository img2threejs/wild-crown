# itch.io beta publishing packet

**Prepared, not published.** Target: a public, free desktop-web beta with optional donations. No itch.io project, upload, seller account, payment setting or public visibility has been created or changed. Public distribution and donations remain gated below. This is not strict release acceptance.

## Delivery decision

Create an itch.io **external-link listing** pointing to **https://wild-crown.vercel.app/**. Keep the game on its existing root-hosted HTTPS origin. This is the smallest feasible launch: no game ZIP, executable wrapper, fake HTML launcher, content removal or new hosting account is necessary.

The repository homepage names that URL. On 2026-10-24, anonymous HTTP probes returned 200 for the root, both referenced entry modules and stylesheet. The actual production Title loaded in an owned browser; Settings opened and Escape returned to Title. This is a bounded entry check, not a full production campaign qualification. The new guidance implementation must be deployed and smoke-checked separately before advertising it as live.

### Why not upload the current HTML5 ZIP?

Measured final Node-22 guidance-candidate `dist/` inventory (`main-C20Xv3te.js`): **432 files, 881,101,962 logical bytes (840.28 MiB)**. Largest file: 93,648,764 bytes; no relative path exceeds 240 characters. The count and largest file fit itch.io's published defaults, but the extracted total exceeds its **500 MB** HTML5 limit. Compression does not fix an extracted-size limit. This is a measured artifact, not a promised size for future builds; remeasure any future HTML5 ZIP.

Also, `vite.config.ts` uses `base: '/'`; README explicitly does not support a project subpath. itch.io hosts HTML5 assets under a subdirectory and requires relative paths. A future native itch.io browser build needs a separately approved size/subpath cutover and real iframe, asset, save and input verification. Do not upload only `index.html` or remove chapters/assets to make the ZIP fit. Support may consider limit exceptions; none has been obtained.

## Exact draft configuration

Create the project in your own account with **Dashboard → Create new project**. Stay **Draft** while configuring it.

| Field | Prepared value |
| --- | --- |
| Title | Wild Crown: The Broken Pact — Public Beta |
| Short description | A nonlethal story adventure through a living forest. Free desktop-browser beta. |
| Classification | Games |
| Kind of project | Downloadable, using an external-link upload; not an embedded HTML5 game |
| Release status | In development |
| Genre | Adventure |
| Suggested tags | 3D, Singleplayer, Fantasy, Story Rich, Third Person; choose existing tags in the editor |
| Language | English |
| Input | Keyboard and mouse; do not claim physical-controller qualification |
| Mobile / touch | Do not mark supported |
| Price target | $0 or Donate, only after hosting and seller/payment clearance below |
| Visibility target | Public, but keep Draft until the checklist is satisfied |
| External upload name | Play the free browser beta — opens the game website |
| External upload URL | https://wild-crown.vercel.app/ |

In **Uploads**, use the editor's external-file/link option and enter that URL and label. itch.io explicitly supports links to external websites. Do not tick “This file will be played in the browser” for a pretend launcher, and do not assign Windows/macOS/Linux executable flags to this web link. Add the same clearly labelled play link at the top of the description so visitors know it opens another site. If the current editor or account does not offer the documented external-link option, keep the project Draft and resolve that mismatch; do not substitute an incomplete ZIP.

Save and **View page**. In a private/logged-out window, verify the preview's play link opens the real game, not the project editor. A Draft's private visibility is expected; actual logged-out public reachability is checked only after the owner intentionally publishes.

## Paste-ready public description

Copy the following section, not the engineering checklist, into the itch.io description:

---

### Play the free browser beta

**[Open Wild Crown in your desktop browser](https://wild-crown.vercel.app/)**

The game opens on its own website. There is no download or installation required.

Enter Erya, a forest strained by fear, scarcity and Black Sap. Confront corrupted creatures without killing them, listen to their communities, and decide how to rebuild what has been broken.

Choose a Warden, explore story chapters and discover companions through your journey. Attacks create openings; cleansing corruption, helping communities and making story choices are separate parts of restoring the forest.

### Before you play

- **This is an in-development beta, not the finished game.** It includes generated candidate assets that are not release-verified. Visuals, balance and content may change.
- Use a desktop browser with WebGL2 and a keyboard/mouse. Mobile and touch play are not supported. Device performance varies; no fixed frame rate or playtime is promised.
- Initial and later-region loads can be large. Keep the tab open while the loading screen is working.
- Progress is stored locally in this browser on the game website, not in your itch.io account. Keep using the same game URL, browser and profile. Clearing site data or changing devices can lose local progress; use the game's save export before moving or clearing data.

### Default controls

WASD / arrow keys move; Shift runs; Space jumps. F dodges. J is light attack, K heavy and L ranged. E talks or interacts when a prompt appears. Hold T to lock onto a creature. Q is contextual Tether or Cleanse; follow the live skill card and next-action panel. Escape pauses. Bindings can be changed in Settings.

**A creature staying alive at 1 HP is not a killing objective.** Open the required weakness, then follow the Tether/Cleanse instructions. Tether costs 20 mana and Cleanse costs 30. Grounded walking/running restores mana; standing still does not.

### Help improve the beta

Please use this page's comments to report where you got stuck. Include the chapter, hero, current objective, what you tried, browser/device and a screenshot when possible. Avoid posting personal information or save files publicly.

---

Optional donation sentence, **only after clearance and payments are enabled**: “The beta is free. Donations are optional support for its development and do not promise a delivery date or specific future content.” Do not display this sentence while donations are disabled.

## Images ready for owner review

- **Cover candidate:** [`asset-source/ui/itchio-cover-beta.jpg`](../../asset-source/ui/itchio-cover-beta.jpg), 630×500 (315:250 ratio). Captured from the real production Title at 1260×1000, then proportionally resized; no generated replacement art, stretching or removal of the candidate banner. This is a title-screen cover, not a gameplay screenshot or rights approval.
- **New UI screenshot candidates:** [`canopy-guidance-opening-r1.webp`](../../asset-source/playtests/evidence/player-feedback/canopy-guidance-opening-r1.webp), [`canopy-guidance-tether-r1.webp`](../../asset-source/playtests/evidence/player-feedback/canopy-guidance-tether-r1.webp), [`canopy-guidance-postboss-r1.webp`](../../asset-source/playtests/evidence/player-feedback/canopy-guidance-postboss-r1.webp). These show the real local native Canopy renderer from an explicitly prepared opening, not an uninterrupted campaign run. Do not advertise unreleased UI as already live; refresh/review after deployment.
- For a broader 3–5-image gallery, review the existing native [`later-chapter-moonpine-restoration.webp`](../../asset-source/generated/later-chapter-moonpine-restoration.webp) and [`later-chapter-sunmane-restoration.webp`](../../asset-source/generated/later-chapter-sunmane-restoration.webp) against the current build first. They are historical bounded-checkpoint captures, not newly verified scenes. Do not upload them blindly or duplicate them into a second asset folder.

Keep generated-asset/beta disclosure. Use only images the owner approves for distribution; gameplay capture does not clear the source assets' rights. No itch.io media upload has occurred.

## Public-beta go/no-go checklist

- [ ] **Distribution permission:** review every distributed asset/reference/provider term, including Tripo-generated meshes, Adobe Mixamo-derived motion, generated UI/concepts, fonts, textures and audio. `docs/production/concepts/MANIFEST.json` still explicitly requires production/distribution-rights review. Free access and an external link do not remove this requirement.
- [ ] **Attribution:** reconcile in-game Credits with `public/audio/provenance.json` and the other dependency/provider notices. In particular, preserve the correct author/source/license attribution for any CC-BY audio. A license allowlist or a matching hash is not legal clearance.
- [ ] **Asset acceptance:** review the existing [candidate acceptance list](../features/asset-acceptance.md). Do not flip `verified` flags, bypass strict release gates or describe this beta as a qualified finished release. Any decision to allow public testing of candidates must be explicit and must not waive distribution rights.
- [ ] **Hosting plan:** confirm the actual Vercel project/account plan and its current commercial-use terms. The current plan is unknown. Vercel documents Hobby as personal/non-commercial; do not assume optional donations are exempt. Resolve eligibility before enabling donations or paid promotion. Monitor transfer/request limits; a root HTTP 200 is not a load test.
- [ ] **Payments:** owner completes itch.io Seller Settings, payout/tax requirements and any provider verification privately. No credentials or API tokens belong in this repository or chat. If payments are not ready, keep donations disabled; do not pretend a $0-or-Donate setup is active.
- [ ] **Candidate build selection:** deploy the reviewed guidance commit to the stable game origin, verify its build identity and cold-cache Title → New Game → gameplay/save/load on a clean profile, and retain a rollback deployment. The URL follows production updates; a later main deployment can change what itch.io visitors play.
- [ ] **Player support:** enable comments or a moderated community and decide who handles reports. The draft's feedback instructions use itch.io comments, not a fabricated support email or issue link to this private repository.
- [ ] **Owner preview:** inspect cover, copy, external play button, disclosures and pricing. Only then intentionally set Visibility to Public. Check the public listing and outgoing game link logged out, and check donation behavior only after it is actually enabled.

## Decisions still required from the owner

1. What is the Vercel plan, and is public-beta distribution with optional donations allowed under its current terms? If uncertain, leave donations disabled while resolving eligibility; do not silently assume Hobby or upgrade billing.
2. Have the distributed assets, generated references and required credits been cleared for public distribution, and do you approve public testing with the candidate-asset disclosure? This is distinct from promoting assets to release-verified.
3. When ready, create the Draft in your own itch.io account and provide its public project URL (no password/token). The account's creator name, available project slug and actual seller readiness are not discoverable from this repository. No project URL has been invented here.

## Primary sources

- [itch.io: Getting started](https://itch.io/docs/creators/getting-started) — external website links, project metadata, cover ratio, screenshots, preview and visibility.
- [itch.io: HTML5 games](https://itch.io/docs/creators/html5) — root index, relative paths, iframe delivery and extracted file/size limits.
- [itch.io: Pricing](https://itch.io/docs/creators/pricing) — $0 or Donate versus No payments and seller prerequisites.
- [Vercel: Hobby plan](https://vercel.com/docs/plans/hobby) — personal/non-commercial restriction and plan limits. Actual project plan remains unverified.

Related preparation issue: #145. This packet neither publishes the game nor grants distribution permission.
