# WILD CROWN — Review hiện trạng và Sprint Plan

Tài liệu này nối Game Design Bible (`WILD-CROWN-GAME-DESIGN-BIBLE-CODEX-CLI.md`) và Production Master Plan (`01-MASTER-PLAN.md`, phase P0–P13) thành các sprint có thể giao việc. Mỗi sprint có exit criteria đo được; không sprint nào được tuyên bố “full game hoàn thành” trước P11.

## 1. Review hiện trạng (Greenwake playtest, 2026-10-10)

Quan sát trực tiếp trong `?assetPlaytest=greenwake` (headless Chromium, Apple M1, 60 fps) và trong mã nguồn.

| Hạng mục | Hiện trạng | Nguyên nhân gốc | Hệ quả với người chơi |
|---|---|---|---|
| Cổng chặn | Cửa gỗ rộng 12 m đứng giữa nền rừng mở | `greenwake-canopy-floor` là mặt walkable 164×140 m phủ toàn region; cổng chỉ là một box hẹp | Đi vòng qua cổng, bỏ qua thử thách, “ải” không có ý nghĩa |
| Lối mòn | Dải nâu mờ rộng, mép nhoè | Trail atlas một lớp màu, không normal/ruts/edge | Không đọc được hướng đi; cảm giác bản đồ trống |
| Mặt đất | Mặt phẳng xanh một tông, cỏ sprite thưa | Không PBR texture, không height, không clutter | “Giả”, không nhập vai |
| VFX | Mote icosahedron, torus mỏng, trụ băng xám không chiếu sáng | Không post-processing/bloom, không particle system, không impact feedback | Đòn đánh không có “điểm nổ”, khó đọc khi trúng |
| Quái | Ba quái dùng chung mesh boar 1M vertex, chỉ tint màu | Rig quadruped không có clip; chuyển động là sine procedural trên vài xương | Quái đứng yên, không có tư thế tấn công, không tạo áp lực |
| Aren | Chỉ có idle/walk/run/jump/dive/cheer/defeat | Staff/Heavy/Root Tether/hit reaction không có clip; fade 0.12 s; clip đi ra bị đóng băng khi fade | Bấm J/K/Q bị gãy pose; chuyển run↔dive giật |
| Áp lực | Cadence tăng dần đã có | Quái không di chuyển, không lunge/roar, không combo | Né dễ, nhàm |

Điểm mạnh giữ lại: simulation fixed-step tách presentation, mana/skill HUD, ba dodge trial có điều kiện “né đủ thời gian + ≥3 cast”, damage numbers, afterimage Run/Dive, camera khoá trung tâm.

## 2. Nhịp sprint và quy tắc chung

- Mỗi sprint là một increment chơi được trên cùng runtime; kết thúc bằng browser playtest thật + test tự động cho invariant không chắc chắn.
- Asset Tripo: concept → model (v3.1, `geometry_quality=detailed`, `texture_quality=extreme`, PBR) → decimate có bake (≤20k tri cho creature) → rig → retarget preset. Mọi task ID và hash được ghi vào `asset-source/generated/**/result.json` và `greenwake-sprint1-tripo-log.jsonl`.
- Simulation sở hữu va chạm, hit window, trạng thái thế giới. VFX/animation không trao thưởng hay đổi lịch sử nhiệm vụ.

## 3. Sprint backlog

### Sprint 1 — Greenwake Feel & Pressure (P2/P3 polish) — đã bàn giao (local playtest, 2026-10-10)

Mục tiêu: chặng Greenwake chơi “thật”: lối đi kín, ải bắt buộc, mặt đất PBR, VFX có điểm nổ, quái có model/rig/animation riêng và gây áp lực, Aren chuyển động liền mạch.

