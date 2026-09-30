# Wild Crown — Implementation Roadmap, Agent DAG và Acceptance

Phạm vi: full game, không chỉ vertical slice. Đọc [01](01-MASTER-PLAN.md) trước; mọi asset/VFX task phải theo [03](03-ART-RIG-VFX-PIPELINE.md). Các ID dưới đây là work-package ID cố định để dispatch, không phải trạng thái “đã xong”.

## 1. Quy tắc triển khai

1. **Visual concept approved; English-only player content:** người dùng đã duyệt Map / UI / Characters. Giữ art/layout và dùng `content/PLAYER-COPY.en.json`, `content/GAME-NARRATIVE.en.md` cho mọi nội dung hiển thị. Không copy Vietnamese từ planning notes hoặc ảnh gốc vào runtime. Tripo đã sẵn có/được phép dùng; technical multi-view/rig gates vẫn bắt buộc. Lượt chuyển ngôn ngữ không bắt đầu gameplay implementation.
2. Một package có owner, dependencies, write scope, inputs, output contract, acceptance và actual runtime evidence. “Build pass” không đủ.
3. Không merge placeholder/mock/no-op vào milestone được gọi là hoàn chỉnh. Primitive greybox là artifact thiết kế có nhãn, không giả final art; mọi placeholder phải bị loại trước gate final tương ứng.
4. Shared contracts, registry/build/main, save schema do integrator duy nhất sửa. Agents khác đề xuất diff, không cùng ghi file.
5. Không share một mutable `.img2threejs/state.json` giữa nhiều nhân vật. Per-asset workspaces/revisions có state/evidence riêng; không chạy đồng thời mutation trên cùng rig/scene.
6. Không dùng worktree 1.5.2 như latest; toolchain lock theo upstream 2.0.0 + plugin-character, harness và Environment/Jev exact revisions.
7. Không giấu prerequisite thiếu dưới “sau này”: ENV qualification và native GLB rig measurement là package bắt buộc.
8. Khi package hoàn thành: spec compliance review → runtime/quality review độc lập → integration smoke. Reviewer không là người tự chấm asset vừa sinh.
9. Commit/push/deploy sản xuất theo quyền chủ dự án; plan không cấp quyền tự động cho agents.

## 2. Agent roles và ranh giới

| Role | Owns | Không được sửa/claim |
|---|---|---|
| L — Lead/integrator | contracts versions, app lifecycle, build/registry/route, dependency lock, merge decisions | Không tự chấm quality thay independent reviewer |
| G — Gameplay | movement, evasion, hit/targeting, encounter tokens, authoritative timings | Không thay rig geometry hoặc animation event để lách combat acceptance |
| C — Camera/traversal | CameraDirector, rails, collision-safe traversal framing | Không ghi world quest/choice state |
| A — Actor technical art | source/derivative manifest, topology/material/LOD, rig and clips per assigned actor | Không sửa frozen mesh trong rig-only pass hoặc global viewer |
| E — Environment | layout/terrain/nav/collision, scatter, restoration scene deltas | Không giả vegetation-qualified hoặc đổi story facts |
| N — Narrative/world | mission graph, choice predicates, state/saves, hub/faction transitions | Không ép optional companion xuất hiện trái history |
| F — VFX/audio/UI | event-driven effects/sound, HUD/settings/accessibility | Không tạo damage, xác định true ending hoặc ghi story flags |
| Q — QA/evidence | negative controls, browser captures, performance, branch matrix, independent verdict | Không cấp pass khi evidence missing/stale; không tự sửa implementation rồi tự approve |

Thực tế dùng 4–6 agents active ở steady state; 8 role không có nghĩa cần 8 tiến trình liên tục. Asset family độc lập có thể tách A thành human/creature khi cả hai đủ việc và không share write set. Workload tăng chỉ sau prerequisite hợp đồng đã khóa, không mở 16 agent để viết cùng controller.

## 3. Dependency waves

```text
Wave 0: L+N khóa scope/canon/contracts/toolchain
Wave 1: G/C risk lab | A native-GLB/rig evidence | E Environment/Jev qualification
Wave 2: G movement/combat | A approved asset production | N save/quest state | F cue prototypes
Wave 3: companion integration → Asha full encounter → First Pact assembly
Wave 4: full Greenwake/Canopy/Bamboo/Grove; Koro boss
Wave 5: Moonpine/Ruun/Sable || Mistveil/Ghor/Nyra (contracts chung đã ổn)
Wave 6: Sunmane/Solkar → Grove collapse
Wave 7: five return beats || Hollow layout; join before Orun/ending integration
Wave 8: side-quest completion/cast polish || perf/accessibility/branch QA
Wave 9: full campaign playtests → beta fixes → release/showcase
```

