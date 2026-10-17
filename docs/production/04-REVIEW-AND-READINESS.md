# Wild Crown — Review và trạng thái sẵn sàng

Ngày review planning baseline: 2026-09-30. Status cập nhật: **2026-10-14**. Các review/check bên dưới là lịch sử của deliverables planning, không phải QA pass hôm nay hoặc release acceptance.

## Deliverables

1. [Master plan](01-MASTER-PLAN.md): product scope, canon corrections, gameplay depth, campaign/quest/boss design, architecture, saves, budgets và P0–P13.
2. [Implementation và agents](02-IMPLEMENTATION-AND-AGENTS.md): **85 work packages**, owner/dependency/output/acceptance; multi-agent ownership và **30 acceptance scenarios**.
3. [Art–rig–VFX pipeline](03-ART-RIG-VFX-PIPELINE.md): Codex GenImage, direct Tripo GLB, rig families/animation coverage, native importer evidence, Environment/Jev và story-driven effects.
4. Concept candidates: [Aren](concepts/aren-candidate.webp), [Asha](concepts/asha-candidate.webp), [Orun](concepts/orun-candidate.webp), [provenance manifest](concepts/MANIFEST.json).

## Traceability yêu cầu người dùng

| Yêu cầu | Vị trí đáp ứng |
|---|---|
| Game hoàn chỉnh, showcase mới | 01 §1/§7/§9; 02 P7–P13, game entry riêng và gallery launch |
| Plan cực kỳ chi tiết theo giai đoạn | 02 P0–P13, 85 package với dependency và acceptance |
| Hỗ trợ multi-agent song song | 02 §2–3/§6: ownership, waves, dispatch template, review/merge |
| img2threejs mới nhất | 01 §2.2: official v2.0.0 verified tag/commit, plugin-character/harness prerequisite |
| img2-environment + img2-jev | 03 §7; 02 R05–R07: qualification, evidence, consent, routing/repair limits |
| TripoAI models | 03 §1/§4: immutable source, optimized direct runtime GLB, offline generation |
| Rigging/animation người và thú | 03 §5–6; 02 R09/R03/R04/AS01–AS07/C02 |
| Codex GenImage nhân vật ấn tượng | Ba ảnh thật + 03 §2–3 production reference protocol; toàn cast direction matrix |
| VFX sáng tạo theo truyện | 03 §8–9: Heartroot/Bond/Dominion/Sap, 15 cue IDs, bespoke boss/ending motifs |
| Gameplay chiều sâu | 01 §4–6: causality, evasion decisions, companion verbs, faction choices, 5 return beats |
| Hỏi khi chưa chắc | Ba lựa chọn đã hỏi và được xác nhận; tool/provenance/qualification uncertainty ghi rõ, không tự nhận pass |

## Review thực tế đã làm

- Đọc đủ Bible 40 mục; không sửa tài liệu gốc.
- Hai nhánh phân tích độc lập: gameplay/scope và runtime/art pipeline; đã cross-critique, tổng hợp và early sanity review.
- Final gameplay reviewer đọc 01+02: clean trong phạm vi story/gameplay/scope; không claim runtime persistence đã pass.
- Final technical reviewer đọc 01+02+03: phát hiện **một defect dependency quan trọng**: rig packets cần được sản xuất trước các consumer chapters, trong khi full-cast package ban đầu ở P11 quá muộn.
- Đã sửa: `R09` tạo canary rig/skin/minimal clips trước `R03`; `AS01–AS07` tạo accepted actor packets sau canary và trước P4/P5/P7/P8/P9/P10; consumers dùng package IDs rõ. `F02` trở thành completion/polish, không còn first rig producer. Integrator kiểm trực tiếp edit output và dependencies sau sửa; không yêu cầu một broad re-review mới.
- Native GLB không rebind theo custom procedural emitter; species/rigid attachment exceptions có explicit evidence contract, không fake plugin pass.

## Kiểm tra thực thi trên deliverables

Throwaway Python validation đã chạy thành công sau sửa:

```text
PASS: 85 unique implementation packages; P0–P13 in order;
30 distinct acceptance scenarios; 3 existing concept assets marked unapproved;
document local links and code fences valid.
```

Kiểm tra chữ ký binary WebP thành công cho cả ba file; đã xem trực tiếp ảnh. JSON concept manifest parse được và trỏ tới file tồn tại. Đây là kiểm tra tài liệu/file, không chứng minh đồ họa 3D hay game performance.

## Trạng thái implementation và phần chưa nghiệm thu — 2026-10-14