| ID | Hạng mục | Exit criteria |
|---|---|---|
| S1-GATE | Route kín + cổng ải | Bỏ walkable toàn vùng; walk-mesh chỉ gồm lối đi + đấu trường. Mỗi cổng phủ toàn bộ mặt cắt walkable, cao ≥ 4 m. Test brute-force Walk/Run/Dive/Jump theo 16 hướng từ mọi vùng trước cổng không vượt được mặt phẳng cổng khi cổng đóng; mở sau khi đạt điều kiện. Cổng có seal VFX và phản hồi khi chạm. |
| S1-TRAIL | Lối mòn rõ | Lõi đất nén có vệt bánh xe/dấu chân, mép sỏi/đá, chuyển tiếp cỏ→đất bằng noise, đá viền và đèn dẫn đường theo ribbon. |
| S1-GROUND | Mặt đất thật | Terrain hình học có độ nhấp nhô ngoài lối đi; splat PBR (albedo/normal/roughness CC0 Poly Haven) chống lặp; cỏ GPU instanced có gió; clutter (sỏi, cành, lá, nấm, dương xỉ); ranh giới rừng dày (cây, đá, bụi gai Tripo) để không có “tường vô hình”. ≥ 55 fps tại 1440×900 trên M1. |
| S1-VFX | VFX “nổ” | Bloom HDR + ACES; particle engine GPU; bộ kit lửa/băng/độc/gió/đất theo ba pha anticipation→active→decay phủ đúng vùng ảnh hưởng (không viền); shockwave, decal cháy/băng/nứt, debris, flash + camera shake khi trúng/nổ; VFX skill của Aren (staff trail, heavy slam, tether, dive dust). |
| S1-MONSTER | Quái Tripo + animation | Ember Boar, Frost Sap-Stalker, Root Rammer: model riêng (Tripo Ultra), rig quadruped, clip idle/walk/run/slash/shoot/jump/hurt/turn/dive; mỗi skill có animation riêng theo pha; quái di chuyển, lunge, giữ khoảng cách, roar; aura nguyên tố theo nhân vật. |
| S1-ANIM | Aren liền mạch | Clip combat Tripo (slash, box, kick, chop, cast, hurt, hit, flip) retarget world-space lên skeleton Aren; fade theo loại chuyển tiếp; clip đi ra tiếp tục chạy khi fade; recovery blend không gap; không còn bind-pose khi bấm J/K/Q. |

**Kết quả đo được (worktree `task-62-dialogue-lines`, `?assetPlaytest=greenwake`, 1440×900, DPR 1, Apple M1):**

- S1-GATE: `greenwake-canopy-floor` bị xoá; route kín với 3 cổng ở chokepoint thật (ramp z = 11, corridor 3 z = 34, corridor 5 x = 57) và 2 arena pocket. `tests/combat/greenwake-sealed-route.test.ts` (flood fill 0,5 m + >1000 lượt Run/Dive/Jump của engine thật) chứng minh không vượt được cổng đóng. Browser: Run/Dive/Jump dừng ở z ≈ 9,97 trước cổng 1; thông báo "Sealed by Ember Boar — survive Ns more and avoid N more casts"; cổng mở 1,2 s (seal tan, tường rễ lún, burst + rung camera).
- S1-TRAIL / S1-GROUND: terrain 1 m (lưới mịn 0,25 m quanh mép walk-mesh) có berm + dải dương xỉ dọc mép; splat PBR 4 lớp CC0 Poly Haven (9,6 MB); vệt bánh xe/dấu chân trên lõi lối mòn; cỏ GPU stream 12 tile; clutter 8 156 instance; boundary 65 prop (bụi gai, cụm đá, cây).
- S1-VFX: PostFX HDR (bloom + ACES, MSAA ×2, sanitize NaN/Inf), GPU particles 2 draw call, bộ kit theo nguyên tố ba pha, fill mặt đất hữu cơ không viền, rim flash có màu, rung camera, VFX skill của Aren. 3 lượt quan sát 40–45 s với từng quái: 0 khung hình đen (độ sáng 62–76/255).
- S1-MONSTER: 3 model Tripo v3.1 Ultra + texture extreme → decimate ≈ 25–28k tri → rig quadruped v2.5 → walk preset; 9 clip còn lại tác giả offline (`author-quadruped-clips.mjs`) vì rig quadruped của Tripo chỉ hỗ trợ walk. AI: giữ khoảng cách, vòng quanh, charge chạy thật theo lane, lunge, roar, chain attack từ tier 1.
- S1-ANIM: 10 clip combat Tripo retarget world-space lên skin 65 xương; không còn issue missing-clip khi bấm J/K/Q; run → dive → run và run → jump → run liên tục trên khung hình 50 ms.
- Hiệu năng: 54,6–57,8 fps tại 5 điểm dọc route (trước berm: 113 draw call, ≈ 1,33 M tri/khung). Test: 878 Bun + 85 Node pass, `tsc` sạch.
- Tripo: 930 credit (số dư 147 505 → 146 575); mọi task ID nằm trong `result.json` từng bước và `greenwake-sprint1-tripo-log.jsonl`.