Symbol `||` nghĩa hai gói có thể thực thi song song khi không ghi chung files. Không đồng nghĩa dependency trước/sau được bỏ qua. Mỗi region owner chỉ ghi namespace region/encounters riêng; N owns global progression và L owns shared schemas.

## 4. Milestone work packages

### P0 — Product, canon, toolchain lock

**Entry:** Bible và ba quyết định người dùng đã chốt. **Exit:** approved design/contract/version manifest, không code game hàng loạt.

| ID / owner | Công việc | Dependencies / output | Acceptance |
|---|---|---|---|
| D01 / N+L | Chốt canon reconciliation, fragment ledger, representation, absence variants, ending predicate | 01 §3–6 → decision record + faction/quest IDs | Không có Solkar sau exile; Sky count đúng; Tali main/side không trùng; 3 ending reachable |
| D02 / L | Inventory current showcase callsites, launch/provenance metadata, build entry | Current registry/main/pages/scene/Vite → exact integration diff plan | Reference search trước exported-contract change; không phá existing demo lifecycle |
| D03 / L+A | Pin base2.0/plugin-character/harness/ENV/Jev, capability discovery, clean-install executable audit | upstream hashes + plugin contracts → toolchain manifest | Animated-character provider hiện đúng; exporter/CLI thật tồn tại; state cũ không nhận nhầm migration |
| D04 / G+C+N | Khóa coordinate/clock/action/attack/region/save contracts | master contracts → versioned schemas + consumer examples | Dodge directions/chirality/time authority nhất quán; không consumer cần đoán nghĩa field |
| D05 / A+E | Source rights, GenImage style lock, Tripo canary budget/account, reference inventory | 03 → approval gates + generation plan | Chỉ gửi references có quyền; không secrets trong client/artifacts |
| D06 / Q+L | Chọn desktop reference machine/browser/network và benchmark routes | performance proposal → reproducible profile | Có exact device/settings và capture method trước gọi “60fps đạt” |

**Smoke:** clean temporary installation/discovery + one executable provider command that does not claim art pass. Record output; không đổi global symlink nếu chưa cần. Không chạy mass-generation khi D05 chưa approved.

### P1 — Risk labs và qualification

**Entry:** D01–D06. **Exit:** biết control feel/rig khả thi và quality plumbing đo được; không chỉ đẹp trong studio.

| ID / owner | Công việc | Dependencies / output | Acceptance |
|---|---|---|---|
| R01 / G+C | One ribbon, arena, wall/slope/step lab; camera-relative depth, kinematic capsule spike | D04 → runnable lab | Không xuyên tường, depth đọc được, rail đổi không đảo input, có camera occlusion case |
| R02 / A | Aren/Asha approved refs → Tripo source → inspect → optimized native GLB | D03,D05 → immutable source+derivatives | Fingers/paws/joints usable; provider success không thay rig review |
| R09 / A | Canary rig/skin và minimal clips: Aren idle + lateral dodge; Asha idle + pounce; native GLB attachments/root curves | R02,D04 → rigged playable candidate packet | Auto-rig hoặc custom rig có producer owner; không đợi R03 pass để tạo input cho chính R03 |
| R03 / A+Q | Native GLTF payload exporter và G1/G3/G6/G10 measurement producers | R09 → measured rig packet + negative controls | Disconnected track/pose bleed/unbound part/tearing bị bắt; known-good measured, không synthetic zeros |
| R04 / A+G | Human dodge + tiger pounce canary, root curve/collision landing/contact | R01–R03 → actual importer playable actions | Cả body và capsule di chuyển đúng; no double-root, foot sliding trong declared contact budget |
| R05 / E+Q | Vegetation qualification fixture/evidenceMatrix pipeline | D03,D05 → positive/negative/unknown renders | 12-check contract đủ; independent review; qualified status chỉ sau evidence |
| R06 / E+L | Mixed scene external-GLB inventory/gate boundary; separate game integration checks | R05 + external route → acceptance report types | Không gọi imported tree/rock là procedural pass; tất cả subjects được game QA |
| R07 / E+Q | Jev room smoke rồi qualified vegetation exporter/router/outcome extension | R05,D03 + user consent → source-bound handoff proof | Pass/stale/partial/error không dispatch; assist patch approval exact; fresh ENV gate mới quyết acceptance |
| R08 / F+G | Telegraph VFX/audio lab, color-independent shape cues | R01,D04 → five danger families | Low-effects mode vẫn đọc footprint/timing; VFX does not own hit clock |

