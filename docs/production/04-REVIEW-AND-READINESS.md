# Wild Crown — Review và trạng thái sẵn sàng

Ngày: 2026-09-30. Đây là review tài liệu planning, không phải QA pass cho game.

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

## Chưa thực hiện và không được diễn đạt như đã hoàn thành

- Chưa install/upgrade img2threejs 2.0.0/plugin toolchain trên máy.
- Chưa live-call Tripo, chưa có production GLB/rig/clip của Wild Crown.
- Chưa cấp Environment image consent hoặc Jev disclosure consent; chưa gọi TypeSafe.
- Chưa qualification vegetation/mixed-scene support, chưa bổ sung bốn rig measurement producers.
- Chưa code/build/run/deploy gameplay; chưa benchmark 60fps hoặc đo campaign 8–12h.
- Người dùng đã duyệt bộ concept hiện hành trong `visual-review/`. Multi-view consistency, topology/rig evidence và runtime performance vẫn là technical gates sau approval, không cần hỏi lại concept đã chốt.

## Readiness decision

**Concept Map / UI / Characters đã approved. Toàn bộ nội dung game chuyển sang English theo yêu cầu người dùng.** Giữ art/layout; cập nhật chữ trên curated plates/contact sheets và English copy sources. Tripo đã sẵn có/được phép dùng. Chưa bắt đầu gameplay implementation hay production model generation trong lượt này.

Các lựa chọn đã khóa: direct Tripo GLB, desktop web trước, historical Dominion ending lock; stylized cinematic; phi sát thương/không gore. Người dùng đã đồng ý năm correction: ba mảnh sau Asha, council đại diện Crown khi exile, provisional Koro trong slice, Call chuyển thành Ask/Signal, Chapter 7 coalition không tự cấp Living Pact.

Prerequisite còn lại: duyệt production reference cụ thể sau chỉnh sửa (không hỏi lại art direction), các canon clarification ngoài năm điểm đã duyệt nếu cần, rights/quota, exact toolchain, reference hardware, native-GLB evidence, vegetation qualification và workspace consents. Chưa có quyền cấp consent thay người dùng hoặc phát sinh batch generation không giới hạn.

Bước tiếp theo sau English cutover: D01–D06 và risk labs theo dependency đã đề xuất. Concept approval không được ghi nhầm thành rig/runtime pass. Dùng English copy catalog và narrative thay cho Vietnamese player-facing text trong tài liệu nguồn.