**Giới hạn còn lại (chuyển sang Sprint 2+):** clip né 17 kiểu của Bible vẫn dùng dive/flip chung; audio chưa được làm lại cho VFX mới; texture/asset Greenwake mới chỉ phục vụ dev server (production build cần copy vào `public/` và qua release gate); chất lượng deformation của rig quadruped chưa được review production.

### Sprint 1.5 — Warden Arsenal — đã bàn giao (local playtest, 2026-10-11)

Mục tiêu (yêu cầu sau Sprint 1): Aren có thêm skill, trong đó có skill bắn xa; combo J đặc sắc hơn; VFX đẹp, chân thật kiểu AAA theo video tham chiếu; animation Tripo khi thiếu.

| ID | Hạng mục | Kết quả |
|---|---|---|
| S15-BLADE | Warden Blade (J) | Combo 4 bước có cửa sổ nối; bước 3 xoay 360°; bước 4 bắn Crescent Wave xuyên mục tiêu (10 mana). |
| S15-SIGIL | Sigil Bolt / Barrage (L) | Chạm: sigil + bolt tự dẫn (15 mana), dừng ở collider và cổng ải đóng. Giữ ≥ 30 tick rồi thả: 3 bolt (35 mana). |
| S15-THUNDER | Thunder Cleave (giữ K) | Charged Heavy + sét đánh 8 tick sau hit (18 dmg, bán kính 3 m); khi giữ: sét tụ vào lưỡi, hồ quang bò trên người Aren, burst báo "đã sạc" ở ngưỡng `THUNDER_CLEAVE.holdTicks`. |
| S15-JUDGE | Warden's Judgement (U) | Cần 100 Instinct: lướt bất tử 8 m, đặt 5 dấu X nổ tuần tự. |
| S15-FEEL | Cảm giác đòn | Hit-stop theo tick (serialize, không tốn ngân sách Perfect Dodge), monster flinch, camera punch-in, screen impulse, HUD 7 ô. |
| S15-ASSET | Vũ khí + clip | Glaive Tripo (concept → model → decimate, 12 939 đỉnh, 2,1 MB) gắn vào tay Aren với socket `weapon-base/tip`; batch retarget anim-c (shoot, box_01, box_03, front_kick_01, jump_down) → light-4, sigil-bolt/charge/barrage, judgement. |

**Bằng chứng trình duyệt (coordinator, 2026-10-11, `?assetPlaytest=greenwake`, 1440×900):** J×4 chạy light-1 → 4, Crescent Wave trừ 100 → 90 mana. Bolt −15 mana, trúng 14. Barrage giữ 0,75 s, −35 mana, 3 phát × 12. Thunder Cleave giữ 1 s, −20 mana, 36 + 18 sát thương, hit-stop ≈ 0,18 s. Judgement: Instinct 100 → 0, 5 dấu, 4 lần nổ × 12 lên Ember Boar. Bolt bắn vào cổng 1 đang đóng biến mất ở tick kế tiếp (z 9,97).

**Sửa trong lượt review này:** thêm hiệu ứng tụ điện khi giữ K (trước đó không có phản hồi hình ảnh); sigil không còn cháy trắng (giới hạn HDR giữ màu 1,8, mờ khi nhìn gần mép, flare chỉ sáng nét vẽ; 3 sigil của Barrage nhỏ và mờ): số pixel bão hoà quanh Aren khi Barrage giảm 3 512 → 1 906; billboard lớn (halo, vòng, khói) được kéo về phía camera nên không còn bị mặt đất cắt thành đường thẳng; khôi phục mặc định PostFX MSAA ×2 và pixel ratio 1 (lượt Sprint 1.5 vô tình đưa về ×4 / 1,5); bỏ assert thời gian thực khỏi test brute-force cổng (không tất định, fail khi máy bận).

- Test: 996 Bun + 95 Node pass, `tsc` sạch.
- Hiệu năng: **chưa đo lại được**. GPU đang bị một trình duyệt headless khác dùng 85–90 % (`ioreg` Device Utilization khi tab game đã tắt); trong điều kiện đó game đạt 28–35 fps, CPU chính rảnh ~82 %. Con số 55–58 fps của Sprint 1 cần đo lại trên GPU rảnh.
- Tripo: 165 credit (146 575 → 146 410): glaive 115, anim-c 50; task ID trong `greenwake-sprint1-tripo-log.jsonl`.