R05–R07 là toolchain/content capability workstream thật, không chỉ ghi tên skill vào README. R03 phải có species applicability policy và proper rigid attachments. Không sửa upstream gate `blocking:false` rồi bỏ missing data. R04 phải đo final compressed/decompressed runtime artifact.

**Gate decision:** nếu Asha rig không đạt, giữ Tripo source nhưng chuyển custom quadruped rig/clip authoring, vẫn phải qua evidence. Nếu controls không đọc được, sửa rail/ribbon before art mass-production. Nếu ENV chưa qualified, scene acceptance phụ thuộc bị block, còn gameplay lab độc lập tiếp tục.

#### Actor production lane — chạy song song sau canary, giao trước chapter consumer

Các packet AS01–AS07 gồm approved concepts, Tripo source, cleanup/LOD derivative, rig/skin, đủ clips cho chapter sử dụng đầu tiên, contact/socket/bounds manifests và species-applicable native-loader evidence. Mỗi packet có A owner riêng theo actor; Q review độc lập. Dependencies là contract gates, không phải consuming chapter: không có vòng lặp đợi chapter xong mới làm rig. G và N giao action/beat specs đã khóa tại D01/D04; asset production không chờ implementation consumer.

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| AS01 / A | Vara avian + Koro primate: utility, traversal, full Koro combat/recruitment clips | R03,R04,D05 | Wing/perch/grip/tail applicability và whole-body animation measured; đủ input P02/A103 |
| AS02 / A | Asha full combat/cleanse/bond + Tali cub rescue/reunion packet | R03,R04,D05 | Full three-phase action set, juvenile proportions, no missing phase3 reaction; đủ input B02–B05 |
| AS03 / A | Yara/Marek, poacher melee/ranged, corrupted boar và Greenwake/hub supporting cast | R03,R04,D05 | Human/supporting creature rigs, main dialogue/rescue/combat clips ready trước P7; poachers/boar trước slice |
| AS04 / A | Ruun/Luma/Sable canid packet | R03,R04,D05 | Gaits/chain/pounce/hold/howl, faction/body differences và contacts ready trước P8 |
| AS05 / A | Nyra felid + Ghor crocodilian packet | R03,R04,D05 | Stealth/ambush và land/water/tail/jaw clips, species-specific evidence ready trước P8 |
| AS06 / A | Solkar packet, council representation assets, Sunmane fauna | R03,R04,D05 | Strength/army/roar, Bond/exile/Dominion posture và no-extra-full-companion policy ready trước P9 |
| AS07 / A | Orun biped + Crowned Beast bespoke packet; Yara transformation | R03,R04,D05 | Mirror acrobatics, six-aspect attacks, core/crown transitions, compatible bounds/sockets before P10; Yara transform before Grove collapse |

AS01–AS07 có thể fan out theo nhu cầu milestone, không cần sản xuất toàn bộ cùng lúc. F02 sau P10 chỉ completion/polish và social/cinematic coverage còn lại; không là producer đầu tiên của các rigs trên.

### P2 — Game shell, locomotion và camera

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| M01 / L | Game HTML/build entry, GameApp start/pause/resume/dispose, single loop | D02,R01 | Load route trực tiếp, vào/ra game không duplicate RAF/listeners, no gallery OrbitControls in combat |
| M02 / G | Input KB/mouse/gamepad, deadzone/remap, fixed-step intent, movement/strafe | M01,D04 | Same path at 30/60/120 render cadence; disconnect pauses safely; no input while paused menu |
| M03 / C | Exploration rail/junction, combat anchor, boss safe-frame, occlusion fade | R01,M02 | No sudden direction reversal; feet/landing read; camera collision no wall clipping |
| M04 / G+C | Vault/low ledge/slide/swing contextual traversal, start/landing contracts | M02,M03 | No free jump required, no unreachable landing, interruption/reset leaves actor safe |
| M05 / N+L | New Game/Continue/checkpoint transaction, profile settings persistence | M01,D04 | Refresh resumes valid checkpoint; corrupt/quota save error visible, old save kept |

