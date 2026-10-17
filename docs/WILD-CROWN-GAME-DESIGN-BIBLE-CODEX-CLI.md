---
title: "WILD CROWN: THE BROKEN PACT"
subtitle: "Game Design & Story Bible — Codex CLI Planning Source"
version: "1.1"
language: "vi-VN"
status: "Local playtests implemented; full campaign and release acceptance pending — 2026-10-14"
project: "Wild Crown: The Broken Pact — standalone desktop web game"
document_owner: "Hoai-Nho Nguyen"
---

# WILD CROWN: THE BROKEN PACT
## Vương Miện Hoang Lâm: Khế Ước Tan Vỡ

> **Game Design Bible — đọc cùng code hiện hành và remediation plan.**
> Tài liệu này tổng hợp story, world building, gameplay loop, camera, movement, combat, hệ thống né skill, companion, boss, progression, technical architecture và phạm vi vertical slice đầu tiên.

---

# 0. Cách sử dụng tài liệu này

Tài liệu được viết để dùng theo ba mục đích:

1. Là **Game Design Bible** cho story và thiết kế đã được người dùng chốt.
2. Là nguồn để breakdown Epic, Feature, Task và Acceptance Criteria; các claim implementation phải đối chiếu code và feature docs.
3. Là phạm vi kiểm soát cho game desktop web độc lập, không tự mở rộng thành seamless open world.

Khi dùng với Codex CLI:

- Không yêu cầu Codex implement toàn bộ game trong một lần.
- Yêu cầu Codex đọc tài liệu, xác nhận phạm vi và tạo implementation plan theo từng milestone.
- Dùng [full remediation plan 2026-10-14](../.opencode/plans/2026-10-14-full-remediation.md) cho thứ tự triển khai hiện hành; The First Pact là gate trung gian, không thay thế full campaign.
- Tái dùng hệ thống đã có; không xây lại movement/combat chỉ vì prompt greybox lịch sử bên dưới.
- Toàn bộ game logic nên viết bằng TypeScript và tách khỏi rendering càng nhiều càng tốt.
- Mọi con số về timing, khoảng cách và cooldown trong tài liệu là baseline để playtest, không phải giá trị bất biến.

## 0.1. Design lock và trạng thái ngày 2026-10-14

**Quyết định người dùng:** giữ bốn hero **Aren, Yara, Vesper, Sakda**; giữ free jump bằng Space, double jump/air-step, dodge dùng mana và roster monster hiện tại. Thêm boss của Bible **trên nền roster đó**, không thay monster hiện có. Chapters phải là chapter thật; Trials là chế độ replay riêng. Nguồn quyết định và công việc còn lại: [full remediation plan](../.opencode/plans/2026-10-14-full-remediation.md), §User decisions và Phases 1–5.

Trong bản này:

| Nhãn | Ý nghĩa / bằng chứng hiện hành |
|---|---|
| **Đã implement — local playtest** | Năm map với native GLB candidates, bốn hero/kits, combat trials, jump/air-step, mana dodge và UI entry flow. Nguồn: [application.md](features/application.md), [combat.md](features/combat.md), `src/app/AssetPlaytests.ts`, `src/game/heroes.ts`. Không đồng nghĩa release-verified. |
| **Authored data / runtime nền** | Chapter, quest, dialogue, encounter và save systems đã có trong `src/content/story.ts`, `src/content/levels/`, `src/game/campaign/`, `src/game/storage/`. Có data không chứng minh đã chơi trọn campaign. |
| **Đã chốt — đang triển khai / planned** | Reaction system chung (Phase 1), real chapters + companion verbs (Phases 2–3), licensed audio (Phase 4), benchmark/accessibility/asset acceptance (Phase 5). Chưa claim hoàn thành hoặc nghiệm thu. |
| **Blocked — release acceptance** | Candidate GLB vẫn chưa được user duyệt danh sách acceptance và chưa được phép đổi `evidenceStatus` thành `verified`; benchmark/reference hardware và production gates phải có bằng chứng thật. Nguồn: plan §User decisions, [release-validation.md](features/release-validation.md). |

Các phần story/campaign §§7–11, companion/progression, The First Pact và milestone/prompt bên dưới là **thiết kế/acceptance target**, trừ claim được đánh dấu implemented và dẫn nguồn cụ thể. Mục tiêu 8–12 giờ, timing baseline và performance target không phải số đo đã đạt. Mọi copy hướng tới người chơi vẫn là **English**; headings/engineering notes tiếng Việt trong Bible được giữ.


---

# 1. Executive Summary

## 1.1. High concept

**Wild Crown: The Broken Pact** là game phiêu lưu hành động 3D theo cấu trúc semi-open world. Người chơi vào vai một Người Giữ Rừng trẻ tuổi có khả năng kết nối với động vật, đi qua nhiều khu vực để chấm dứt xung đột, thanh lọc các thủ lĩnh bị tha hóa và tập hợp chúng thành companion.

Điểm khác biệt cốt lõi:

- Người chơi không chỉ tiêu diệt boss, mà phải tìm nguyên nhân khiến chúng nổi loạn.
- Boss có thể trở thành companion sau khi được thanh lọc.
- Combat nhấn mạnh khả năng **đọc skill, né bằng nhào lộn, chuyển depth và phản công**.
- Companion không chỉ gây damage mà mở khóa traversal, tracking, scouting, stealth và command.
- Người chơi có thể thống nhất khu rừng bằng **Bond** hoặc **Dominion**.
- Cốt truyện đặt câu hỏi: một vị vua tốt là người khiến mọi sinh vật phục tùng, hay là người khiến chúng tự nguyện bước theo?

## 1.2. Thể loại

- Cinematic action adventure.
- Semi-open world.
- 3D gameplay với camera 2.5D/2.75D có điều khiển.
- Companion-based combat.
- Environmental exploration.
- Boss-centric progression.
- Narrative choice với ba kết thúc.

## 1.3. Trải nghiệm người chơi

Người chơi bắt đầu một mình. Sau mỗi vùng, một loài thú mới xuất hiện bên cạnh:

- Chim quan sát và cảnh báo.
- Khỉ tương tác với môi trường.
- Hổ phá giáp và bảo vệ.
- Sói theo dấu và bao vây.
- Báo phục kích và hỗ trợ stealth.
- Sư tử buff và chỉ huy.

Đến cuối game, người chơi không còn là một cá nhân đơn độc mà là trung tâm của một liên minh động vật. Tuy nhiên, sức mạnh cuối cùng phụ thuộc vào việc chúng đi theo vì tin tưởng hay vì bị ép buộc.

---

# 2. Phạm vi sản phẩm

## 2.1. Full-game vision

- 8–12 giờ cốt truyện chính.
- 1 hub trung tâm.
- 5 vùng lớn và 1 vùng cuối.
- 6 nhóm companion quan trọng.
- 5–6 boss chính.
- 10–15 side quest có thay đổi world state.
- 3 kết thúc.
- Backtracking có kiểm soát.
- Story và combat gắn trực tiếp với Bond/Dominion.

## 2.2. Vertical slice đầu tiên

Vertical slice không xây toàn bộ game. Nó chứng minh:

- Camera 2.75D.
- Movement 3D theo camera-relative input.
- Free jump bằng Space và double jump/air-step; contextual traversal là hệ thống bổ sung.
- Combat arena.
- Soft targeting.
- Dodge bằng animation nhào lộn.
- Perfect Dodge và counter.
- Bird scout.
- Monkey utility.
- Tiger boss.
- Cleanse boss thành companion.
- Environment restoration.
- One-way story từ Forest Entry đến The First Pact.

Thời lượng mục tiêu: **10–15 phút gameplay hoàn chỉnh**.

## 2.3. Non-goals của vertical slice

Chưa làm:

- Seamless open world.
- Multiplayer.
- Crafting phức tạp.
- Loot rarity.
- Inventory lớn.
- Full ecosystem simulation.
- Toàn bộ các vùng.
- Tất cả ending.
- Toàn bộ companion.
- Day/night system hoàn chỉnh.
- Free climbing.
- Mount system đầy đủ.
- Physics destruction quy mô lớn.

---

# 3. Bản sắc thiết kế

## 3.1. Bốn trụ cột

### Trụ cột 1 — Mỗi con vật thay đổi cách chơi

Companion phải mở ra hành động mới, không chỉ tăng damage.

### Trụ cột 2 — Mỗi cuộc nổi loạn có nguyên nhân

Không có boss đơn giản là “xấu”. Mỗi thủ lĩnh đều bị tác động bởi mất mát, đói, hiểu lầm, áp lực lãnh thổ hoặc Black Sap.

### Trụ cột 3 — Thế giới phản ứng với người chơi

Sau khi một khu vực được giải cứu:

- Màu sắc thay đổi.
- Động vật quay lại.
- Đường mới mở ra.
- Nhạc nền thay đổi.
- Corruption giảm.
- Hub phát triển.
- Companion có hành vi mới.

### Trụ cột 4 — Quyền lực có cái giá của nó

Bond chậm hơn nhưng bền vững. Dominion nhanh và mạnh nhưng làm companion dễ bị Hollow King chiếm quyền.

## 3.2. Nguyên tắc combat

- Mọi skill nguy hiểm phải có telegraph.
- Người chơi phải đọc được hướng và phạm vi.
- Mỗi skill lớn có ít nhất một kiểu né đúng.
- Không dùng một animation roll cho mọi tình huống.
- Né đúng tạo cơ hội phản công.
- Companion hỗ trợ nhưng không tự chơi thay người chơi.
- Boss không phải “bao máu”; mỗi phase thay đổi cách đọc arena.

## 3.3. Nguyên tắc camera

- Gameplay là 3D thật.
- Camera không tự do hoàn toàn.
- Camera được dàn dựng để bảo đảm silhouette, depth và readability.
- Không xoay camera trong lúc enemy đang telegraph skill.
- Không để foliage che chân, contact shadow hoặc điểm đáp.
- Cinematic camera ngắn, không phá quyền điều khiển.

---

# 4. Bối cảnh thế giới

## 4.1. Khu rừng Erya

Erya là một siêu rừng cổ đại gồm nhiều hệ sinh thái liên kết:

- Rừng nhiệt đới nhiều tầng.
- Thung lũng tre.
- Rừng thông và núi lạnh.
- Đầm lầy phủ sương.
- Đồng cỏ trung tâm.
- Hệ thống rễ và hang động dưới lòng đất.

Điều này cho phép khỉ, chim, hổ, sói, báo và sư tử tồn tại trong cùng một thế giới nhưng thuộc các lãnh thổ riêng.

## 4.2. Heartroot

Heartroot là cây cổ thụ khổng lồ có hệ thống rễ trải khắp Erya. Nó không điều khiển khu rừng mà kết nối:

- Nguồn nước.
- Chu kỳ sinh trưởng.
- Đường di cư.
- Ký ức bản năng.
- Năng lượng sinh thái.
- Mối liên hệ giữa các giống loài.

Heartroot là hệ thần kinh của toàn bộ khu rừng.

## 4.3. Sáu mảnh Heartroot

| Mảnh | Đại diện | Ý nghĩa |
|---|---|---|
| Sky | Chim | Tầm nhìn |
| Canopy | Khỉ | Sáng tạo và thích nghi |
| Fang | Hổ | Sức mạnh bảo hộ |
| Pack | Sói | Đoàn kết |
| Shadow | Báo | Bản năng và sự thật ẩn |
| Crown | Sư tử | Lãnh đạo |

Không một thủ lĩnh nào được sở hữu toàn bộ sức mạnh.

## 4.4. The Wild Pact

Khế Ước Hoang Dã được tạo ra để Người Giữ Rừng có thể:

- Cảm nhận động vật.
- Chia sẻ ký ức.
- Kêu gọi hỗ trợ.
- Hòa giải xung đột.
- Thanh lọc mất cân bằng.

Người Giữ Rừng là trung gian, không phải vua.

## 4.5. The Red Summer

Một mùa hạn kéo dài khiến:

- Sông cạn.
- Động vật ăn cỏ rời lãnh thổ.
- Thú săn mồi tranh giành con mồi.
- Các thủ lĩnh từ chối chia sẻ tài nguyên.
- Một cuộc chiến lớn nổ ra.

Người Giữ Rừng khi đó là **Orun**. Ông mất gia đình và nhiều sinh vật mình từng bảo vệ. Từ đó, Orun tin rằng tự do là nguyên nhân khiến khu rừng tự hủy.

## 4.6. Root Crown