| Phạm vi | Status / nguồn đã đối chiếu |
|---|---|
| Bốn hero | **Implemented local:** Aren, Yara, Vesper, Sakda; entry-only selection, retry giữ hero, distinct kits/native candidates. `src/game/heroes.ts`, [combat.md — Heroes](../features/combat.md#playable-heroes-profiles-and-the-kit-seam). |
| Movement/resources | **Implemented local:** Space free-form jump/double jump/air-step (8 + 8 mana); F dodge 25 mana, không hai charge; cap 100, grounded input movement hồi 4 mana/mét. `src/game/combat/PlayerSkills.ts`, [combat.md](../features/combat.md). “Free” không phải zero mana. |
| Năm map Trials | **Implemented local:** Greenwake Ember Boar/Frost Sap-Stalker/Root Rammer; Canopy Thornback Howler/Storm Hornbill/Mire Viper; Grove Heartroot Sprig/Blighted Rootling/Hollowheart; Moonpine Frostfang Tracker/Howl Scout/Ruun; Mistveil Bog Lurker/Lantern Heron/Ghor. `CombatTrials.ts`, `GroveContent.ts`, `MoonpineContent.ts`, `MistveilContent.ts` trong `src/game/combat/`. |
| Local UI entry | **Implemented:** map intro với background load, region loading scene, skippable 4-second establishing shot; simulation paused, Reduced Motion bỏ sweep. [application.md](../features/application.md#map-intro-and-establishing-shot), [reference-ui.md](../features/reference-ui.md#map-intro-loading-scene-and-establishing-shot), `src/content/regionPresentation.ts`. |
| Physical reactions | **Đã chốt / đang triển khai Phase 1:** flinch/stagger/knockback/knockdown/launch/stun/getup, poise break và directional presentation; không claim đã QA chung cho mọi combatant. [Bible §15.8](../WILD-CROWN-GAME-DESIGN-BIBLE-CODEX-CLI.md#158-physical-reactions-và-poise--đã-chốt-phase-1-đang-triển-khai), [remediation Phase 1](../../.opencode/plans/2026-10-14-full-remediation.md). |
| Real chapters | **Planned integration Phases 2–3:** exploration/quests/dialogue/checkpoints/story boss/Cleanse→companion/Bond–Dominion/mid-chapter saves. Trials giữ riêng, không award campaign; Koro/Asha/Solkar/Orun thêm trên nền roster, story Ruun/Ghor vẫn giữ. Authored `src/content/story.ts` và chapter labels trong `src/app/StoryChapters.ts` chưa chứng minh campaign end-to-end. |
| Asset/audio production | **Approved work, chưa acceptance:** Tripo Acts I–IV ceiling khoảng 3,000 credits, inspect/log từng paid step; CC0/CC-BY audio với per-file source/license/author/SHA-256. [Remediation §User decisions/Phase 4](../../.opencode/plans/2026-10-14-full-remediation.md). |
| Release | **Blocked:** user duyệt asset acceptance list trước mọi `verified` flips; benchmark/reference hardware, gamepad/accessibility và native evidence/release gates vẫn phải đo/chạy thật. [release-validation.md](../features/release-validation.md), remediation Phase 5. |

## Readiness decision

**Local Trials có implementation và candidate evidence; full game/release chưa sẵn sàng.** Không dùng claim ngày 2026-09-30 “chưa code/build/run gameplay” làm status hôm nay; cũng không dùng build/test/candidate smoke để tuyên bố production asset acceptance. Các test counts/browser observations trong feature docs là evidence checkpoint của chúng, không phải checks mới chạy trong lượt docs sync này.

Concept Map/UI/Characters đã approved và player-facing content vẫn **English**; bản Bible tiếng Việt giữ engineering/story context. Các quyết định trước (direct Tripo GLB, desktop web, historical Dominion ending lock, stylized cinematic, phi sát thương/không gore và năm canon corrections) vẫn là baseline; design lock mới ngày 2026-10-14 được ghi tại [Bible §0.1/§38](../WILD-CROWN-GAME-DESIGN-BIBLE-CODEX-CLI.md) và [full remediation plan](../../.opencode/plans/2026-10-14-full-remediation.md).

Quyết định mới giữ bốn heroes, free jump, mana dodge và current monsters; thêm story bosses, làm real chapters và ưu tiên physical combat reactions. Gameplay/asset/audio work theo Phases 1–4; readiness gate theo Phase 5. Approval ngân sách không là quyền generation vô hạn hoặc tự cấp consent, và không thay thế list user approval cho từng accepted asset. Benchmark 60 FPS/8–12 giờ chưa được chứng minh trong status này.