**Runtime proof:** newcomer walks near/far through junction, traverses blocked log, bumps walls, pauses/tab-switches, refreshes and resumes. Debug rails/velocity/collider are available to QA but not required to proceed.

### P3 — Wild Flow Evasion và combat

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| C01 / G | Evasion resolver/charges/iframes/avoidance classes/input queue | M02,M04,R04 | Wrong-direction dodge không tự sửa; charge=0 không tạo action; collision clamps trajectory |
| C02 / A+G | Full 17 evasion entries and core locomotion/action clip mapping | C01,R03 | Left/right, landing/recovery/counter transitions visibly distinct and correct, not renamed copies |
| C03 / G | Light1–3/heavy/charged heavy/tether, soft target and hit windows | C01 | Swept hit coverage, no always-on weapon collider, no target against input |
| C04 / G | Perfect Dodge/threat proof/counter/Instinct, clocks/slow motion | C01,C03 | One reward per valid hit group; lingering hazard cannot farm; render rate does not shift windows |
| C05 / G | Enemy archetypes, attack-token scheduler, offscreen rules | C03,R08 | <=1–2 main tokens, ranged quota, no unannounced offscreen active hit |
| C06 / F | HUD timelines, warnings/audio, cue cancellation | C01–C05 | Pause/death/interrupt cannot orphan telegraphs; reduced effects preserves cues |

**Runtime proof:** five attack families in arena, near wall/corner, delayed second hit, one/two/zero charges, simultaneous pet/player hit, canceled tether, slow-motion boundary. Debug timeline records expected/actual phase and frame capture. Permanent tests target timing boundaries, duplicate hit/reward and resource invariants, not source-text matching.

### P4 — Companion, quest, restoration, durable state

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| P01 / G | Follow/Stay/Focus/Defend/Recall/ability intents, slots and nav fallback | C05,M04 | Pet not in player slot; no chase out of arena; recall does not bypass locked gate |
| P02 / G+A | Vara mark/offscreen/landing, Koro interact/drop/pull; party budgets | P01,C06,AS01 | Utilities change encounter/route; no pet solves objective uncommanded |
| P03 / N | Objective/quest graph, fragment ledger, faction relationships and immutable choices | M05,D01 | Idempotent commits, no double fragment, story flags not inferred from mesh presence |
| P04 / N+E | Restoration deltas and route/nav/collision swap | P03,R06 | No actor falls through changed ground; reload matches restored routes/audio/spawns |
| P05 / N+L | Run-ledger Dominion, save slots/export/import/migration, showcase/replay isolation | P03 | Old snapshot same run cannot erase history; New Game new run; reward not imported from replay |
| P06 / F+N | Command wheel, journal/predicate reasons, warnings before irreversible choice | P01,P03,P05 | Keyboard/gamepad navigable; warning matches actual ending logic |

**Runtime proof:** Koro path failure then recall; Vara mark at pounce commit; restore + save + refresh; commit Dominion then load older same-run slot; export/import; branch absent companions. No live anti-tamper guarantee claimed.

### P5 — Asha: first complete boss

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| B01 / G+E | Arena camera/ribbon/nav, stalk tokens, phase latches | C05,P02,R06 | Boss+pet budgets counted globally; no phase regression |
| B02 / G+A+F | Phase1 stalk/pounce/claw/side charge | B01,C02,AS02 | Three cue layers, commit frame prevents snap retarget, valid dodge/counter |
| B03 / G+A+F | Phase2 roar/Sap trail/corrupted pounce/ground wave | B02 | Hazard classes distinct; slide does not magically clear ground wave |
| B04 / G+N | Phase3 Bamboo Charge → Koro → tether → approach → cleanse | B03,P03 | Utility guaranteed in this beat; interruption/missed window recoverable |
| B05 / A+N+F | Tali reunion/Bond, unlock Asha, environment restoration, checkpoint | B04,P04,P05 | Nonlethal, reward once, skip/view/load equivalent outcomes |

**Runtime proof:** start encounter normally; survive phases without debug; deliberately miss cleanse; retry; finish and reload at post-bond checkpoint. Capture same action with/without mark/reduced VFX to verify fairness. No cutscene-only victory workaround.