**Giới hạn còn lại:** số sát thương chồng lên nhau khi nhiều đòn trúng cùng chỗ (Judgement); quả cầu sáng ở điểm bắn Barrage vẫn khá gắt; clip né 17 kiểu vẫn thuộc Sprint 2.

### Sprint 1.6 — Greenwake địa hình thật + Map 2 Whispering Canopy — đã bàn giao (local playtest, 2026-10-11)

Yêu cầu: bỏ các đoạn đường "tấm ván phẳng" ở Greenwake, thay bằng địa hình thật và dùng cầu để nối; sau đó tạo thêm map khác với quái vật mới.

**Greenwake (`?assetPlaytest=greenwake`):**
- Dốc gốc cây, đỉnh sống đất (ridge) và dốc xuống cổng rừng giờ là chính địa hình (terrain-backed): đúng độ cao đi được, mép bo tròn, sườn đất/đá tự nhiên; không còn slab ván, viền gỗ hay mặt phẳng nổi.
- Một khe suối (gully) có nước chảy cắt ngang giữa sống đất và dốc cổng; cầu dây (`prop-greenwake-rope-bridge`) được chuyển tới bắc qua khe, sàn cầu là walk surface `greenwake-gully-bridge` (lan can thành collider). 16 cụm đá trang trí dọc vách và bờ suối.
- Lối mòn chỉ vẽ theo tuyến đi (bo cong ở góc, bề rộng thay đổi, sỏi rải ngẫu nhiên); phần walkable rộng còn lại là cỏ/rêu tự nhiên. Nước được vẽ trước các prop mờ dần nên không còn đè lên cầu.
- Dọn chồng lấn walk surface ở chân dốc (boar thicket x ≥ 13, forest corridor 1 x ≥ 23).

**Whispering Canopy (`?assetPlaytest=canopy`, thiết kế trong `.opencode/plans/2026-10-11-whispering-canopy-playtest.md`):**
- Route kín ~140 m: lòng chảo thác nước (ải 1) → bậc rễ lên vách đá cao 4 m → cầu dây leo A qua hẻm sông → bãi Hornbill trên vách (ải 2) → cầu dây leo B qua vực → dốc xuống sân đền ngập nước (ải 3) → lối ra đền. Thác 10,5 m, sông qua hẻm và vực, 5 vũng nước quanh sân đền, sương ẩm, tia nắng, lá rơi.
- 3 quái Tripo mới với AI, 9 đòn và VFX/âm thanh riêng: Thornback Howler (khỉ, biped: Rock Hurl, Leap Slam, Branch Sweep), Storm Hornbill (chim bay lơ lửng ~2,4 m, avian: Dive Bomb, Feather Volley, Gale Flap), Mire Viper (rắn 7 m, serpentine: Venom Spit, Tail Lash, Strike Lunge). Mỗi quái có đủ 10 clip (preset Tripo + clip tác giả offline).
- 5 prop Tripo mới: cầu dây leo 12 m (sàn phẳng), đền đá cổ, cây rừng mưa khổng lồ, đá vách rêu, cụm dương xỉ.
- Hệ thống thế giới (terrain, mask, vật liệu, cỏ, clutter, nước, ranh giới) được tách thành module dùng chung theo `BiomeProfile` cho cả hai map; dodge trial, asset gate, HUD và stage goal đọc bộ trial theo region.

**Bằng chứng (coordinator, 1440×900, DPR 1, Apple M1):**
- Trình duyệt: cả hai map tải và chơi được, console sạch. Canopy: Howler, Hornbill, Viper đều tung đủ 3 đòn và gây sát thương; Hornbill vẽ cao hơn vị trí mô phỏng 2,44 m. Greenwake: đi bằng bàn phím từ sống đất qua cầu (y 2,00, x 13,9 → 17,0) rồi xuống dốc cổng (y 1,66 → 0,63).
- Hiệu năng: Canopy 60,0–60,3 fps tại 6 điểm (158 draw call, 1,36 M tam giác/khung, sau khi giảm prop trang trí từ 4,4 M); Greenwake 56,7–60,2 fps tại 6 điểm.
- Test: 1183 Bun + 124 Node pass, `tsc` sạch; brute-force Run/Dive/Jump 16 hướng chứng minh 3 cổng Canopy và 3 cổng Greenwake kín.
- Tripo: 1 625 credit cho đợt này (146 410 → 144 785); 1 265 credit có task ID trong `asset-source/generated/canopy-tripo-log.jsonl`, phần còn lại là các bước thử/làm lại.