Orun chế tạo Root Crown từ rễ Heartroot và sức mạnh của sáu mảnh. Ông muốn kết nối mọi ý chí thành một ý chí duy nhất để loại bỏ:

- Chiến tranh.
- Tranh chấp.
- Săn giết quá mức.
- Bất tuân.
- Mất cân bằng.

Người học việc của Orun, **Yara**, nhận ra Root Crown sẽ xóa bỏ tự do và cố gắng dừng nghi thức.

Nghi thức thất bại:

- Heartroot vỡ thành sáu mảnh.
- Orun bị kéo xuống hệ thống rễ.
- Sợ hãi và giận dữ của Orun hòa vào nhựa cây.
- Black Sap ra đời.
- Orun trở thành **The Hollow King**.

## 4.7. Black Sap

Black Sap không chỉ là độc tố vật lý. Nó khuếch đại:

- Sợ hãi.
- Giận dữ.
- Đói.
- Bản năng bảo vệ.
- Nỗi đau.
- Mong muốn kiểm soát.

Một con vật bị Black Sap không mất hoàn toàn bản chất. Nó bị cảm xúc cực đoan chi phối.

---

# 5. Nhân vật

## 5.0. Bốn playable heroes — roster hiện hành

**Đã implement trong local map entry.** Chọn hero trước khi vào map; hero không đổi giữa run, retry giữ lựa chọn. Cả bốn dùng chung player slot `aren`, nhưng kit, native render variant, vũ khí và VFX khác nhau; Yara NPC được bỏ khỏi scene khi chơi Yara. Nguồn: [application.md — Map progress and entry-only heroes](features/application.md#map-progress-and-entry-only-heroes), `src/game/heroes.ts`, `src/game/combat/HeroProfiles.ts`.

| Hero | Vai trò / vũ khí / element | Kit hiện hành | Dodge (F) | Vitality |
|---|---|---|---|---:|
| Aren — Warden of the Wild | Close-range striker; Warden glaive; arcane/lightning | Warden Blade → Crescent Wave; Heavy/Thunder Cleave; Sigil Bolt/Barrage; Root Tether/Cleanse; Warden’s Judgement | Dive | 120 |
| Yara — Heartroot Mage | Ranged spellcaster/controller; Heartroot staff; heartroot | Thornshot/Twin Thorns/Bloom Burst; Root Spike/Heartroot Eruption; Sap Lance/Seed Storm; Binding Vines/Cleanse; Heartroot Bloom | Petal Step | 85 |
| Vesper — Moonshade Blade | Samurai assassin; katana; umbral | Moonlit Iai/Crescent Rift; Shadow Step/Thousand Cuts; Kunai Fan/Shade Swap; Severing Shadow/Cleanse; Crimson Requiem; Death Mark + Backstab | Mist Blink | 80 |
| Sakda — Ember Fist | Muay Thai brawler; không vũ khí; ember | Eight Limbs; Tempest Stomp/Flying Knee; Echo Wave/Resonating Strike/Hundred Elbows; Iron Clinch/Cleanse; Tiger’s Wrath; Flurry | Guard Dash | 115 |

Chi tiết behavior/cost/cancel rules: [combat.md — Playable heroes](features/combat.md#playable-heroes-profiles-and-the-kit-seam); implementation: `PlayerArsenal.ts`, `HeartrootSkills.ts`, `kits/VesperKit.ts`, `kits/SakdaKit.ts` trong `src/game/combat/`. Bốn lựa chọn gameplay không xóa vai trò Aren trong truyện và Yara trong backstory; tích hợp chúng vào full chapter flow thuộc remediation Phases 2–3.

## 5.1. Aren — Warden của tuyến truyện chính, playable hero

**Aren** là một trong bốn hero authored hiện hành; không có character customization trong local selector (`src/game/heroes.ts`).

### Nguồn gốc

Aren được Yara tìm thấy gần một vùng Heartroot bị phá hủy. Aren không phải hậu duệ hoàng gia và không phải con cháu Orun. Heartroot chọn Aren vì Aren có khả năng nghe mà không áp đặt.

### Tính cách

Ban đầu Aren tin rằng:

- Kẻ gây rối phải bị đánh bại.
- Thủ lĩnh phải được tập hợp dưới một quyền lực.
- Thống nhất là giải pháp cho hỗn loạn.

Qua hành trình, Aren học được rằng:

- Trật tự không đồng nghĩa với công lý.
- Đồng thuận không có ý nghĩa nếu không thể từ chối.
- Sức mạnh lãnh đạo đến từ niềm tin chứ không chỉ mệnh lệnh.

### Năng lực

- Echo Sense.
- Wild Bond.
- Warden’s Call.
- Root Tether.
- Cleanse Pulse.
- Staff combat.
- Acrobatics.

### Warden glaive và Warden Staff trong truyện

**Hiện hành:** Aren chiến đấu bằng native Warden glaive (`prop-warden-glaive`), dùng Warden Blade, Heavy/Thunder Cleave, Sigil và Judgement; Root Tether/Cleanse vẫn là động từ cốt lõi. Nguồn: `src/game/heroes.ts`, [combat.md — Warden Arsenal](features/combat.md#warden-arsenal).

**Authored story:** Yara trao Warden Staff ở prologue (`src/content/story.ts`, objective `prologue:take-staff`). Không coi beat này là bằng chứng đã có vũ khí tự đổi giữa hai chiều dài. Staff Vault thuộc contextual traversal có affordance; không thay cho Space jump (§13.4).


## 5.2. Yara

Người học việc cuối cùng của Orun và người nuôi dưỡng Aren.

Vai trò:

- Mentor.
- Người giữ bí mật.
- Người có trách nhiệm trong sự ra đời của Root Crown.
- Nhân vật chuộc lỗi.

**Playable kit đã implement:** Heartroot mage dùng staff riêng, homing thorns, roots/lane attacks, Sap Lance, Seed Storm, Binding Vines, Cleanse và Heartroot Bloom; Petal Step là dodge dùng mana. Nguồn: §5.0 và [combat.md — Yara](features/combat.md#yara--heartroot-kit).

Câu nói cốt lõi:

> “A Warden does not tame the wild. A Warden listens until the wild chooses to answer.”

## 5.3. Vara — Chim scout

Loài gợi ý: harpy eagle stylized (Storm Harpy; canonical species `harpy-eagle`).

Vai trò gameplay:

- Đánh dấu enemy.
- Cảnh báo attack ngoài màn hình.
- Hiện điểm đáp của pounce.
- Phát hiện enemy ẩn.
- Scout camera tại điểm định trước.

Đại diện: tầm nhìn.

## 5.4. Koro — Thủ lĩnh khỉ

Tính cách:

- Thông minh.
- Đa nghi.
- Ghét thợ săn.
- Có xu hướng thử thách người lạ.

Vai trò gameplay:

- Kéo dây.
- Mở đường trên cao.
- Ném vật thể.
- Làm rơi vật thể.
- Đánh lạc hướng.
- Kích hoạt contextual traversal.

Đại diện: thích nghi.

## 5.5. Asha — Hổ mẹ

Là một trong các sinh vật mạnh nhất Erya.

Động cơ:

- Tali bị bắt.
- Bẫy Black Sap làm khuếch đại cơn giận.
- Asha không nhận ra đồng minh hay con của mình.

Vai trò gameplay:

- Pounce.
- Armor break.
- Roar.
- Phá vật cản.
- Chặn charge.
- Combat companion tuyến đầu.

Đại diện: sức mạnh dùng để bảo vệ.

## 5.6. Tali — Hổ con

Không phải companion chiến đấu. Tali sống trong hub, lớn dần và kết nối các loài thú.

Tali là biểu tượng cảm xúc của việc khu rừng được khôi phục.

## 5.7. Ruun — Thủ lĩnh sói cũ

Đại diện cho:

- Truyền thống.
- Kỷ luật.
- Trách nhiệm.
- Một thủ lĩnh giữ quyền quá lâu.

## 5.8. Luma — Thủ lĩnh sói trẻ

Đại diện cho:

- Thay đổi.
- Linh hoạt.
- Thích ứng.
- Xung đột giữa truyền thống và sinh tồn.

## 5.9. Sable — Sói companion

Vai trò gameplay:

- Tracking.
- Flank.
- Hold target.
- Cảnh báo phục kích.
- Phát hiện secret path.

## 5.10. Nyra — Báo đen

Bị hiểu lầm là kẻ giết chóc, nhưng thực chất đang tiêu diệt các sinh vật bị lây nhiễm trước khi dịch lan rộng.

Vai trò gameplay:

- Stealth.
- Rear attack.
- Ambush.
- Phát hiện kẻ địch ẩn.
- Mở đường bóng tối.
- Perfect Dodge counter support.

Đại diện: bản năng và sự thật bị che giấu.

## 5.11. Solkar — Vua sư tử

Không hoàn toàn bị Black Sap điều khiển. Solkar chủ động sử dụng nó để duy trì trật tự.

Dưới quyền Solkar:

- Không có chiến tranh.
- Nguồn nước được quản lý.
- Lãnh thổ được chia.
- Mọi đàn thú phải cống nạp.
- Kẻ bất tuân bị trục xuất.

Solkar là hình ảnh phản chiếu của Aren.

Câu nói:

> “You call it freedom because you have never had to bury a kingdom.”

## 5.12. Orun — The Hollow King

Orun không muốn phá hủy Erya. Ông muốn loại bỏ khả năng Erya tự hủy.

Niềm tin:

> “Choice is the oldest wound in this forest.”

Orun là phản diện bi kịch, không phải kẻ hủy diệt vô lý.

## 5.13. Marek — Thợ săn

Marek khai thác Black Sap để:

- Tạo bẫy.
- Điều khiển động vật.
- Bán năng lượng.
- Khai thác tài nguyên từ khu rừng đang suy yếu.

Marek có thể được cứu hoặc bỏ mặc. Nếu được cứu, hắn cung cấp thông tin về Heartroot Hollow.

## 5.14. Vesper — Moonshade Blade

Ronin từ Shadow clans vùng biên Erya, rời clan sau lệnh tấn công một ngôi làng từ chối Root Crown. Vesper đi cùng Aren và Yara vì họ hỏi các sinh vật đang chạy trốn điều gì, thay vì chỉ ra lệnh đánh gục chúng.

**Playable kit đã implement:** samurai assassin nhanh, vitality thấp; dùng katana, blink, backstab và Death Mark để tạo burst. Mist Blink là né dùng mana, không bỏ qua collider. Nguồn biography/kit: `src/game/heroes.ts`, [combat.md — Vesper](features/combat.md#vesper--moonshade-blade-kit-umbral).

## 5.15. Sakda — Ember Fist

Tu sĩ lang thang từ Ember temples, rời cloister khi Black Sap lan vào temple groves. Sakda không mang vũ khí: tay, khuỷu, gối và chân là tám điểm tiếp xúc của lối đánh Muay Thai.

**Playable kit đã implement:** brawler cận chiến; Flurry nối skill với Eight Limbs, Echo Wave đánh dấu để Resonating Strike tiếp cận, Flying Knee tạo áp lực và Guard Dash cho shield. Nguồn biography/kit: `src/game/heroes.ts`, [combat.md — Sakda](features/combat.md#sakda--ember-fist-kit-ember).

---

# 6. Quy tắc giao tiếp với động vật

Động vật không nói tiếng người theo cách thông thường.

Echo Sense truyền đạt:

- Hình ảnh.
- Mùi.
- Âm thanh.
- Cảm giác.
- Ý niệm ngắn.

Ví dụ khi Aren chạm vào Asha:

- Lồng sắt.
- Mùi tro.
- Tiếng Tali.
- Bẫy.
- Cơn giận.
- Một ý niệm: `CHILD — TAKEN — BURNING SCENT`.

Trong cảnh quan trọng, game có thể chuyển cảm giác thành câu ngắn, nhưng không biến động vật thành nhân vật nói chuyện dài như con người.

---

# 7. Cấu trúc cốt truyện

**Status:** các Act/Chapter bên dưới là tuyến truyện đã authored và mục tiêu full campaign, không phải mô tả năm map Trials đã hoàn thành campaign. `src/content/story.ts` giữ chapter/quest/required-beat data; `src/app/StoryChapters.ts` chỉ chiếu chapter labels vào selector.

**Trials hiện hành:** Greenwake → Canopy → Grove → Moonpine → Mistveil; đánh gục monster theo stage để mở gate, rồi đến waystone mới hoàn thành map. Unlock local lưu riêng, không ghi campaign saves/rewards/restoration. Ruun và Ghor trong Trials chưa chứng minh story settlement/companion ceremony đã chơi end-to-end.

**Real chapters đã chốt, planned (Phases 2–3):** exploration → quests/dialogue → checkpoint → story boss → Cleanse → companion → Bond/Dominion choice, với mid-chapter save/continue. Act I đi Prologue/Greenwake → Canopy/Koro → Blood Bamboo/Asha ba phase, Tali và hunter camp → Grove hub; Acts II–IV tiếp tục Moonpine, Mistveil, Sunmane, Fall of the Grove, return/coalition, Heartroot Hollow/Orun, ba endings và credits. Trials được giữ riêng cho replay. Blood Bamboo, Sunmane, Fall of the Grove, Living Pact và Heartroot Hollow hiện là **Coming Soon** trong local selector. Nguồn: [application.md — Local story-map playtests](features/application.md#local-story-map-playtests-greenwake-whispering-canopy-the-grove-moonpine-ridge-mistveil-basin), [remediation Phases 2–3](../.opencode/plans/2026-10-14-full-remediation.md).

# PROLOGUE — THE NIGHT OF A THOUSAND ROARS

## Opening cinematic

Giọng Yara:

> “Before beasts learned to fear mankind, the forest made a promise.”  
> “No claw would rule every trail.”  
> “No voice would speak for every creature.”  
> “And no crown would command the wild.”

Hình ảnh:

- Sáu thủ lĩnh quanh Heartroot.
- Người Giữ Rừng đặt quyền trượng.
- Orun đội Root Crown.
- Heartroot nứt.
- Black Sap phun ra.

## Hiện tại

Aren sống tại Greenwake ở rìa Erya.

Trong một đêm:

- Tất cả thú đồng loạt gầm.
- Chim rời tổ.
- Sói chạy khỏi núi.
- Động vật tràn qua khu dân cư.
- Vara rơi xuống trước Aren với một mảnh Heartroot.

Aren chạm mảnh vỡ và nhìn thấy:

- Root Crown.
- Sáu cặp mắt.
- Orun bị rễ cây bao phủ.
- Một cánh tay từ lòng đất.
- Ý niệm: `BRING THEM HOME`.

## Tutorial

Greenwake bị thú nhiễm Black Sap tràn qua.

Dạy:

- Camera-relative movement.
- Quick Step.
- Shoulder Roll.
- Cartwheel.
- Staff Vault.
- Root Tether.
- Cleanse một con lợn rừng.

Yara trao Warden Staff cho Aren.

> Yara: “The forest is not attacking us.”  
> Aren: “Then what are they running from?”  
> Yara: “Something beneath them has awakened.”

---

# ACT I — THE FOREST WITHOUT A VOICE

# CHAPTER 1 — WHISPERING CANOPY

## Bối cảnh

- Rừng nhiệt đới nhiều tầng.
- Cầu dây.
- Thác nước.
- Temple nhỏ.
- Tổ chim.
- Đường trên cao và dưới đất.

## Xung đột

Khỉ cướp thức ăn từ chim. Chim giữ hạt giống cuối cùng. Vườn cây đã chết vì dòng nước nhiễm Black Sap. Thợ săn đặt bẫy ở nguồn nước.

Không bên nào hoàn toàn sai.

## Main missions

### 1. The Fallen Scout

- Chữa trị Vara.
- Mở Bird Mark.
- Học cảnh báo attack ngoài màn hình.

### 2. Thief in the Branches

Koro cướp Heartroot fragment.

Chase sequence:

- Vault.
- Cartwheel tránh cành cây.
- Slide dưới rễ.
- Chuyển foreground/background.
- Dùng dây leo.

Koro đang kiểm tra Aren.

### 3. The Empty Orchard

Aren:

- Mở lại dòng nước.
- Giải cứu khỉ.
- Mang hạt giống từ chim.
- Phát hiện gai Black Sap trong vai Koro.

## Boss — Koro, Branchbreaker

Skill:

- Rock throw.
- Falling branch.
- Platform charge.
- Background-to-foreground leap.
- Horizontal log sweep.

Cách né:

- Quick Step.
- Low Slide.
- Cartwheel.
- Staff Vault.
- Bird Mark.

Kết thúc:

- Aren dùng Root Tether kéo gai Black Sap.
- Không giết Koro.
- Koro chia hạt giống với chim.
- Nhận Canopy fragment.
- Koro trở thành utility companion.

## World restoration

- Chim trở lại.
- Khỉ xây cầu.
- Vườn cây mọc lại.
- Mở tuyến về hub.

---

# CHAPTER 2 — BLOOD BAMBOO VALLEY

## Bối cảnh

- Thung lũng tre.
- Ánh sáng đỏ.
- Đền cổ.
- Trại săn.
- Lá tre dày.
- Tầm nhìn bị che có chủ đích.

## Xung đột

Asha liên tục tấn công vì Tali bị bắt. Bẫy Black Sap làm Asha mất khả năng phân biệt mục tiêu.

## Main missions

### 1. Tracks Without Blood

Theo dấu:

- Tre gãy.
- Bẫy bị nghiền.
- Lông Tali.
- Dấu chân.
- Mùi thợ săn.

### 2. The Ash Hunters

- Gặp Marek.
- Phá trại.
- Giải cứu Tali.
- Marek trốn với Black Sap sample.

### 3. A Mother’s Roar

Tali chạy về rừng tre. Asha xuất hiện nhưng không nhận ra con.

## Boss — Asha, The Broken Fang

### Phase 1: Stalking

Telegraph:

- Tre rung.
- Chim bay.
- Cỏ rạp.
- Bóng hổ.
- Audio positional cue.

Skill:

- Tiger Pounce.
- Claw Combo.
- Side Charge.

Dodge:

- Cartwheel khỏi Pounce.
- Quick Step → Back Handspring khỏi Claw Combo.
- Dive Roll sang depth khác khỏi Charge.

### Phase 2: Corruption Rage

Skill:

- Roar Cone.
- Black Sap Trail.
- Corrupted Pounce.
- Ground Corruption Wave.

Dodge:

- Chạy chéo → Cartwheel khỏi cone.
- Dive Roll khỏi Black Sap.
- Staff Vault qua wave.
- Vara đánh dấu điểm đáp.

### Phase 3: The Cub

Asha chuẩn bị lao vào Tali.

Người chơi:

1. Né Bamboo Charge.
2. Ra lệnh Koro làm rơi bó tre.
3. Root Tether.
4. Tiến lại gần.
5. Cleanse.
6. Tali tiếp cận Asha.

Kết thúc:

- Asha nhận ra Tali.
- Nhận Fang fragment.
- Asha trở thành combat companion.
- Tali chuyển về hub.

Orun nói:

> “Two have returned. Four remain.”

---

# HUB — THE GROVE

Hub phát triển theo cốt truyện.

Chức năng:

- Chọn companion.
- Nâng cấp.
- Tập luyện dodge.
- Xem ký ức.
- Nhận side quest.
- Quan sát quan hệ giữa động vật.

Trạng thái ban đầu:

- Một cây nhỏ.
- Hồ.
- Lều Yara.

Sau Koro/Asha:

- Platform do khỉ xây.
- Tổ chim.
- Hang Asha.
- Tali chơi trong hub.

---

# ACT II — WAR OF TEETH AND CLAWS

# CHAPTER 3 — MOONPINE RIDGE

## Bối cảnh

- Rừng thông.
- Núi lạnh.
- Sương.
- Hồ băng.
- Hang sói.
- Tàn tích đá.

## Xung đột

Ruun mất tích. Bầy sói chia thành:

- Phe truyền thống của Ruun.
- Phe thay đổi của Luma.

## Main missions

### 1. The Third Howl

Theo một tiếng hú ba nhịp phát ra từ dưới lòng đất.

### 2. Two Packs

Người chơi giúp một hoặc cả hai phe:

- Bảo vệ sói con.
- Tìm thức ăn.
- Cứu scout.
- Ngăn nội chiến.

### 3. The Alpha Below

Ruun bị trói dưới đền. Black Sap truyền qua tiếng hú đến cả đàn.

## Boss — Ruun, The Chained Howl

Skill:

- Pack Charge nhiều lane.
- Howl Shockwave.
- Flank Attack.
- Ice Break.
- Chain Pounce.

Dodge:

- Diagonal Dive Roll qua khoảng trống.
- Back Handspring khỏi Bite Combo.
- Staff Vault qua shockwave.
- Quick Step → Cartwheel khỏi hai nhịp.
- Asha phá formation.
- Koro xử lý chain.
- Vara đánh dấu Ruun thật.

## Lựa chọn

### Khôi phục Ruun

Bầy sói kỷ luật nhưng bảo thủ.

### Chọn Luma

Bầy sói linh hoạt, mạnh về scout.

### Dominion

Ép cả hai phục tùng. Mạnh trước mắt, dễ bị Orun chiếm quyền.

## Companion

Sable gia nhập. Nhận Pack fragment.

## Story reveal

Aren nhìn thấy Yara từng giúp Orun tạo Root Crown.

> Aren: “You knew him.”  
> Yara: “I knew the man he was.”  
> Aren: “That was not my question.”

---

# CHAPTER 4 — MISTVEIL BASIN

## Bối cảnh

- Đầm lầy.
- Sương dày.
- Tàn tích chìm.
- Cây rễ lớn.
- Động vật phát sáng.
- Dòng Black Sap.

## Xung đột

Nyra bị cho là kẻ giết thú. Thực tế, Nyra săn các sinh vật đã nhiễm Black Sap trước khi chúng lây bệnh.

## Main missions

### 1. Eyes in the Mist

Nyra theo dõi Aren.

Tín hiệu:

- Mắt trong sương.
- Bóng trên cây.
- Lá chuyển động.
- Dấu chân biến mất.

### 2. The Black River

Marek khai thác Black Sap.

> Marek: “You ask them to follow.”  
> “I have learned how to make them obey.”

Người chơi có thể thanh lọc Marek hoặc bỏ mặc hắn.

### 3. The Mire Maw

Nguồn ô nhiễm biến một con cá sấu khổng lồ thành boss.

## Boss — Ghor, The Mire Maw

Arena nửa đất, nửa nước.

Skill:

- Tail Sweep.
- Water Charge.
- Mud Eruption.
- Bite Lunge.
- Black River Wave.

Dodge:

- Staff Vault qua Tail Sweep thấp.
- Cartwheel khỏi Water Charge.
- Dive Roll khỏi Mud Eruption.
- Back Handspring khỏi Bite Lunge.
- Vara đánh dấu Ghor dưới nước.
- Nyra mở punish window.

## Kết thúc

- Thanh lọc dòng sông.
- Nhận Shadow fragment.
- Nyra gia nhập.
- Yara thú nhận đã giúp Orun.

> Yara: “I believed him.”  
> “By the time I understood what the Crown would take, it was already part of Heartroot.”

---

# ACT III — THE FALSE KING

# CHAPTER 5 — SUNMANE EXPANSE

## Bối cảnh

- Đồng cỏ.
- Cây thưa.
- Sông lớn.
- Vách đá.
- Đền đá.
- Đàn thú được quản lý nghiêm ngặt.

## Xung đột

Solkar đã tạo trật tự hoàn hảo bằng sợ hãi.

Dưới quyền Solkar:

- Không có chiến tranh.
- Mọi đàn thú có vị trí.
- Tài nguyên được phân phối.
- Loài ăn cỏ phải cống nạp.
- Kẻ bất tuân bị trục xuất.

## Main missions

### 1. The Silent Plains

Đồng cỏ yên bình bất thường. Động vật không tự do di chuyển.

### 2. Tribute of Teeth

Một đàn linh dương phải giao con non cho bầy sư tử.

### 3. The Lion’s Offer

Solkar đề nghị hợp tác.

> “You gather strength and call it friendship.”  
> “I gather obedience and call it peace.”

## Boss — Solkar, The Sunmane King

### Phase 1: Trial of Strength

Skill:

- Claw Sweep.
- Shoulder Charge.
- Leap Slam.
- Roar Cone.

Dodge:

- Back Handspring.
- Cartwheel.
- Dive Roll.
- Chạy chéo → Side Handspring.

### Phase 2: The King’s Army

Companion phối hợp:

- Vara đánh dấu commander.
- Koro phá signal.
- Sable giữ guard.
- Nyra rear attack.
- Asha đối đầu Solkar.

### Phase 3: Dominion Roar

Companion Bond thấp sẽ:

- Sợ hãi.
- Ngừng chiến đấu.
- Hoặc quay sang tấn công Aren.

## Lựa chọn

### Bond

Solkar tiếp tục lãnh đạo nhưng từ bỏ kiểm soát bằng sợ hãi.

### Exile

Solkar rời đi; các đàn thú lập hội đồng.

### Dominion

Aren ép Solkar phục tùng.

## Kết thúc

Nhận Crown fragment. Sáu mảnh hợp nhất quanh Aren.

Orun:

> “Thank you. You have returned my kingdom to one hand.”

---

# CHAPTER 6 — THE FALL OF THE GROVE

Aren trở về hub. Yara chuẩn bị nghi thức phong ấn.

Các mảnh không đi vào Heartroot mà đi vào dấu ấn trên tay Aren.

Aren chính là chìa khóa của Root Crown.

## Orun trở lại

Rễ cây phá mặt đất. Orun xuất hiện.

> “The Crown never needed a throne.”  
> “It needed a Warden.”

Orun sử dụng kết nối của Aren để chiếm quyền companion.

## Gameplay sequence

Người chơi phải bảo vệ, không giết:

- Né Asha Pounce.
- Né Wolf Pack Charge.
- Né Solkar Roar.
- Tránh Koro environmental attack.
- Cleanse Pulse tạm thời.
- Cứu Tali.
- Phá Black Sap pillar.

Bond cao giúp companion kháng Orun sớm hơn.

## Yara hy sinh

Yara cắt kết nối giữa Orun và Aren. Bà bị rễ cây bao phủ thành tượng gỗ sống.

Orun lấy Heartroot Core và biến mất.

The Grove sụp đổ.

Aren mất Warden’s Call.

## Điểm thấp nhất

Aren:

> “I cannot command you anymore.”

Vara vẫn ở lại. Koro, Asha, Sable, Nyra và các companion khác tự quay về.

Giọng Yara:

> “Then do not command them. Ask.”

---

# ACT IV — THE MARCH OF THE WILD

# CHAPTER 7 — THE LIVING PACT

Aren quay lại các vùng, không còn khả năng ép buộc. Mỗi giống loài phải tự nguyện tham gia.

## Whispering Canopy

Koro tập hợp đàn khỉ nếu vùng đã được khôi phục.

## Blood Bamboo Valley

Asha chỉ tham gia nếu Tali được bảo vệ.

## Moonpine Ridge

Lực lượng sói phụ thuộc lựa chọn Ruun/Luma/Dominion.

## Mistveil Basin

Nyra mở secret route. Marek hỗ trợ nếu được cứu.

## Sunmane Expanse

Solkar hoặc hội đồng đàn thú tham gia tùy lựa chọn.

## The Wild March

Aren đứng trước lối vào Heartroot Hollow.

- Chim bay thành đàn.
- Khỉ di chuyển trên rễ.
- Hổ đi đầu.
- Sói chạy hai bên.
- Báo ẩn trong bóng.
- Sư tử và thú đồng cỏ tiến đến.

Aren không đội vương miện và không ra lệnh. Các thủ lĩnh tự bước lên.

**The Living Pact** được hình thành.

---

# CHAPTER 8 — HEARTROOT HOLLOW

## Bối cảnh

- Rễ khổng lồ.
- Dòng Black Sap.
- Ký ức trên vách.
- Tàn tích Người Giữ Rừng.
- Đường thay đổi theo world state.

## Companion routes

- Vara và chim phá Black Sap Spire.
- Koro mở root gate.
- Asha, sói và sư tử giữ tuyến chính.
- Nyra dẫn Aren qua tuyến tối.

## Ký ức Orun

Aren thấy Orun từng là một Warden tốt. Ông mất mọi thứ trong Red Summer.

Orun:

> “I asked them to share. They chose hunger.”  
> “I asked them to stop. They chose blood.”  
> “Now I will remove the choice.”

Aren:

> “Then you will remove everything that makes their lives worth saving.”

---

# 8. Final Boss

# PHASE 1 — ORUN, THE LAST WARDEN

Orun sử dụng phiên bản méo mó của bộ kỹ năng Aren:

- Root Tether.
- Staff Combo.
- Cartwheel Counter.
- Back Handspring.
- Dive Roll.
- Ground Root Wave.
- Perfect Dodge.
- Companion suppression.

Người chơi phải tự đọc animation và chiến đấu.

Orun:

> “You survive because they protect you.”  
> “I survived because no one did.”

# PHASE 2 — THE CROWNED BEAST

Orun hợp nhất Heartroot thành thực thể mang sức mạnh sáu loài.

### Sky

- Shadow birds.
- Vara cảnh báo.

### Canopy

- Falling root.
- Koro tạo traversal.

### Fang

- Tiger Pounce.
- Asha chặn charge.

### Pack

- Wolf formation nhiều depth band.
- Sable xác định khe an toàn.

### Shadow

- Arena phủ sương.
- Nyra tìm core thật.

### Crown

- Dominion Roar.
- Solkar chống lại nếu Bond đủ cao.

# PHASE 3 — THE CHOICE OF THE CROWN

Orun chiếm quyền companion.

- Bond companion kháng lại.
- Dominion companion quay sang tấn công.

Mỗi companion có một moment hỗ trợ Aren tiến tới core.

Orun đưa Root Crown:

> “Command them. No cub will ever die alone again.”

Aren:

> “And none of them will ever choose who they protect.”

---

# 9. Kết thúc

## Ending 1 — Dominion: The Wild King

Aren nhận Root Crown.

- Xung đột chấm dứt.
- Mọi thú cúi đầu.
- Khu rừng im lặng.
- Chim không bay nếu chưa có lệnh.
- Bóng Aren giống Orun.

## Ending 2 — Severance: The Free Wild

Aren phá Root Crown.

- Sáu mảnh trở về các vùng.
- Erya không hoàn hảo.
- Thú vẫn săn và tranh chấp.
- Không ai có quyền điều khiển toàn bộ.
- Companion tự nguyện đi theo Aren.

## Ending 3 — The Living Pact

Điều kiện:

- Bond cao.
- Không Dominion thủ lĩnh.
- Khôi phục hệ sinh thái.
- Hoàn thành quest quan trọng.
- Tập hợp sáu thủ lĩnh.

Aren chia Root Crown thành sáu phần và lập Circle of the Wild.

- Orun từ bỏ quyền lực.
- Yara sống lại.
- Không có ngai.
- Sáu con đường dẫn tới sáu lãnh thổ.
- Các loài có quyền tham gia hoặc rời đi.

Câu cuối:

> Yara: “So, what will they call you now?”  
> Aren: “They do not need to call me anything.”

---

# 10. Core gameplay loop

```text
Explore Region
    ↓
Observe ecosystem conflict
    ↓
Use Echo Sense / Tracking / Companion utility
    ↓
Find the actual cause
    ↓
Enter combat arena
    ↓
Read skill telegraphs
    ↓
Dodge with correct acrobatic movement
    ↓
Counter and coordinate companion
    ↓
Break Ferocity
    ↓
Cleanse Corruption
    ↓
Make Bond/Dominion decision
    ↓
Restore region and unlock new ability
    ↓
Return to The Grove
```

---

# 11. World structure

## 11.1. Semi-open regions

Không dùng seamless open world ngay từ đầu.

Cấu trúc:

```text
The Grove
├── Whispering Canopy
│   ├── Monkey Route
│   ├── Waterfall Route
│   └── Hidden Nest
├── Blood Bamboo Valley
│   ├── Hunter Camp
│   ├── Tiger Den
│   └── Ancient Shrine
├── Moonpine Ridge
├── Mistveil Basin
├── Sunmane Expanse
└── Heartroot Hollow
```

Mỗi region:

- Load độc lập.
- Có nhiều camera rail.
- Có junction.
- Có secret.
- Có shortcut.
- Có backtracking bằng companion ability.
- Có combat arena dàn dựng.
- Có state `corrupted`, `partial`, `restored`.

## 11.2. Combat Ribbon

Exploration path được xem như `CombatRibbon`:

- Center spline.
- Width giới hạn.
- Camera rail.
- Traversal point.
- Arena junction.

Không phải lane cứng, nhưng có thể dùng ba depth band chiến thuật:

- Near/Foreground.
- Middle.
- Far/Background.

Mục đích:

- AI dễ bố trí.
- Pet không chồng nhau.
- Telegraph rõ.
- Camera giữ được đội hình.

---

# 12. Camera system

## 12.1. Hướng camera

- Góc ba phần tư.
- Hơi từ trên xuống.
- Không ngang tuyệt đối.
- Gameplay 3D thật.

Baseline:

- Horizontal angle: 35–50 độ so với hướng tuyến.
- Pitch: 15–25 độ.
- Distance: 8–11 m.
- FOV: 40–50 độ.

## 12.2. Camera modes

```ts
type CameraMode =
  | "exploration"
  | "combat"
  | "boss"
  | "traversal"
  | "cinematic"
  | "rest";
```

### Exploration

- Follow spline.
- Nhìn trước hướng chạy.
- Smooth damping.
- Chuyển rail tại junction.

### Combat

- Lock arena anchor.
- Zoom theo bounding group.
- Không xoay khi telegraph đang chạy.

### Boss

- Weight player + boss.
- Pet trọng số thấp.
- Zoom out khi AoE.
- Không orbit tự do.

### Cinematic

Chỉ dùng:

- Boss intro.
- Bond scene.
- Cleanse.
- World restoration.
- Wild March.
- Final choice.

## 12.3. Occlusion handling

- Fade foliage giữa camera và player.
- Foreground prop chuyển silhouette bán trong suốt.
- Enemy quan trọng có outline nhẹ khi bị che.
- Không để vật che contact shadow.
- Camera collision tránh xuyên tường.

---

# 13. Movement system

## 13.1. Camera-relative movement

Vector di chuyển được tạo từ:

- Camera right.
- Camera forward projected lên ground plane.

Người chơi cảm nhận:

- Trái/phải là theo màn hình.
- Lên là đi sâu.
- Xuống là tiến gần camera.

## 13.2. Exploration state — implemented

- WASD hoặc arrow keys; input camera-relative, diagonal normalized.
- Walk mặc định; giữ Shift để run, không tự tăng từ jog sang sprint theo thời gian giữ phím.
- Facing theo hướng locomotion; gait theo swept speed thực tế, không chỉ theo phím Shift.
- Space jump độc lập; E kích hoạt contextual traversal đúng affordance.

Nguồn: [combat.md — Movement controls](features/combat.md#aren-keyboard-movement-and-animation-controls), `src/game/combat/HeroProfiles.ts`, `src/game/combat/CombatEngine.ts`.

## 13.3. Combat state — implemented

- Movement không tự strafe hoặc giữ mặt về soft target; chạy vẫn dùng Shift khi đang có boss target.
- Dodge theo input movement hoặc facing cuối nếu đứng yên; không tự chọn đường né an toàn.
- Facing/target assist của từng attack theo kit; không biến locomotion thành hard lock.

Nguồn: [combat.md](features/combat.md), `src/game/combat/CombatEngine.ts`, `src/game/heroes.ts`.

## 13.4. Free jump, double jump/air-step và contextual traversal

**Đã implement:** Space là jump tự do theo input, không cần contextual anchor. “Free” là tự do kích hoạt, **không phải miễn mana**: jump tốn **8 mana**, Space lần hai khi airborne (hoặc queue trong anticipation) tốn thêm **8 mana** một lần để double jump/air-step. Steering còn hoạt động trong air; đứng yên nhảy tại chỗ. Native `aren-air-step` và VFX có style riêng cho bốn hero.

Simulation kiểm tra support, headroom, landing và capsule sweep; jump không xuyên solids hoặc sealed trial gates. E/Vault/Low Ledge/Slide/Swing là traversal có route metadata, tồn tại **song song**, không thay thế Space.

Nguồn: [combat.md — Movement controls và Contextual traversal](features/combat.md), `src/game/combat/PlayerSkills.ts` (`jump.manaCost`), `CombatEngine.ts` (`startPlayerJump`, boosted jump), `src/content/levels/act-i.ts`.

---

# 14. Wild Flow Evasion System

Đây là hệ thống trung tâm của combat.

## 14.1. Nguyên tắc

Mỗi đòn nguy hiểm:

1. Có body telegraph.
2. Có environment telegraph.
3. Có audio telegraph.
4. Có thời gian phản ứng công bằng.
5. Có ít nhất một kiểu né đúng.
6. Tạo punish window khi né chính xác.

## 14.2. Input

**Hiện hành:** F (Dodge binding mặc định) kết hợp movement direction; nếu đứng yên dùng facing cuối. Space dành riêng cho Jump. Có remap keyboard/gamepad; legacy Dodge=Space migrate sang F.

```text
F + Direction → Dive / Petal Step / Mist Blink / Guard Dash theo hero
Space → Jump; Space lần hai → Double jump / Air-step
```

Player quyết định hướng; trajectory được collision-check, không tự đổi sang đường escape khác. Các evasion profiles ở §14.3 vẫn là vocabulary authored cho explicit directional/contextual actions, không phải claim F tự đọc loại boss skill để chọn mọi animation.

Nguồn: [combat.md — Evasion and combat](features/combat.md#evasion-and-combat), `src/game/heroes.ts`, `src/game/combat/CombatEngine.ts`.

## 14.3. Các kiểu né

Các mô tả/timing baseline dưới đây là thiết kế Wild Flow; action IDs đã có trong `src/game/combat/evasion.ts`, nhưng native clip acceptance của đủ bộ vẫn là gate riêng. Default F và kit behavior hiện hành xem §14.2/§5.0.

### Quick Step

Dùng cho:

- Đạn nhỏ.
- Vuốt đơn.
- Reposition.

Baseline:

- 0.25–0.35 s.
- 1.2–1.8 m.

### Shoulder Roll

Dùng cho:

- Ground smash.
- Thoát vùng nguy hiểm.
- Đổi depth vừa phải.

Baseline:

- 0.4–0.55 s.
- 2–3 m.

### Cartwheel / Side Handspring

Dùng cho:

- Charge thẳng.
- Pounce.
- Line attack.
- Chuyển lane lớn.

Baseline:

- 0.45–0.6 s.
- 2.5–3.5 m.

### Back Handspring

Dùng cho:

- Claw combo.
- Bite.
- Roar cone gần.
- Giữ mặt về boss.

### Dive Roll

Dùng cho:

- AoE lớn.
- Multi-projectile.
- Corruption eruption.

Có recovery dài hơn.

### Low Slide

Dùng cho:

- Projectile hoặc sweep ở độ cao thân.
- Vật thể bay ngang.

Không dùng để né ground wave.

### Staff Vault

Dùng cho:

- Ground wave.
- Tail sweep thấp.
- Contextual obstacle.
- Special boss mechanic.

## 14.4. Mana thay cho dodge charges — implemented

- Mỗi dodge F tốn **25 mana** cho cả Dive, Petal Step, Mist Blink và Guard Dash.
- Mana cap **100**; grounded Walk/Run displacement có input hồi **4 mana/mét**. Idle, blocked motion, Dive và airborne Jump không hồi mana.
- Không còn hệ hai charge/recharge. Action readiness dùng funds, cooldown, recovery và state gates của engine; không đủ mana hoặc đang locked/cooling down thì không tạo dodge mới.
- Perfect Dodge dùng reward/window riêng; không hứa hoàn dodge charge hay mana.

| Shared slot | Cost hiện hành |
|---|---:|
| Jump / lần double jump | 8 / thêm 8 mana |
| Light combo | 0; riêng Aren Crescent Wave spawn tốn 10 mana |
| K tap / charged release | 12 / 20 mana |
| L tap / charged release | 15 / 35 mana |
| Q interrupt / Cleanse | 20 / 30 mana |
| U ultimate | 100 Instinct; không mana |
| F dodge | 25 mana |

Sakda Resonating Strike trên echo-mark là recast **không mana**; các hero passives không thay giá dodge. Nguồn: [combat.md — Mana và hero kits](features/combat.md), `src/game/combat/PlayerSkills.ts`, `kits/SakdaKit.ts`. Cost chỉ thu khi action hợp lệ/được chấp nhận; readiness không do renderer tự suy đoán.

## 14.5. Dodge phases

```text
Anticipation
→ Invulnerability
→ Landing
→ Recovery
```

Ví dụ Cartwheel:

```text
0.00–0.08s: anticipation
0.08–0.32s: invulnerable
0.32–0.46s: landing
0.46–0.55s: cancel/counter window
```

Mọi timing cần data-driven.

## 14.6. Perfect Dodge

Khi né sát hit frame:

- Slow motion 0.15–0.3 s.
- Instinct Meter tăng.
- Pet ability hồi nhanh.
- Enemy lộ điểm yếu.
- Recovery giảm.
- Cho phép counter animation.

Không dùng slow motion quá lâu.

## 14.7. Dodge counter

Ví dụ:

- Cartwheel → staff sweep.
- Back Handspring → Root Tether.
- Slide → low sweep.
- Dive Roll → thrust.
- Staff Vault → downward strike.

## 14.8. Hybrid root motion

- Animation quyết định body motion.
- Controller quyết định gameplay trajectory.
- Motion warping điều chỉnh điểm đáp.
- Capsule collision chặn xuyên vật thể.
- Foot IK sửa landing.
- Không dùng root motion cứng hoàn toàn.

## 14.9. MVP animation set

1. Quick Step Left.
2. Quick Step Right.
3. Forward Shoulder Roll.
4. Back Handspring.
5. Left Cartwheel.
6. Right Cartwheel.
7. Forward-left Dive Roll.
8. Forward-right Dive Roll.
9. Back-left Pivot Roll.
10. Back-right Pivot Roll.
11. Low Slide.
12. Staff Vault.
13. Perfect Dodge Left.
14. Perfect Dodge Right.
15. Dodge Recovery.
16. Hard Landing.
17. Stumble Recovery.

---

# 15. Combat system

## 15.1. Player actions

- J: Light combo theo hero.
- K tap / hold-release: Heavy / charged skill theo hero.
- L tap / hold-release: ranged / charged ranged skill theo hero.
- Q: interrupt ability trên windup hợp lệ hoặc Cleanse trên exposed corrupted target.
- U: ultimate khi đủ Instinct và điều kiện của kit.
- F: mana dodge; Space: jump/double jump.
- Companion command và E/contextual interaction.

Đã implement trong local playtest; labels/kit mapping xem §5.0, costs xem §14.4. Nguồn: `src/game/heroes.ts`, [combat.md](features/combat.md).

## 15.2. Light combo

**Hiện hành:** Aren có bốn bước Warden Blade; bước ba xoay quét, bước bốn phóng Crescent Wave nếu đủ mana. Yara có ba bước Thornshot → Twin Thorns → Bloom Burst; Vesper có bốn Moonlit Iai bước cuối Crescent Rift; Sakda có bốn Eight Limbs bước cuối roundhouse + ember ring.

Nguồn: `src/game/heroes.ts`, `src/game/combat/PlayerSkills.ts`, [combat.md — Warden Arsenal và hero kits](features/combat.md). Không dùng bộ “ba hit staff” cũ làm contract chung cho cả bốn hero.

Mục đích:

- Xử lý enemy nhỏ.
- Xây Instinct.
- Duy trì combo.
- Gây hit reaction.

## 15.3. Heavy attack

Dùng để:

- Break guard.
- Giảm Ferocity.
- Đẩy enemy.
- Phá object.
- Kết thúc combo.

## 15.4. Root Tether

Dùng để:

- Giữ enemy nhỏ.
- Kéo enemy nhẹ.
- Chặn pounce.
- Kết nối environment.
- Giữ boss trong cleanse window.

## 15.5. Ferocity và Corruption

Boss thú không dùng health bar đơn thuần.

### Ferocity

Khả năng tiếp tục chiến đấu.

### Corruption

Lõi Black Sap.

Flow:

```text
Damage/Stagger
→ Break Ferocity
→ Expose Corruption
→ Root Tether
→ Companion assist
→ Cleanse
```

Nếu bỏ lỡ, boss hồi một phần Ferocity.

## 15.6. Targeting

### Soft target

Ưu tiên theo:

1. Input direction.
2. Attack cone.
3. Distance.
4. Screen center.
5. Threat.
6. Pet mark.
7. Visibility.

### Attack magnetism

- Translation nhỏ.
- Không teleport.
- Không xuyên vật.
- Không tự đổi target trái input.

### Hard lock

Chỉ dùng với:

- Boss.
- Elite.
- Large charging enemy.

Camera không orbit theo kiểu Soulslike.

## 15.7. Hit detection

Dùng animation event windows:

```text
Anticipation
→ Hitbox Active
→ Follow-through
→ Cancel Window
→ Recovery
```

Không để weapon collider hoạt động liên tục.

## 15.8. Physical reactions và poise — đã chốt, Phase 1 đang triển khai

**Baseline trước cutover:** combat đã có hit-stop, flinch presentation, một số interrupt/stagger và swept wind push; riêng Sakda Tiger’s Wrath có knockback riêng. Đó chưa phải hệ reaction/poise chung cho mọi actor. Nguồn: [combat.md — Warden Arsenal và Sakda](features/combat.md), `src/game/combat/CombatEngine.ts`, `kits/SakdaKit.ts`.

**Target Phase 1:** simulation sở hữu `reaction`, thay `hitReact` bằng clean cutover; renderer/audio chỉ consume snapshot/cues, tuyệt đối không dịch actor hoặc quyết định stun bằng animation.

| Reaction | Behavior đã chốt để implement |
|---|---|
| Flinch | Light hit, không displacement, tối đa 12 world ticks. |
| Stagger | Ngắt windup không có armour, slide nhỏ. |
| Knockback | Eased push 0.8–4 m theo attack weight, swept against solids; wall impact kết thúc sớm và phát cue. |
| Knockdown → Getup | Knockback rồi nằm ít nhất 40 ticks, đứng dậy với brief i-frames. |
| Launch | Heavy finisher lên light enemies tạo vertical arc rồi knockdown. |
| Stun / poise break | Dazed 90–180 ticks theo size, không act, nhận bonus damage; boss có poise phases và stun ngắn hơn. |

Boss committed attack có super-armour, chỉ nhận flinch overlay; player có stagger/knockback/knockdown theo attack weight và hero weight class, getup i-frames và dodge-cancel sau delay ngắn. Snapshot contract: `kind`, world-XZ push `direction`, hit `side` (front/back/left/right), `strength`, `progress`, `durationTicks`, restart `serial`; hostile `poise` là normalized 0..1 buildup cho UI dưới HP.

Cues: `reaction-start`, `wall-impact`, `poise-break`, `getup`. Presentation target gồm directional hit clips, slide/tumble, knockdown/getup, stun loop/daze VFX và camera/hit-stop theo strength. Đây là **interface/design target**, không phải claim full simulation/rendering acceptance đã pass. Nguồn: [remediation Phase 1](../.opencode/plans/2026-10-14-full-remediation.md); fixed wave contract `local://wc-wave1.md` (engineering dispatch, không phải portable release evidence).

---

# 16. Enemy AI và encounter readability

## 16.1. Attack Token

Không cho mọi enemy đánh cùng lúc.

- 1–2 enemy có main attack token.
- Enemy khác reposition, taunt hoặc charge.
- Ranged token riêng.
- Boss chiếm nhiều token tùy phase.

## 16.2. Archetype

### Charger

- Hổ.
- Lợn rừng.
- Charge theo lane.

### Flanker

- Sói.
- Báo.
- Đổi foreground/background.

### Controller

- Rắn.
- Corruption creature.
- Tạo hazard.

### Ranged

- Poacher.
- Hostile bird.
- Background pressure.

### Heavy

- Gấu.
- Cá sấu.
- Chậm nhưng area lớn.

## 16.3. Quy tắc bắt buộc

1. Không attack ngoài màn hình nếu không báo trước.
2. Không xoay camera trong telegraph.
3. Tối đa 4–6 enemy hoạt động.
4. Chỉ 1–2 thú lớn.
5. Player và boss phải có contact shadow.
6. Foliage phải fade.
7. Pet không che camera quá lâu.
8. Zoom out trước AoE lớn.
9. Charge có lane/hướng rõ.
10. Player không bị animation lock vô lý.

## 16.4. Telegraph layers

### Body

- Vai hạ.
- Chân lùi.
- Hít sâu.
- Cào đất.

### Environment

- Cỏ rạp.
- Lá rung.
- Shadow marker.
- Black Sap glow.
- Dust trail.

### Audio

- Roar cue.
- Claw scrape.
- Wind-up.
- Directional warning.

## 16.5. Monster roster hiện hành — giữ lại cùng story bosses

**Đã implement trong local Trials.** Mỗi map có ba stage; defeat mở đúng gate, cuối route đến waystone mới Stage Complete. Thú bị đánh gục chuyển neutral/downed, không phải combat giết thú.

| Map | Roster theo thứ tự stage | Nguồn runtime đã đối chiếu |
|---|---|---|
| Greenwake | Ember Boar; Frost Sap-Stalker; Root Rammer | `src/game/combat/CombatTrials.ts` |
| Whispering Canopy | Thornback Howler; Storm Hornbill; Mire Viper | `src/game/combat/CombatTrials.ts` |
| The Grove | Heartroot Sprig; Blighted Rootling; Hollowheart, the Sapbound Guardian | `src/game/combat/GroveContent.ts`; [grove-playtest.md](features/grove-playtest.md) |
| Moonpine Ridge | Frostfang (runtime label **Frostfang Tracker**); Howl Scout; Ruun, the Chained Howl | `src/game/combat/MoonpineContent.ts` |
| Mistveil Basin | Bog Lurker; Lantern Heron; Ghor, the Mire Maw | `src/game/combat/MistveilContent.ts` |

“Boss” chip trên final Trial stage là difficulty role, không thay danh sách story bosses §19. **Planned chapters:** giữ roster này và thêm Koro/Asha/Solkar/Orun với story encounters; Ruun/Ghor đã có local candidate encounter nhưng vẫn cần chapter context, choices và acceptance của story version. Nguồn quyết định: [remediation §User decisions và Phases 2–3](../.opencode/plans/2026-10-14-full-remediation.md).

---

# 17. Companion system

## 17.1. Party composition

Khuyến nghị:

- 1 combat pet lớn.
- 1 utility pet.
- 1 aerial scout.

Vertical slice:

- Vara.
- Koro.
- Asha chỉ unlock ở cuối.

## 17.2. Command wheel

- Follow.
- Stay.
- Focus Target.
- Defend.
- Search.
- Distract.
- Special Ability.
- Recall.

## 17.3. Combat slots

Mỗi target có slot:

- Front.
- Left.
- Right.
- Rear.
- Far support.

Ví dụ:

- Player: front-left.
- Asha: side/rear.
- Koro: far.
- Vara: aerial.

## 17.4. Companion behavior

Tự động:

- Follow.
- Basic attack.
- Reposition.
- Tránh AoE lớn.
- Không đuổi khỏi arena.
- Return formation.

Người chơi điều khiển:

- Target priority.
- Special.
- Stay/Follow.
- Interaction.
- Recall.

## 17.5. Bond

Tăng khi:

- Cứu thành viên đàn.
- Khôi phục môi trường.
- Không ép thú bị thương.
- Dùng combo phù hợp.
- Hoàn thành side quest.
- Chọn giải pháp tôn trọng giống loài.

Bond mở:

- Skill.
- Animation.
- Counter.
- AI thông minh hơn.
- Khả năng chống Orun.
- True ending.

## 17.6. Dominion

Lợi ích:

- Skill mạnh sớm.
- Tuân lệnh tuyệt đối.
- Hoàn thành nhanh.

Cái giá:

- Bond thấp.
- Companion dễ bị chiếm quyền.
- Hub ít sinh động.
- Story dẫn về Wild King.

Dominion không được thiết kế như “nút ác”. Nó phải hấp dẫn về gameplay.

---

# 18. Companion abilities

| Companion | Exploration | Combat | Evasion support |
|---|---|---|---|
| Vara | Scout, mark path | Mark weakness | Cảnh báo off-screen, hiện landing |
| Koro | Rope, lever, item | Throw, drop object | Tạo dây, kéo khỏi AoE hiếm |
| Asha | Break obstacle | Pounce, armor break | Chặn charge |
| Sable | Track, secret | Flank, hold | Cảnh báo flank |
| Nyra | Hidden route | Ambush | Mở counter sau Perfect Dodge |
| Solkar | Calm wildlife | Roar, group buff | Ngắt AoE charge hiếm |

---

# 19. Boss design summary

**Sáu story bosses giữ nguyên:** Koro, Asha, Ruun, Ghor, Solkar, Orun. Encounter data đã authored (`src/game/combat/content.ts`); không đồng nghĩa đã có full campaign native scenes nghiệm thu. Ruun/Ghor có local Trials candidates (§16.5); Koro xuất hiện như ally/scenery không chứng minh Canopy boss fight. Asha ba phase và Orun finale phải được tích hợp vào real chapters. Phases 2–3 của [remediation plan](../.opencode/plans/2026-10-14-full-remediation.md) bổ sung boss assets/runtime **trên nền** monster roster, không thay Howler bằng Koro hoặc Root Rammer bằng Asha.

## Koro

Mục tiêu:

- Dạy depth.
- Dạy Bird Mark.
- Dạy contextual dodge.

## Asha

Mục tiêu:

- Chứng minh toàn bộ combat identity.
- Pounce.
- Charge.
- Roar.
- Ground Wave.
- Cleanse.
- Boss → companion.

## Ruun

Mục tiêu:

- Multi-lane formation.
- Companion coordination.
- Story choice.

## Ghor

Mục tiêu:

- Arena nửa đất nửa nước.
- Hidden boss.
- Environmental hazard.

## Solkar

Mục tiêu:

- Companion Bond check.
- Commander boss.
- Đối chiếu triết lý lãnh đạo.

## Orun

Mục tiêu:

- Mirror player mechanics.
- Kiểm tra dodge/counter.
- Gọi lại mechanic của toàn bộ game.

---

# 20. Side quests

## The Empty Nest

Khôi phục nhánh Heartroot. Tăng Bird warning.

## The Last Cub

Cứu hổ con. Ảnh hưởng Asha tham gia Wild March.

## A Pack Divided

Giúp sói trẻ và già cùng săn. Tăng hợp tác.

## The Silent Hunter

Giải quyết xung đột giữa Nyra và báo khác. Mở Ambush Counter.

## A King Without Subjects

Giúp Solkar hiểu khác biệt giữa obedience và trust.

## River of Black Sap

Chọn phá đập nhanh hoặc sửa hệ thống dẫn nước lâu hơn. Thay đổi địa hình.

## The Hunter’s Remorse

Nếu cứu Marek, hắn phá trại săn và hỗ trợ cuối game.

---

# 21. The Grove progression

## Stage 1

- Cây nhỏ.
- Hồ.
- Vara.
- Koro.

## Stage 2

- Hang Asha.
- Tali.
- Platform.

## Stage 3

- Hang sói.
- Training zone.
- Trail.

## Stage 4

- Nyra shadow area.
- Water system.
- Small wildlife.

## Stage 5

- Lion terrace.
- Đại diện các vùng.

## Stage 6

- Orun phá hủy.

## Ending states

- Wild King throne.
- Free sanctuary.
- Circle of the Wild.

---

# 22. Art direction

## 22.1. Phong cách

**Stylized cinematic 3D**

- Shape rõ.
- Silhouette mạnh.
- Texture vừa phải.
- Tỷ lệ thú tương đối thật.
- Lông được khối hóa.
- VFX rõ.
- Dễ render web.
- Không photorealistic quá mức.

## 22.2. Character constraints

Để hỗ trợ acrobatics:

- Không áo choàng dài.
- Không váy dài.
- Tóc không quá lưng.
- Áo khoác ngắn.
- Quần co giãn.
- Phụ kiện ít.
- Staff thu gọn.
- Rig tốt cho pelvis, spine, clavicle, wrist.

## 22.3. Environment readability

- Ground plane đọc được.
- Contact shadow rõ.
- Foliage không che chân.
- Arena có landmark.
- Depth band phân biệt bằng value, fog và composition.
- Telegraph không phụ thuộc màu duy nhất.

---

# 23. VFX direction

Core VFX:

- Black Sap.
- Heartroot glow.
- Root Tether.
- Cleanse burst.
- Bond pulse.
- Roar shockwave.
- Pounce landing.
- Ground wave.
- Perfect Dodge.
- Instinct Meter.
- Region restoration.

Quy tắc:

- VFX phải thể hiện gameplay range.
- Không che silhouette.
- Không dùng particle dày trong camera gần.
- VFX boss attack phải có anticipation, active và decay phase.

---

# 24. Audio direction

## 24.1. Combat cues

Mỗi skill lớn có cue riêng:

- Pounce.
- Roar.
- Charge.
- Ground Wave.
- Corruption eruption.

## 24.2. Companion cues

- Vara cảnh báo off-screen.
- Sable hú flank.
- Koro phát âm thanh khi có interaction.
- Asha gầm khi armor break available.

## 24.3. World restoration

Mỗi region từ corrupted sang restored sẽ thêm:

- Bird layers.
- Insect layers.
- Water clarity.
- Animal calls.
- Harmonic theme layer.

---

# 25. UI/UX

## 25.1. HUD tối thiểu

- Player vitality theo hero.
- Mana / maxMana, skill cost và readiness do engine cung cấp; không có dodge charges.
- Instinct Meter; ultimate theo hero.
- Companion ability.
- Boss Ferocity.
- Corruption state.
- Soft target ring.
- Off-screen warning.
- Trial roster/current monster HP, boss chip, stage/gate notices và destination; **implemented** trong local HUD (`src/app/AssetPlaytests.ts`, [reference-ui.md](features/reference-ui.md)).
- Poise buildup dưới hostile HP và reaction feedback: **Phase 1 target**, không claim đã nghiệm thu (§15.8).

## 25.2. Depth readability

- Contact shadow.
- Target ring.
- Ground VFX.
- Shadow marker.
- Foreground fade.
- Attack line.

## 25.3. Accessibility

Nên hỗ trợ:

- Telegraph intensity.
- Off-screen warning strength.
- Reduced camera shake.
- Reduced motion blur.
- High-contrast target ring.
- Auto-target assist.
- Wider Perfect Dodge window.
- Hold/toggle lock-on.
- Subtitle cho Echo Sense phrase.

## 25.4. Map intro → loading scene → establishing shot — implemented local flow

```text
Title / New Game → Map Select → Hero Select → Map Intro
→ Loading scene nếu world chưa ready → Establishing shot → Gameplay HUD
```

Map intro dùng intro beats/threat line/art/atmosphere của `src/content/regionPresentation.ts`; world bắt đầu load **phía sau intro**. Continue/Skip/Enter/Space/Esc rời intro; ready rồi thì reveal ngay, chưa ready thì loading scene tiếp quản. Load failure hiện error, không giả thành công.

Loading scene có phase/detail, progress từ work thật và lore theo progress; `null` là indeterminate, không timer giả. Establishing shot dài **4 giây**, camera sweep tới normal gameplay framing; simulation paused, gameplay input disabled, chỉ skip được. Reduced Motion/OS preference bỏ sweep; kết thúc shot mới hiện HUD và chạy simulation. Retry/Play Again không lặp map intro; production campaign giữ opening dialogue riêng.

Nguồn: [application.md — Forest preparation / Map intro](features/application.md#map-intro-and-establishing-shot), [reference-ui.md](features/reference-ui.md#map-intro-loading-scene-and-establishing-shot), `src/app/GameApplication.ts`, `src/content/regionPresentation.ts`. Implementation không phải production-browser/native-asset acceptance; status xem §0.1.

---

# 26. Technical architecture

## 26.1. Technology

- TypeScript.
- Three.js.
- Data-driven gameplay.
- Entity/component hoặc modular actor architecture.
- Kinematic character controller.
- Simple colliders.
- Animation state machine.
- Navmesh hoặc navigation graph theo region.
- Chunk/zone loading.

## 26.2. Core modules

```text
GameApp
SceneFlowManager
WorldStateManager
RegionLoader
PlayerController
PlayerCombatController
EvasionController
TraversalSystem
CameraDirector
CombatRibbonSystem
SoftTargetingSystem
HitDetectionSystem
AnimationStateMachine
CompanionController
CompanionSlotManager
EncounterDirector
EnemyBrain
BossPhaseController
TelegraphSystem
QuestSystem
DialogueVisionSystem
SaveSystem
AudioDirector
VFXDirector
DebugOverlay
```

## 26.3. Separation of concerns

### Simulation layer

- Position intent.
- State.
- Cooldown.
- Damage.
- AI.
- Quest.
- World state.

### Presentation layer

- Mesh.
- Animation.
- VFX.
- Audio.
- Camera.
- UI.

### Content data

- JSON/TS config.
- Attack profiles.
- Region config.
- Quest graph.
- Animation mapping.
- Spawn table.

## 26.4. Suggested repository structure

```text
src/
├── app/
│   ├── GameApp.ts
│   ├── GameLoop.ts
│   └── SceneFlowManager.ts
├── core/
│   ├── events/
│   ├── math/
│   ├── state/
│   └── time/
├── gameplay/
│   ├── player/
│   ├── combat/
│   ├── evasion/
│   ├── targeting/
│   ├── traversal/
│   ├── companions/
│   ├── enemies/
│   ├── bosses/
│   ├── quests/
│   └── world/
├── camera/
├── animation/
├── rendering/
├── audio/
├── vfx/
├── ui/
├── content/
│   ├── regions/
│   ├── actors/
│   ├── attacks/
│   ├── quests/
│   └── dialogue/
├── debug/
└── main.ts
```

## 26.5. Suggested state types

```ts
type RegionRestorationState =
  | "unvisited"
  | "corrupted"
  | "contested"
  | "restored";

type AlphaState =
  | "hostile"
  | "cleansed"
  | "bonded"
  | "dominated"
  | "exiled";

interface RegionState {
  id: string;
  restoration: RegionRestorationState;
  corruptionLevel: number;
  alphaState: AlphaState;
  unlockedRoutes: string[];
  completedQuestIds: string[];
  activeEventIds: string[];
}

interface CompanionState {
  id: string;
  species: string;
  bondLevel: number;
  dominionLevel: number;
  health: number;
  unlockedAbilities: string[];
  active: boolean;
  storyFlags: Record<string, boolean>;
}

interface WorldState {
  regions: Record<string, RegionState>;
  companions: Record<string, CompanionState>;
  alignment: number;
  heartrootFragments: string[];
  storyFlags: Record<string, boolean>;
}
```

## 26.6. Evasion profile

```ts
interface EvasionProfile {
  id: string;
  duration: number;
  travelDistance: number;
  invulnerabilityStart: number;
  invulnerabilityEnd: number;
  cancelWindowStart: number;
  cancelWindowEnd: number;
  canChain: boolean;
  chainCost: number;
  allowedDirectionMask: number;
  animationClip: string;
  counterActionId?: string;
}
```

## 26.7. Attack profile

```ts
interface AttackProfile {
  id: string;
  actorId: string;
  anticipation: number;
  activeStart: number;
  activeEnd: number;
  recovery: number;
  range: number;
  angle: number;
  damage: number;
  ferocityDamage: number;
  telegraphId: string;
  hitboxId: string;
  dodgeHint:
    | "step"
    | "roll"
    | "cartwheel"
    | "handspring"
    | "slide"
    | "vault";
}
```

## 26.8. Boss phase

```ts
interface BossPhaseDefinition {
  id: string;
  enterAtFerocityRatio: number;
  attackIds: string[];
  arenaModifierIds: string[];
  companionRules: string[];
  cinematicId?: string;
}
```

---

# 27. Performance strategy

## 27.1. Rendering

- `InstancedMesh` cho cây, tre, đá, cỏ.
- LOD cho foliage và creature.
- Frustum culling.
- Occlusion culling đơn giản theo zone.
- Shadow budget giới hạn.
- Baked hoặc semi-baked lighting nơi phù hợp.
- Giảm animation update cho actor xa.

## 27.2. AI

- Chỉ AI gần player chạy full update.
- Actor xa dùng low-frequency update.
- Event-driven encounter.
- Không simulate toàn ecosystem.
- Pool enemy và VFX.

## 27.3. Physics

- Capsule collider cho player.
- Primitive collider cho enemy.
- Không collider theo mesh chi tiết.
- Kinematic movement ưu tiên.
- Ragdoll chỉ nếu thật sự cần.

## 27.4. Companion

- Tối đa 2 pet mặt đất active.
- 1 aerial scout.
- Dùng slot manager.
- Recall nếu path fail.
- Teleport mềm ngoài camera khi bị kẹt quá lâu.

---

# 28. Vertical slice — The First Pact

**Planned curated story slice / acceptance target.** Năm map Trials hiện tại không thay thế flow Forest Entry → Asha Bond này. Tái dùng bốn hero/movement/mana combat đã có; chapter integration, boss assets và ceremony theo remediation Phases 2–3.

## 28.1. Flow

### Segment 1 — Forest Entry

- Camera rail.
- Movement.
- Foliage fade.
- Vara encounter.
- Basic dodge tutorial.

### Segment 2 — Monkey Chase

- Koro chase.
- Vault.
- Cartwheel.
- Slide.
- Depth movement.

### Segment 3 — Hunter Camp

- 2 melee enemy.
- 1 ranged enemy.
- Vara mark.
- Koro drop object.
- Dodge projectile bằng depth shift.

### Segment 4 — Tiger Tracking

- Tracks.
- Bamboo movement.
- Sound cue.
- No constant combat.
- Build tension.

### Segment 5 — Asha Boss

- Full evasion mechanics.
- Companion assist.
- Ferocity/Corruption.
- Cleanse.

### Segment 6 — The First Pact

- Bond cinematic.
- Asha companion reveal.
- Restored environment.
- Solkar silhouette teaser.

## 28.2. Vertical slice playable systems

Bắt buộc:

- Player locomotion.
- Combat locomotion.
- Space free jump và double jump/air-step.
- Soft target.
- Dodge selection.
- Perfect Dodge.
- Light/Heavy.
- Root Tether.
- Vara mark.
- Koro environment action.
- Asha boss.
- Cleanse.
- Region restoration.
- Save checkpoint.
- Debug overlay.

## 28.3. Vertical slice assets

### Character/creature

- Aren.
- Vara.
- Koro.
- Asha.
- Tali.
- 1 poacher melee.
- 1 poacher ranged.
- 1 small corrupted animal.

### Environment

- 4–6 tree variants.
- 3 bamboo variants.
- 4 rock variants.
- Ground/grass set.
- Wooden bridge.
- Cage.
- Hunter camp.
- Ancient gate.
- Root/ruin set.
- Waterfall/stream.
- Boss arena.

### VFX

- Black Sap.
- Bird Mark.
- Root Tether.
- Perfect Dodge.
- Cleanse.
- Roar.
- Pounce impact.
- Ground Wave.
- Restoration.

### Animation

Aren:

- Idle.
- Jog/run.
- Combat strafe.
- Aren Light 1–4; kit-specific chains của Yara/Vesper/Sakda (§5.0).
- Heavy.
- Charged heavy.
- Root Tether.
- Quick Step L/R.
- Shoulder Roll.
- Back Handspring.
- Cartwheel L/R.
- Diagonal Dive Roll.
- Staff Vault.
- Hit reactions.
- Stagger.
- Cleanse.
- Companion command.

Asha:

- Idle.
- Stalk.
- Walk/trot/run.
- Turn.
- Pounce.
- Claw combo.
- Roar.
- Charge.
- Corrupted idle.
- Hit reaction.
- Stagger.
- Cleanse reaction.
- Bonded idle/follow.

Koro:

- Ground locomotion.
- Tree locomotion.
- Throw.
- Pull.
- Climb.
- Drop object.
- Fear.
- Bond idle.

Vara:

- Fly.
- Glide.
- Turn.
- Dive.
- Mark.
- Land.
- Takeoff.
- Perch.

---

# 29. Milestone plan

Roadmap dưới đây là milestone/acceptance reference, không phải status report; kế hoạch thi công hiện hành là [full remediation plan 2026-10-14](../.opencode/plans/2026-10-14-full-remediation.md). Không dựng lại greybox hoặc charge system đã bị bỏ.

## Milestone 0 — Design lock

Deliverables:

- Chốt camera.
- Chốt movement.
- Chốt dodge types.
- Chốt Asha attack list.
- Chốt vertical slice map.
- Chốt asset budget.
- Chốt data schemas.

Acceptance:

- Không còn mâu thuẫn giữa open world và camera rail.
- Mọi boss skill có cách né rõ.
- Có blockout map trên giấy hoặc 3D.

## Milestone 1 — Greybox locomotion

Deliverables:

- Player capsule.
- Camera-relative movement.
- Camera rail.
- Combat arena.
- Occlusion fade.
- Contextual traversal stub.

Acceptance:

- Player đi được foreground/background.
- Camera không gây mất phương hướng.
- Không xuyên collider.
- Có debug view cho ribbon và arena.

## Milestone 2 — Evasion prototype

Deliverables:

- Dodge input.
- Quick Step.
- Roll.
- Cartwheel.
- Back Handspring.
- Staff Vault placeholder.
- Invulnerability window.
- Mana dodge và movement-earned mana (§14.4).
- Perfect Dodge.

Acceptance:

- Mỗi dodge data-driven.
- Có debug timeline.
- Không kẹt vào vật thể.
- Input queue hoạt động.
- Counter window hoạt động.

## Milestone 3 — Combat prototype

Deliverables:

- Light/Heavy.
- Hitbox event.
- Soft targeting.
- Ferocity.
- Root Tether.
- Enemy token.
- Telegraph.

Acceptance:

- Không đánh hụt vô lý ở depth gần.
- Không auto-target ngược input.
- Enemy attack công bằng.

## Milestone 4 — Companion prototype

Deliverables:

- Vara mark.
- Koro interaction.
- Companion follow.
- Slot manager.
- Command wheel tối thiểu.

Acceptance:

- Pet không chồng player.
- Pet không che camera quá lâu.
- Recall khi path fail.

## Milestone 5 — Asha boss greybox

Deliverables:

- Phase 1–3.
- Pounce.
- Claw.
- Charge.
- Roar.
- Ground Wave.
- Cleanse flow.

Acceptance:

- Mỗi skill có telegraph.
- Mỗi skill có dodge counter.
- Camera giữ player/boss.
- Phase transition không phá input.

## Milestone 6 — Environment and art pass

Deliverables:

- Forest.
- Bamboo.
- Camp.
- Boss arena.
- Character models.
- Companion models.
- VFX first pass.
- Lighting.

Acceptance:

- Silhouette rõ.
- 60 FPS target trên desktop reference hoặc profile đạt budget đã chốt.
- Không che player.

## Milestone 7 — Narrative and polish

Deliverables:

- Vision sequence.
- Dialogue.
- Tutorial.
- Bond cinematic.
- Restoration.
- Audio.
- UI.
- Checkpoint.

Acceptance:

- Vertical slice chơi từ đầu đến cuối.
- Không cần debug command.
- Player hiểu được mục tiêu và cách né.

## Milestone 8 — Showcase package

Deliverables:

- Gameplay build.
- Trailer capture.
- Readme.
- Technical breakdown.
- img2threejs case study.
- Performance profile.
- Social assets.

---

# 30. Epic backlog

## EPIC-CAMERA — Guided 3D camera

Features:

- Rail follow.
- Arena anchor.
- Boss framing.
- Occlusion fade.
- Transition.
- Debug spline.

## EPIC-MOVEMENT — Player movement

Features:

- Camera-relative input.
- Ground projection.
- Slope.
- Walk/Run theo input, facing theo locomotion.
- Free jump/double jump/air-step cùng contextual traversal.
- Collision recovery.

## EPIC-EVASION — Wild Flow Evasion

Features:

- Direction resolver.
- Dodge profiles.
- Mana cost/readiness, cooldown và grounded movement refill.
- I-frame.
- Chain dodge.
- Perfect Dodge.
- Counter.
- Motion warp.

## EPIC-COMBAT — Player combat

Features:

- Light/Heavy.
- Attack windows.
- Targeting.
- Ferocity.
- Root Tether.
- Cleanse.
- Shared physical reactions/poise (Phase 1, §15.8).

## EPIC-AI — Encounter AI

Features:

- Attack token.
- Archetype state.
- Telegraph.
- Arena boundary.
- Off-screen rules.

## EPIC-COMPANION — Companion framework

Features:

- Follow.
- Slot.
- Command.
- Ability.
- Recall.
- Bond.

## EPIC-BOSS-ASHA — Asha boss

Features:

- Stalk.
- Pounce.
- Combo.
- Charge.
- Roar.
- Corruption.
- Cleanse.

## EPIC-WORLD — Region state

Features:

- Checkpoint.
- Corruption.
- Restoration.
- Route unlock.
- Spawn update.

## EPIC-NARRATIVE — Story delivery

Features:

- Echo Sense.
- Vision.
- Dialogue.
- Cutscene state.
- Choice state.

## EPIC-TOOLS — Debug and tuning

Features:

- Attack timeline viewer.
- Dodge profile editor.
- Camera rail debug.
- AI token view.
- Arena bounds.
- Performance HUD.

---

# 31. Acceptance criteria mẫu

## Dodge

- Khi người chơi nhấn Dodge + trái trong combat, resolver chọn animation side phù hợp.
- I-frame chỉ active trong window config.
- Dodge không xuyên collider.
- Có thể queue counter trong cancel window.
- Nếu không đủ 25 mana hoặc còn cooldown/lock, input không tạo dodge mới; không trừ tiền cho rejected input.
- Perfect Dodge chỉ kích hoạt khi attack hit window giao với evasion window.

## Boss Pounce

- Có body, environment và audio telegraph.
- Vara có thể mark landing.
- Cartwheel hoặc side dodge tránh được khi timing đúng.
- Roll lùi không phải giải pháp an toàn mặc định.
- Boss không đổi hướng phi lý sau commit frame.

## Camera

- Không đổi góc giữa telegraph và hit frame.
- Player và boss luôn trong safe frame trừ mechanic có chủ đích.
- Foliage che player phải fade.
- Camera transition không đảo input bất ngờ.

## Companion

- Companion không chiếm slot của player.
- Không đứng giữa camera và player quá ngưỡng timeout.
- Không đuổi enemy ngoài arena.
- Có fallback recall khi pathfinding thất bại.

---

# 32. Rủi ro và giảm thiểu

## Rủi ro 1 — Scope quá lớn

Giảm thiểu:

- Vertical slice chỉ gồm Canopy + Bamboo.
- Chưa làm full open world.
- Data architecture mở rộng nhưng content giới hạn.

## Rủi ro 2 — Animation đẹp nhưng điều khiển chậm

Giảm thiểu:

- Hybrid root motion.
- Cancel window.
- Input queue.
- Data-driven timing.
- Playtest greybox trước art polish.

## Rủi ro 3 — Camera 2.5D làm depth khó đọc

Giảm thiểu:

- 3/4 camera.
- Contact shadow.
- Target ring.
- Ground VFX.
- Depth band composition.
- Occlusion fade.

## Rủi ro 4 — Pet bị kẹt hoặc che camera

Giảm thiểu:

- Slot manager.
- Simplified nav.
- Recall.
- Teleport ngoài camera.
- Party giới hạn.

## Rủi ro 5 — Boss attack không công bằng

Giảm thiểu:

- Commit frame.
- Telegraph rule.
- Attack token.
- Off-screen warning.
- Debug timeline.

## Rủi ro 6 — Web performance

Giảm thiểu:

- Instancing.
- LOD.
- AI throttling.
- Limited active enemies.
- Region loading.
- Simple collider.
- VFX pooling.

## Rủi ro 7 — Story quá dài cho showcase

Giảm thiểu:

- Story được truyền qua environment và Echo Sense.
- Vertical slice chỉ kể “The First Pact”.
- Full lore giữ trong Bible, không nhồi vào build.

---

# 33. Definition of Done cho vertical slice

Vertical slice được xem là hoàn thành khi:

- Người chơi có thể bắt đầu tại Forest Entry và kết thúc tại Bond scene với Asha.
- Không cần console command để hoàn thành.
- Camera hoạt động ổn định trong exploration và boss.
- Có ít nhất 6 kiểu né nhìn khác nhau.
- Asha có ít nhất 5 skill rõ ràng.
- Perfect Dodge tạo counter window.
- Vara và Koro có tác dụng thật.
- Boss dùng Ferocity/Corruption/Cleanse.
- Environment chuyển từ corrupted sang restored.
- Có checkpoint.
- Có UI tối thiểu.
- Có audio telegraph.
- Performance đạt budget đã chốt.
- Có thể quay trailer mà không cần dựng lại scene riêng.

---

# 34. Codex CLI — Master planning prompt

Prompt mẫu cho một bounded work package; không phải chỉ thị reset phạm vi về slice. Luôn đọc §0.1 và [remediation plan hiện hành](../.opencode/plans/2026-10-14-full-remediation.md) trước khi dùng.

```text
You are the lead gameplay architect for the Wild Crown showcase built with
Three.js and TypeScript.

Read the complete file:
WILD-CROWN-GAME-DESIGN-BIBLE-CODEX-CLI.md

Treat it as the source of truth. Do not implement the full game immediately.

Your task:

1. Inspect the current repository architecture and existing img2threejs showcase
   conventions.
2. Identify reusable systems, scene setup, asset loading, animation utilities,
   controls, camera helpers, VFX helpers, performance utilities, and coding
   conventions.
3. Compare current code and checked feature docs against the assigned acceptance
   criteria; distinguish local Trials, authored campaign data and release evidence.
4. Follow .opencode/plans/2026-10-14-full-remediation.md for the current full-game
   work; "The First Pact" remains an intermediate story-slice gate.
5. Break the work into:
   - milestones
   - epics
   - features
   - engineering tasks
   - asset dependencies
   - acceptance criteria
   - test cases
   - technical risks
6. Propose the module and folder structure before changing code.
7. Prioritize a greybox-first workflow:
   - camera and movement
   - evasion
   - combat
   - targeting
   - companion framework
   - Asha boss
   - environment
   - narrative and polish
8. Keep gameplay simulation separated from Three.js presentation.
9. Make attack timings, dodge timings, boss phases, telegraphs, and companion
   abilities data-driven.
10. Preserve the four heroes, Space jump/double jump, mana dodge and current map
    monsters; add story bosses alongside them. Do not add seamless open world,
    multiplayer, crafting, or other unapproved systems.
11. Do not start implementation until you have:
    - documented assumptions
    - identified blocking questions that cannot be resolved from the repository
    - produced the milestone plan
    - proposed acceptance criteria
12. When implementation begins, create one small, reviewable vertical slice
    milestone at a time. Every milestone must include:
    - code
    - debug visualization
    - tests or reproducible verification steps
    - performance considerations
    - a short changelog

Start by returning:

A. Repository findings
B. Reusable components
C. Missing systems
D. Recommended architecture
E. Milestone plan
F. First implementation task
G. Risks and assumptions
```

---

# 35. Codex CLI — Prompt cho milestone đầu tiên

Prompt greybox lịch sử cho isolated risk lab, không mô tả status game hiện hành. Không áp giới hạn “no combat” lên application/Trials đã implement; scope current work theo §0.1.

```text
Using WILD-CROWN-GAME-DESIGN-BIBLE-CODEX-CLI.md as the source of truth,
implement only Milestone 1: Greybox locomotion.

Requirements:

- Camera-relative movement in a real 3D space.
- Guided three-quarter camera following a configurable rail/spline.
- A CombatRibbon definition with center path, width, and arena transition.
- Player capsule collision and ground projection.
- Exploration and combat movement states.
- Foreground foliage occlusion fading using placeholder meshes.
- A debug overlay for:
  - camera rail
  - combat ribbon bounds
  - player velocity
  - current movement state
  - camera mode
- No combat, no boss, no companion AI yet.
- Keep simulation logic separate from rendering.
- Add configuration objects rather than hard-coded tuning values.
- Document how to run and verify the milestone.

Before editing code, inspect the repository and propose the exact files to add
or modify. Then implement in small reviewable commits or clearly separated
patches.
```

---

# 36. Codex CLI — Prompt cho Evasion prototype

Prompt verification/implementation mẫu; reuse mana/input/collision đã có, không quay lại dodge charges. Native placeholders trong isolated debug lab không đủ điều kiện production asset acceptance.

```text
Using the design bible as source of truth, implement Milestone 2:
Wild Flow Evasion prototype.

Scope:

- Dodge input plus movement direction.
- Data-driven EvasionProfile.
- Dodge costs 25 mana; cap 100 and supported Walk/Run earns 4 mana/metre.
- Engine-owned cooldown, recovery and funds readiness; no charge/recharge system.
- Quick Step left/right.
- Forward Shoulder Roll.
- Back Handspring.
- Cartwheel left/right.
- Diagonal Dive Roll.
- Staff Vault placeholder.
- Invulnerability windows.
- Chain dodge.
- Input buffering.
- Perfect Dodge event.
- Counter window.
- Hybrid root-motion approach.
- Collision-safe landing adjustment.
- Debug timeline and current evasion state.

Use placeholder animation clips or procedural debug poses if final assets are
not available. The gameplay contract must not depend on final animation files.

Add reproducible test scenarios for:

1. Dodge against a straight line attack.
2. Dodge against a delayed second hit.
3. Collision near arena walls.
4. Dodge funds/cooldown rejection, movement refill and no idle refill.
5. Perfect Dodge timing.
6. Counter input buffering.
```

---

# 37. Codex CLI — Prompt cho Asha boss

Story-boss integration target của Phase 2; native candidates chỉ được release sau asset acceptance. Greybox geometry trong isolated lab không thay thế required GLB khi vào production runtime.

```text
Implement the greybox Asha boss encounter from the design bible.

Required phases:

Phase 1:
- Stalking
- Tiger Pounce
- Claw Combo
- Side Charge

Phase 2:
- Roar Cone
- Black Sap Trail
- Corrupted Pounce
- Ground Corruption Wave

Phase 3:
- Bamboo Charge
- Koro environmental interruption
- Root Tether
- Cleanse sequence
- Tali reunion state

Requirements:

- Data-driven attack profiles and phase definitions.
- Body, environment, and audio telegraph hooks.
- Commit frames so attacks do not unfairly retarget after commitment.
- Correct dodge recommendations:
  - Pounce -> Cartwheel / side evasion
  - Claw Combo -> Quick Step then Back Handspring
  - Charge -> depth-changing Dive Roll
  - Roar Cone -> diagonal reposition plus Cartwheel
  - Ground Wave -> Staff Vault
- Ferocity and Corruption state.
- Vara landing marker integration.
- Koro interruption integration.
- Arena camera behavior.
- Debug controls to trigger each attack independently.
- Verification checklist and tuning notes.

Use placeholder geometry and animations where necessary. Do not block the
gameplay implementation on final art.
```

---

# 38. Các quyết định thiết kế đã khóa

1. Game là semi-open cinematic action adventure.
2. Gameplay là 3D thật.
3. Camera là guided 2.5D/2.75D, góc ba phần tư.
4. Không có camera orbit tự do trong vertical slice.
5. Space là free jump và double jump/air-step; mỗi lần accepted jump tốn 8 mana, không phải jump miễn phí.
6. Contextual traversal dùng E/affordance, tồn tại song song với jump tự do.
7. Né skill là core mechanic.
8. Có nhiều animation né, không chỉ roll.
9. Perfect Dodge dẫn đến counter.
10. Boss thú dùng Ferocity/Corruption/Cleanse.
11. Companion có utility riêng.
12. Party giới hạn để bảo đảm readability và performance.
13. Full-game story có Bond và Dominion.
14. Vertical slice đầu tiên tập trung Vara, Koro, Tali và Asha.
15. Code TypeScript + Three.js, data-driven, module hóa.
16. Greybox gameplay phải hoàn thành trước art polish.
17. Không mở rộng scope ngoài Bible nếu chưa có quyết định mới.
18. Bốn playable heroes: Aren, Yara, Vesper, Sakda; entry-only selection, không tự thêm customization.
19. Dodge dùng 25 mana, không hai charge; mana hồi từ grounded movement (§14.4).
20. Giữ monster roster của năm map (§16.5); thêm Bible story bosses trên nền roster, không thay thế.
21. Trials/replay tách campaign; chapters thật có exploration/quests/dialogue/checkpoints/story boss/Cleanse/companion/Bond–Dominion và mid-chapter saves.
22. Physical reactions/poise là ưu tiên Phase 1; simulation authoritative, presentation chỉ consume.
23. GLB candidates/automated gates không tự thành `verified`; user duyệt acceptance list trước release flips.

Nguồn decisions 18–23 và current work: [full remediation plan — User decisions, Phases 1–5](../.opencode/plans/2026-10-14-full-remediation.md). Costs/entry rules đã đối chiếu `src/game/combat/PlayerSkills.ts`, `src/app/GameApplication.ts` và [combat.md](features/combat.md).

---

# 39. Tóm tắt một câu

> **Wild Crown là game hành động 3D cinematic nơi người chơi đọc skill, né bằng nhào lộn, phối hợp cùng thú và quyết định thống nhất khu rừng bằng niềm tin hay sự phục tùng.**

---

# 40. Trailer copy

## Opening

> “On the night the Heartroot shattered, every creature in the forest cried out at once.”  
> “The birds abandoned the sky.”  
> “The wolves left the mountains.”  
> “And the great beasts turned against the land they once protected.”

## Middle

> “You were not chosen to rule them.”  
> “You were chosen to remind them why they once stood together.”

## End

> **“Will the wild follow you by trust… or kneel before your crown?”**