### P6 — The First Pact polished vertical slice

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| S01 / N+E | Six segments: entry/chase/camp/tracking/Asha/pact, provisional Koro recap | P5,P04 | Same mission nodes as campaign, explicit showcase run/entry state |
| S02 / A+E | Integrate final Aren/Vara/Koro/Asha/Tali/2 poachers/small corrupted animal, full slice environment | R03,R05,R06,C02,AS01,AS02,AS03 | Production manifests/evidence; no greybox final art masquerade |
| S03 / F+N | Tutorial pacing, Echo phrases, audio, subtitle/HUD/settings, story cameras | S01,S02 | Player knows objective without console/wiki; no unskippable repeated intro |
| S04 / Q+L | Newcomer 10–15min run, desktop profile, deployed-like build entry | S01–S03,R07 | Bible DoD: >=6 dodge types, Asha>=5 skills, actual Vara/Koro impact, perfect counter, cleanse, restoration, save, audio |

Slice DoD floor không bỏ 17 evasion entries trong asset coverage. Nếu pacing quá dài, chỉnh route/dialogue/tutorial density, không bỏ mechanic hoặc âm thầm đổi mục tiêu thành trailer.

### P7 — Full Act I và Grove, không dùng slice thay chapter

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| A101 / N+E | Greenwake prologue, Vara/Sky, staff, corrupted boar cleanse | P6,AS03 | New Game bắt đầu hợp canon, fragment count correct |
| A102 / E+N | Full Canopy three missions, water/seed conflict, branch routes | A101 | Exploration/causality/restoration playable, không chỉ cutscene |
| A103 / G+A | Koro boss full attack set + cleanse/recruitment | A102,C05,AS01 | Boss distinct from chase; Canopy fragment unique |
| A104 / E+N | Full Bamboo tracking/camp/Marek/Tali, integrate Asha as campaign node | A103,P5 | No curated hidden grants; quest sequence reachable từ New Game |
| A105 / N+F+E | Grove stages1–2, upgrade/training/party/visions, Tali habitat | A104 | Essential services/save/companion state persist; feedback environmental |
| A106 / N+G | Progression/healing/Instinct final rules and first side quests | A105,C04 | No grind requirement; upgrades unlock actions not just HP scaling |

### P8 — Act II parallel region cells

Chia hai agents region độc lập, shared N owner integrate story order/reveal.

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| A201 / Moonpine cell | Third Howl/Two Packs/Alpha Below, cold/ice/chain arenas | P7,AS04 | Three missions, geography/tracking distinct |
| A202 / Moonpine cell+G | Ruun boss multi-lane/chain/ice, leadership choice | A201 | Ruun/Luma/Dominion world deltas; Sable joins independently of ruler |
| A203 / Mistveil cell | Eyes/Black River/Mire Maw, Nyra investigation, Marek choice | P7,AS05 | Truth discoverable, no forced human speech for animals |
| A204 / Mistveil cell+G | Ghor land/water boss, river restoration, Nyra support | A203 | Hidden attack fair cues, no free jump trap, Shadow gained once |
| A205 / N+F | Yara reveal two stages, Grove3–4, quest callbacks | A202,A204 | Order-aware dialogue; wolf choice×Marek six branches continue |

Moonpine và Mistveil có thể build song song nhưng campaign unlock order vẫn theo Bible. Trước merge phải test shared resource budgets và nav contracts, không chỉ từng region standalone.

### P9 — Sunmane và Fall of Grove

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| A301 / E+N | Silent Plains/Tribute/Lion Offer, resource order vs coercion | P8 | Dominion hấp dẫn về gameplay, council/exile có consequence |
| A302 / G+A+F | Solkar 3 phases, support reservations, possession telegraphs | A301,AS06 | Full roster represented through windows within caps |
| A303 / N | Bond/Exile/Dominion choice, Crown ledger, Grove5 | A302,P05 | Exile removes actor consistently; council representation distinct |
| A304 / G+N+E | Grove assault: nonlethal allies, pillars, Tali, Yara, collapse | A303,AS07 | Missing/exiled actors have authored variant; rescue failure retry |
| A305 / N+F | Refuge, loss of coercion, Ask/Signal UI, intact essential services | A304 | Player can save/party/train/continue; no accidental deletion of learned utility |