**Giới hạn còn lại:** animation rắn tác giả offline còn cứng so với khỉ/chim; dương xỉ trang trí sau khi giảm đa giác trông thô khi ở sát camera; Hornbill chưa có bóng/marker dưới đất khi bay; các map còn lại (Blood Bamboo Valley, Moonpine Ridge, Mistveil Basin, Sunmane Expanse...) chưa có playtest.

### Sprint 2 — Wild Flow hoàn chỉnh (P3)

- 17 evasion entries của Bible §14.9 có clip thật (Tripo biped presets + retarget) và motion warping điểm đáp.
- Perfect Dodge: slow-motion 0.15–0.3 s, Instinct Meter, VFX vệt thời gian; Dodge counter (Cartwheel→sweep, Back Handspring→Tether, Dive Roll→thrust, Staff Vault→downward strike).
- Exit: test boundary perfect-dodge window; playtest “né → phản công” có cue rõ.

### Sprint 3 — Prologue “The Night of a Thousand Roars” (P6 narrative)

- Opening cinematic (Heartroot, Root Crown, Black Sap) bằng camera rail + VFX; tutorial Greenwake theo Bible §PROLOGUE (Quick Step, Shoulder Roll, Cartwheel, Staff Vault, Root Tether, Cleanse lợn rừng), Yara trao Warden Staff, Vara rơi xuống với mảnh Heartroot.
- Exit: New Game → hết Prologue không cần flag curated; audio/subtitle tiếng Anh.

### Sprint 4 — Chapter 1 Whispering Canopy + Koro (P7)

- Môi trường tán rừng/thác/cầu dây leo; ba main mission; boss Koro Branchbreaker; Vara Bird Mark; khôi phục vùng.
- Exit: chơi từ Greenwake → Koro bond/dominion, world restoration hiển thị.

### Sprint 5 — Chapter 2 Blood Bamboo Valley + Asha (P5/P6 First Pact)

- Hunter camp, tiger tracking, Asha 3 phase (Stalking, Corruption Rage, The Cub) + Tali; cleanse → companion.
- Exit: Vertical Slice DoD (Bible §33) 10–15 phút từ Forest Entry đến The First Pact.

### Sprint 6 — The Grove hub và progression (P7)

- Grove 6 stage, companion slots/command wheel, save/restore transaction, return beats.

### Sprint 7–8 — Act II: Moonpine Ridge (Ruun/Luma/Sable) và Mistveil Basin (Ghor/Nyra) (P8)

- Lựa chọn Restore/Luma/Dominion có hệ quả; 6 tổ hợp wolves×Marek đi qua được.

### Sprint 9 — Act III: Sunmane Expanse (Solkar) + Fall of the Grove (P9)

- Bond/Exile/Dominion; Yara hy sinh; refuge.

### Sprint 10 — Act IV: The Living Pact, Heartroot Hollow, Orun 3 phase, ba ending (P10)

### Sprint 11 — Content-complete alpha (P11)

- 7–12 side quest có world-state, Bond/Dominion consequence, không stub.

### Sprint 12–13 — Beta/optimization và Release (P12/P13)

- Newcomer playtest, accessibility, save migration, perf/soak 8–12 h; production build, trailer từ gameplay, credits/rights.

## 4. Rủi ro Sprint 1

| Rủi ro | Giảm thiểu |
|---|---|
| Retarget clip từ rig Tripo 23 xương sang skeleton Aren 65 xương lệch hướng xương | Retarget world-space theo rest pose, cùng một mesh nguồn; kiểm tra pose bằng screenshot từng clip |
| Model Ultra quá nặng cho web | Decimate có bake ≤20k tri trước khi rig |
| Bloom + cỏ dày giảm fps | Bloom half-res, cỏ theo chunk quanh người chơi, đo fps trong browser |
| Bỏ walkable toàn vùng phá test cũ | Thay test “off-trail walkable” bằng invariant mới “route kín”, giữ mọi nav node/ribbon trên walk-mesh |