### P10 — Return campaign, Hollow, Orun, endings

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| A401 / region cells+N | Five return beats in master §5, coalition re-commitment | P9 | New objectives reflect history, not five fast-travel cutscenes |
| A402 / E+N | Hollow state routes, memories, independent player paths | P9 | Absent Marek/Nyra/Solkar never sole required key |
| A403 / G+A | Orun phase1 mirror; phase2 Crowned Beast six aspects | A402,AS07 | Predictable cues, real punish windows, no infinite input-reading counter |
| A404 / G+N+F | Phase3 possession/crown choice, exact eligibility evaluator | A401,A403,P05 | All valid histories finish, true-ending reasons consistent with journal |
| A405 / N+E+F | Three epilogues/Grove outcomes/Yara fate/credits/pre-finale return | A404 | Skip/load/view same world result, branch vignettes not contradictory |
| A406 / Q | 18 baseline histories: wolf3×Solkar3×Marek2; targeted relationship/quest edges | A405 | Reachability and ending evaluator proven; not 18 separate content forks |

At least three complete normal-input campaign runs for ending families, plus deterministic targeted save fixtures for all 18 history branches; fixtures do not replace full playthroughs.

### P11 — Content-complete alpha

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| F01 / N+region cells | Complete all 12 side quests, branch availability and callbacks | P7–P10 | Every quest changes world/ability/relationship; no duplicated fetch padding |
| F02 / A+F | Completion/polish full cast; remaining social/cinematic clips, closeups/SFX/music/subtitles and hub behaviors | P10,AS01–AS07 | First-use rigs already accepted upstream; all named actors/families fully covered, no unapproved concept as production reference |
| F03 / L+F | Menus/options/remap/localization-ready strings/credits/licenses | P10 | Full game usable without debug/console, no missing language strings |
| F04 / Q+N | Content graph reachability, absence matrix, save chapter boundary matrix | F01–F03 | Every named mission/beat/ending accounted, no stub routes |

English is the default and sole release language for all player-facing content: menus, HUD, map, quests, abilities, tutorials, dialogue, subtitles, Echo Sense phrases, codex, choices, endings, errors and credits. Use `content/PLAYER-COPY.en.json` and `content/GAME-NARRATIVE.en.md` as the English authoring baseline. Do not ship mixed Vietnamese/English fallback strings. Animal phrases remain concise. Any recorded voice lines must be in English; voice production remains a separate asset task, not a claim that recordings already exist.

### P12 — Beta, balancing, accessibility, optimization

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| Q01 / Q+G | Newcomer runs with telemetry local session notes; reaction/readability/difficulty | P11 | Median critical path within 8–12h target without retries/padding; confusion hotspots resolved |
| Q02 / Q+F | Accessibility matrix: no color/audio-only cues, reduced effects, subtitles, remap | P11 | Same mechanics readable in reduced modes; focus/UI navigation usable |
| Q03 / L+A+E | Actual LOD/texture/animation update/culling/streaming optimization | P11 | Profiler on locked hardware meets agreed frame/load/memory targets |
| Q04 / Q+L | Save migrations, corruption/quota/error recovery, export/import, browser lifecycle | P11 | No silent data loss; prior compatible save migrates with backup |
| Q05 / Q | 30min combat/region soak + 10 enter/exit loops + cinematic skip/load | Q03,Q04 | No leaks, stranded input, duplicates or lost world facts |
| Q06 / N+G | Balance Bond/Dominion and refusal route, tutorial pacing | Q01,A406 | Dominion tempting but fair, no mandatory low-Bond grind, final attacks always counterable |

Không đổi ngưỡng để che regression; mọi budget revision phải đi kèm profile evidence và quyết định lead. Do not optimize by removing requested animals/regions/ending.

### P13 — Release và showcase package

| ID / owner | Công việc | Depends | Acceptance |
|---|---|---|---|
| REL01 / L | Production build, actual hosting paths/MIME/cache/decoder/audio files | P12 | Deep link/reload works, no missing GLB/decoder/assets, no provider secret shipped |
| REL02 / L+F | Gallery launch card, source/Tripo provenance, accurate external-asset labels | REL01,D02 | Existing demos intact; game entry not squeezed into Group-only runtime |
| REL03 / Q | Clean browser profile new game→checkpoint→continue and ending smoke on deployed build | REL01 | Actual surface/input/state observed, not dev server-only |
| REL04 / F+N | Trailer/gameplay capture/stills/technical breakdown/credits | REL03 | Captured from shipping gameplay, not separate fake-quality trailer scene |
| REL05 / L+Q | Rollback/build manifest/save compatibility/release known-issues review | REL03 | No blocker/open data-loss defect; version and provenance reproducible |

Full game chỉ “done” sau P13, không sau P6 hay khi có đẹp 3D viewer.

## 5. Cross-cutting acceptance suite

Đây là **test plan**, chưa phải test results. Permanent tests chỉ cho behavior/invariants có rủi ro; browser/runtime proofs cho motion, camera, readability, performance.

| Case | Setup/action | Expected observable result |
|---|---|---|
| T01 Camera-depth | Hold near/far at junction during pending enemy telegraph | Direction intent stable, angle locked until hit, landing readable |
| T02 Dodge wall | Cartwheel toward wall at multiple start distances | Capsule sweep stops safely; visual root/IK does not penetrate or detach |
| T03 Charges | Queue Dodge at 0/1/2 charges, including paused/slow frames | Exact debit/recharge, no negative charges or double action |
| T04 Perfect boundary | Same attack early/valid/late plus lingering hitbox | Only valid threatened window gives one counter/reward |
| T05 Hit windows | Weapon sweep outside/inside active phase across render rates | Damage only authoritative active window, no tunneling missed by low render FPS |
| T06 Commit | Asha pounce then player swaps depth after commit | Landing stays committed, mark and actual impact agree |
| T07 Miss cleanse | Ferocity break → tether interrupted → retry | Phase not regressed, no invincible boss, reward exactly once |
| T08 Token pressure | Six hostile incl boss + legal party | No over-quota attacks/unwarned offscreen strikes; defensive route exists |
| T09 Companion path | Block Koro nav and recall near locked gate | Safe recall, no gate bypass, interaction does not succeed remotely |
| T10 Party lifecycle | Swap/save/load/unload during Follow/Stay/Special | No duplicate actor, slot/token ownership released correctly |
| T11 Restoration | Trigger change while actors on old bridge/water edge | Safe transition, nav/collision/render agree after reload |
| T12 Choice crash | Interrupt around transaction write/choice cinematic | Exactly old or new durable state, never half reward/fragment/choice |
| T13 Strict history | Dominion → load older same-run save → high Bond | Living Pact still locked with explanation; new run unaffected |
| T14 Replay isolation | Finish First Pact/chapter replay then campaign Continue | No imported rewards/history resets or false ending eligibility |
| T15 Absence | Solkar exiled, Marek absent, low-Bond faction refusal | No nonexistent actor cues; alternate mandatory path works |
| T16 Grove | Ally possession + Tali rescue + loss of Call | Nonlethal target rules; retry safe; Ask/Signal/essential services work |
| T17 Final predicate | Each required condition missing alone; full satisfied | Journal/final choice agree; other endings remain reachable |
| T18 Native rig | Every clip + transitions loaded from production GLB | Measured deformation, no bleed/unbound parts, correct attachments/bounds |
| T19 Missing evidence | Remove G1/G3/G6/G10 or make source hash stale | Game asset gate rejects; aggregate green cannot bypass |
| T20 Species | Bird flight/paw gait/Ghor swim and intended rigid staff | Correct applicable contact policy, no fabricated human measurements |
| T21 Environment | Bad scale/ground/material/occlusion/provenance fixtures | Correct fail/unknown; only qualified evaluated scope can pass |
| T22 Jev | Pass/partial/stale/error/unqualified gate; then eligible failed gate | No-call on forbidden inputs; one bounded advisory on eligible consented fail |
| T23 VFX capacity | Saturate cosmetic pools during roar+Sap+command | Required telegraph remains; reduced mode same footprint/timing |
| T24 Pause/time | Background tab, resize, controller disconnect, slow motion | No catch-up damage burst, no frozen input or runaway audio |
| T25 Loading failure | Reject GLB/decoder/audio region request | Recoverable loading UI, no void spawn or corrupted save |
| T26 Save failure | Quota exhausted/corrupt/unknown schema/import same run | Visible error/backup/export option; monotonic history kept |
| T27 Memory | Ten identical region cycles and 30min soak | Resources/heap stable per profile, no stale mixer/listener references |
| T28 Deployment | Direct game URL cold cache + refresh + secondary route | Assets resolve with correct base/cache/MIME, playable not just gallery |
| T29 Accessibility | Disable color discrimination/audio; reduced effects + gamepad | Dangerous cues and menu functions still understandable |
| T30 Complete campaign | Fresh normal-input runs for 3 ending families | All chapters playable, no console/debug grant, credits and save policy correct |

## 6. Multi-agent dispatch template

```text
Package: [one or a bounded set of IDs from this plan]
Goal: [consumer-visible behavior]
Baseline: exact repository/worktree + toolchain lock revision
Read: Bible relevant sections + plan01/02/03 + current contracts
Prerequisites: IDs with evidence paths and accepted revisions
Write ownership: exact region/actor/module paths
Forbidden writes: registry/main/build/shared contracts unless integrator assignment
Inputs: schemas, approved reference/GLB hashes, world facts, action IDs
Outputs: code/data/assets + manifests + runtime evidence + known limitations
Acceptance: exact package criteria and cross-cutting T cases
Verification: run real changed path, capture observable state/motion/frames
Constraints: direct Tripo GLB, game clocks authoritative, no fake pass/stubs
Handoff: files changed, contract deltas, commands/results, evidence, blockers
```

For asset agents add: family/species, frozen derivative revision, allowed rig-only changes, clip/contact list, action markers, applicable gate rows, concept approval IDs. For region agents add: required/optional companion policy, chapter entry facts, restoration variants, nav/camera constraints, scene inventory.

### Merge gate

1. Owner produces runnable package, not a broad status essay.
2. Spec reviewer checks every acceptance and user item; rejects silent scope reduction.
3. Quality reviewer inspects actual runtime/art evidence and regression risk.
4. Integrator replays cross-boundary smoke; updates authoritative task status only with accepted artifact IDs.
5. Contract change invalidates affected consumers/evidence. Notify owners and regenerate relevant packets before merging, not after release.

## 7. Artifact organization khi bắt đầu implementation

Proposed project-local structure; chưa tạo trong game repo:

```text
production/wild-crown/
  toolchain-lock.json
  decisions/
  source-manifests/
  assets/<assetId>/<revision>/
  evidence/<packageId>/<revision>/
  captures/<routeId>/<buildId>/
  qa/branch-matrix.json
  qa/performance-profile.json
  reviews/
```

Large Tripo source/texture/binary files theo existing storage/LFS policy đã xác minh ở P0, không commit hàng trăm MB vô ý. Browser receives published derivatives only. Logs must redact tokens/provider signed URLs where sensitive.

No shared mutable reports: agent viết evidence path riêng; integrator publishes aggregate index. Latest-by-filename không đủ: bind build/source/asset revision và capture settings. Screenshots của revision cũ không chứng minh code mới.

## 8. Release blocker checklist

- [ ] Six boss identities và full 8 chapter + prologue + epilogue present.
- [ ] Five regions/Hollow/Grove/refuge/world deltas playable; twelve quests complete.
- [ ] Three endings đúng predicate; strict history not erased by official load/import routes.
- [ ] All required named cast has approved model, complete necessary rig/animation and measured runtime packet.
- [ ] Native GLB evidence adapter and species equivalence reports truthful; no missing rig gates hidden by aggregate.
- [ ] Environment/Jev qualification/consent/acceptance scope met; no forest-as-room shortcut.
- [ ] First Pact remains 10–15min same-runtime excerpt, not substitute campaign.
- [ ] Newcomer campaign duration measured; no padding by deaths/grind.
- [ ] Performance/device/browser/loading/memory acceptance measured on locked profile.
- [ ] Accessibility, menus/settings, save recovery, credits/licenses, deployed entry and asset paths verified.
- [ ] No game-blocking defect, missing final content, fake effect/animation, or placeholder accepted as final.

## 9. First executable assignment

Bắt đầu **D01–D06**, rồi fan out **R01**, **R02/R03**, **R05/R06** trên write sets riêng. Không bắt đầu bằng dựng cả khu rừng đẹp hoặc generate cả cast. Deliverable đầu tiên phải là design/toolchain contract lock và ba risk-lab assignments có input/output rõ; milestone implementation đầu tiên chứng minh Aren né và Asha lao trong camera 2.75D thật, có collision và measured animation.

Plan không đưa thời hạn giả cho AI agents hoặc tổng chi phí chưa được đo. Sau P1, dùng số liệu actual asset iterations, clip authoring và review throughput để lập lịch nguồn lực; quality gates và toàn bộ scope ở trên không đổi theo ước lượng lạc quan.
