# WILD CROWN: THE BROKEN PACT — Production Master Plan

Ngày lập: 2026-09-30. Trạng thái: kế hoạch thiết kế để duyệt và triển khai theo gate; chưa phải game đã được xây dựng.

## 0. Cách đọc và thẩm quyền

- Nguồn truyện: `../WILD-CROWN-GAME-DESIGN-BIBLE-CODEX-CLI.md`, đã đọc đủ 40 mục. Không sửa file gốc trong lượt planning này.
- Quyết định người dùng đã xác nhận: **GLB TripoAI trực tiếp trong runtime; desktop web trước; từng Dominion một thủ lĩnh khóa Living Pact trong lượt chơi đó**.
- Xác nhận bổ sung: **Stylized cinematic; combat phi sát thương, không gore**. Aren đánh gục/khống chế poacher, thanh lọc/cứu thú khi có thể; mất mát trong backstory không đồng nghĩa player có cơ chế giết người.
- Năm chỉnh sửa canon đã được người dùng đồng ý: sau Asha có ba mảnh; council có thể đại diện Crown khi Solkar exile; Koro hợp tác tạm trong slice; mất Warden’s Call vẫn giữ Ask/Signal; Chapter 7 là coalition, chưa tự động đạt Living Pact. Chấp thuận art direction không đồng nghĩa duyệt từng ảnh hiện có làm reference Tripo.
- **Concept Map / UI / Characters đã được người dùng duyệt. English là ngôn ngữ duy nhất của mọi nội dung hướng tới người chơi**: UI/HUD, map, quest, skills, tutorials, dialogue, subtitles, codex, endings, errors và credits. Giữ nguyên art đã duyệt; không bắt đầu gameplay implementation trong lượt chuyển ngôn ngữ. Tripo đã sẵn có và được phép dùng.
- Nguồn copy hiện hành: `content/PLAYER-COPY.en.json` và `content/GAME-NARRATIVE.en.md`. Bible tiếng Việt và các prompt/ảnh gốc giữ làm provenance lịch sử, không được đưa nguyên văn vào game. Engineering notes có thể viết tiếng Việt; mọi chuỗi xuất hiện trong game phải lấy bản English.
- Yêu cầu hiện tại là plan cho **game hoàn chỉnh 8–12 giờ**, mở rộng hơn embedded prompt chỉ yêu cầu slice tại Bible §34. Slice vẫn là gate trung gian, không thay thế campaign.
- `02-IMPLEMENTATION-AND-AGENTS.md`: work packages, dependency, ownership, acceptance và release tests.
- `03-ART-RIG-VFX-PIPELINE.md`: GenImage, Tripo, rig/animation, Environment/Jev, asset/VFX matrices.
- Các chi tiết mới ngoài quyết định được xác nhận ở trên vẫn là **đề xuất thiết kế**, không phải canon đã có trong Bible. Các budget là mục tiêu cần đo, không phải benchmark hiện hữu.

## 1. Đích sản phẩm

**Một game về đọc hành vi và xây sự đồng thuận, không phải thu thập sáu pet cộng damage.**

Ba lớp chiều sâu:

1. **Tactical:** đọc telegraph, chọn hướng/thời điểm né, kiểm soát depth, phản công và gọi đúng companion.
2. **Systemic có giới hạn:** giải nguyên nhân sinh thái để đổi đường đi, encounter, tài nguyên cộng đồng và hành vi hub; không mô phỏng toàn hệ sinh thái.
3. **Narrative:** sức mạnh tức thời của Dominion tạo hệ quả có thể dự đoán; Bond đòi hành động và cam kết, không phải farm một thanh thiện cảm.

### Phạm vi release

| Hạng mục | Cam kết baseline |
|---|---|
| Campaign | 8–12 giờ first-time critical path, không tính idle, chết lại, grind hoặc toàn bộ optional quests |
| Địa lý | Greenwake prologue set; The Grove hub; 5 macro-region; Heartroot Hollow |
| Boss | Koro, Asha, Ruun, Ghor, Solkar, Orun; Orun có ba phase, không tính ba boss để đủ số |
| Companion | 6 nhóm Sky/Canopy/Fang/Pack/Shadow/Crown; cá thể chiến đấu và đại diện chính trị không nhất thiết trùng nhau |
| Side quests | 12 đề xuất: 7 từ Bible + 5 bổ sung được đánh dấu |
| Ending | Dominion, Severance, Living Pact; mọi đường campaign hợp lệ phải có đường kết thúc |
| Điều khiển | Keyboard/mouse + gamepad desktop; remap và glyph theo thiết bị |
| Platform | Desktop browser; không mobile/touch, không launcher desktop trong baseline |
| Game shell | Title, New Game, Continue, slots, settings, pause, tutorial/journal, credits, restart checkpoint, ending/epilogue |
| Phân phối | Game entry riêng, showcase launch card, playable First Pact, build/capture cùng nguồn gameplay |

Không tự thêm seamless open world, free jump, multiplayer, crafting, loot rarity, mount, real-time day/night, ragdoll toàn bộ, live service hoặc character customization. Aren có một thiết kế authored trước; customization phải có quyết định scope riêng.

## 2. Findings từ repository và phiên bản

### 2.1 Showcase hiện tại

Đã đối chiếu `img2threejs-showcase/package.json`, `vite.config.ts`, `src/demos/registry.ts`, `src/pages/demo.ts`; nhánh phân tích kỹ thuật còn trace `src/scene.ts` và demo Riku.

- Stack hiện có: TypeScript 5.6, Three.js `^0.169.0`, Vite 5.4, meshoptimizer `~0.18.1`.
- Registry là contract exhibit: `build(scene)` đồng bộ trả Group, `prewarm` tùy chọn, metadata nguồn, camera, capture. Chưa phải game host async/streaming.
- Vite hiện khai báo index và iphone-duo entry; phải thêm game entry vào build, không chỉ tạo HTML rồi cho là deploy được.
- Viewer có OrbitControls/turntable/explode và tick variable-delta; capture mode có thể không tick. Không dùng nó làm camera/combat loop.
- `src/pages/demo.ts` hiện gắn nhãn “Procedural Scene”. Wild Crown dùng external GLB nên phải có metadata/nhãn trung thực, không gán toàn bộ game là code-only.
- Riku là ví dụ lifecycle và Tripo-derived character; không copy nguyên rig payload tĩnh lớn, fallback LOD giả hoặc chính sách LoopRepeat cho mọi clip vào game.

**Quyết định:** game có entry và lifecycle riêng; gallery chỉ giới thiệu/launch. Tái dùng những tiện ích đã kiểm chứng như resize, tone mapping, contact shadow/capture sau khi tách khỏi quyền điều khiển camera của viewer. Một nơi duy nhất sở hữu render loop khi game chạy.

### 2.2 “img2threejs mới nhất” đã xác minh

| Nguồn | Kết quả |
|---|---|
| Skill đang nạp | 1.5.1; không phải baseline đề xuất |
| Worktree local `worktrees/img2threejs-1.5.2` | SKILL ghi 1.5.2, HEAD `5c800ed81364be8dbaed6223bc1fabe9f3319107` |
| Remote backup `origin` local | Cao nhất thấy v1.5.2; không đại diện upstream chính thức |
| Upstream `https://github.com/img2threejs/img2threejs` | Tag v2.0.0, peeled commit `a669e9a97cea4452b1c2310c5cca6aa0f6657c1f` |
| Official plugin-character | SKILL/CHANGELOG 0.2.0; HEAD đã tra `d8750638f9fc092714e7fcb4941053514455295d` |

Plan chọn **img2threejs 2.0.0 + plugin-character 0.2.0 + img2 harness >=0.2.3**. P0 pin revision chính xác của toàn bộ plugin/harness và chạy discovery. Chưa cài/nâng skill, chưa đổi symlink của máy. Kiểm tra release mới một lần ở P0 rồi khóa dependency; không để agents dùng floating latest khác nhau.

2.0.0 chuyển `animated-character` sang plugin; checklist cũ không tự migrate. Workspace mới phải init đúng provider. Direct GLB không trở thành procedural reconstruction vì chạy vài quality tools: giữ route riêng, dùng adapters đo actual GLTFLoader scene, không ép importer rebind theo emitter procedural.

### 2.3 Hai prerequisite không được giấu

1. **Character evidence:** plugin-character có 12 check nhưng thiếu producer cho G1 `bindingSamples`, G3 `bindRestore`, G6 `meshVisibility`, G10 `skinIntegritySweep`; gate tổng thể hiện `blocking:false`. P1 phải xây measurement producers/adapter cho game. Aggregate exit 0 không phải animation pass.
2. **Environment/Jev:** hiện chỉ `room` fixture-qualified. `vegetation-cluster`, `street`, `building-exterior` chưa qualified. Cần workstream qualification, rights-cleared fixtures, actual renders/measurements và independent review. Jev không sửa rừng tự động, không làm character animation reviewer, không thay quyền acceptance của Environment.

## 3. Canon reconciliation trước content lock

Không tự thay Bible gốc. Năm correction được liệt kê tại §0 đã được người dùng duyệt và là design-lock baseline; các clarification khác trong bảng vẫn là đề xuất cần ghi quyết định khi khóa content data.

| Vấn đề | Quy tắc đề xuất |
|---|---|
| Sky đã xuất hiện ở prologue, sau Asha lại nói hai mảnh | Sky + Canopy + Fang = ba. Sửa beat Orun tương ứng; fragment ledger có sáu ID duy nhất |
| Sáu nhóm nhưng năm vùng | Sky sanctuary và Canopy settlement cùng macro-region Whispering Canopy |
| Boss khác companion | Ruun/Luma là lãnh đạo, Sable là envoy; Ghor là boss, Nyra là companion. Không thêm boss Nyra/Vara |
| Exile Solkar | Crown có council representation; không tự summon Solkar ở Grove/Hollow. Player-only counter luôn tồn tại |
| Cứu Tali main quest trùng side quest | Main cứu Tali khỏi camp; The Last Cub bảo vệ nursery/đường sơ tán sau đó. Thất bại bảo vệ Tali ở mandatory beat = retry checkpoint, không permadeath bất ngờ |
| Mất Warden’s Call | Mất cưỡng chế siêu nhiên, không mất mọi phối hợp. Command wheel đổi thành Ask/Signal; utilities đã đồng thuận vẫn dùng được |
| Living Pact ở Chapter 7 nhưng ending có điều kiện | Chapter 7 là Wild March coalition, có thể không đủ nhóm; permanent Circle of the Wild chỉ ở ending đủ điều kiện |
| Mọi thú tự quay lại dù từng bị ép | Vara ở lại; các nhóm khác quay lại/đòi điều kiện theo lịch sử. Thiếu hỗ trợ làm đường khó/khác, không softlock |
| Restoration partial/contested lẫn lộn | Restoration: unvisited/corrupted/partial/restored. Political settlement là trục khác |
| Ferocity hồi làm phase lùi | Boss phase latch chỉ tiến; bỏ lỡ cleanse hồi Ferocity trong phase, không phát lại reward/cinematic |
| Slice có Koro utility trước boss Koro | Chase tạo provisional cooperation được nói rõ; First Pact là curated excerpt trên cùng graph, không giả rằng Koro đã bonded |
| Solkar nói câu dài, thú không nói tiếng người | Truyền qua Echo Sense: hình/âm/cảm xúc + phrase ngắn; không human lipsync cho thú |
| Nyra giết thú nhưng Aren luôn chữa được | Phân biệt tình trạng còn khả năng phục hồi và mô bị hủy không đảo ngược; giải thích bằng dấu vết/vision, không dùng như cớ ngẫu nhiên để giết boss |

## 4. Gameplay depth: thiết kế có thể chơi

### 4.1 Vòng điều tra → combat → phục hồi

Mỗi vùng có ít nhất một chuỗi:

- Dấu vết nhìn/nghe được mà không bật Echo Sense.
- Echo Sense bổ sung quan hệ nguyên nhân, không vẽ mũi tên giải mọi câu đố.
- Hành động sửa nguyên nhân thay đổi một yếu tố encounter hoặc đường đi.
- Combat kiểm tra cách hiểu hành vi con vật.
- Cleanse dừng sự khuếch đại Black Sap, **không tự tạo thức ăn/nước/niềm tin**.
- Quyết định sau combat tạo cả lợi ích tức thời và callback Chapter 7.

Ví dụ Asha: dấu tre gãy và mùi tro dẫn tới bẫy; giải phóng Tali làm rõ mục tiêu bảo hộ; Vara đọc điểm đáp; Koro giúp hạ bó tre; Aren tự né và tiếp cận cleanse. Người chơi chiến thắng bằng hiểu và hành động, không chỉ hạ thanh máu.

### 4.2 Wild Flow Evasion: không phải auto-dodge

Người chơi quyết định **hướng + thời điểm** bằng Dodge + movement. Resolver chỉ chọn movement profile phù hợp theo rule được dạy; không tự né hộ hoặc đổi hướng sang lối an toàn.

- Lateral input thường chọn quick step/cartwheel tùy context/distance đã công bố.
- Back input có profile giữ mặt về boss; backward không phải đáp án an toàn cho pounce đuổi dài.
- Diagonal depth shift thoát charge và đổi vị trí đội hình.
- Low Slide và Staff Vault được chọn ở affordance/tình huống đã telegraph rõ; không căn cứ trạng thái attack bí mật không thể quan sát.
- Commit input giữ world-space intent qua rail transition; camera không đổi góc từ anticipation tới hit.
- Hazard có `avoidanceClass`: contact strike, body-height sweep, ground wave, lingering area. I-frame không vô hiệu mọi hazard. Collision/height/depth thực tế và rule avoidance quyết định kết quả, không tên animation.
- Perfect Dodge chỉ xảy ra khi đã thực sự threatened, trong valid overlap window; dedup bằng attack instance/hit group, không farm hazard tồn tại lâu.
- Hai charge; recharge 1.5–2s là baseline playtest. Đòn nhiều nhịp phải có lối defensive khả thi ngay cả khi thiếu charge; không thiết kế unavoidable chain do scheduling.

Chứng minh readability trước art polish: người chơi mới phân biệt được pounce, charge, claw, cone và wave qua body/environment/audio; giải thích được vì sao né hụt.

### 4.3 Combat tạo lựa chọn, không chỉ cooldown rotation

- Light combo xây Instinct và giữ áp lực nhưng không xóa mọi stagger window.
- Heavy/charged heavy đổi mobility lấy Ferocity damage/guard break.
- Root Tether chặn hoặc giữ trong cửa sổ có giới hạn; không khóa boss vô hạn.
- Counter sau né có nhánh nhanh an toàn hoặc heavy/call phối hợp rủi ro hơn.
- Instinct đề xuất dùng cho một coordinated action/counter nâng cao; không tạo thêm mana/stamina thứ hai. P0 khóa cost và reward table; khả năng né căn bản không cần Instinct.
- Auto basic attacks của companion có trần đóng góp; special phải do player ra hiệu. Không cho pet tự hoàn tất cleanse.
- Target scoring ưu tiên input/visibility; magnetism nhỏ, collision-safe, không quay lưng đánh mục tiêu sau camera.
- Healing baseline đề xuất: một số charge hồi phục hữu hạn mỗi checkpoint, animation dùng có rủi ro; refill ở sanctuary. Không loot potion grind. Số lượng/khả năng cancel khóa qua P3 playtest.
- Không scale HP máy móc theo chapter; tiến triển chủ yếu thêm hành vi, arena constraints và coordination.

### 4.4 Companion là grammar hành động

| Nhóm | Động từ | Quyết định của player | Không được làm |
|---|---|---|---|
| Vara | Observe/mark | Đánh dấu landing hay weakness | Khóa fair offscreen warning sau Bond upgrade |
| Koro | Manipulate | Đổi layout, gây distraction hay giữ utility sẵn | Hoàn tất puzzle không có command/context |
| Asha | Protect/break | Chặn charge hay dùng pounce phá giáp | Tự tank vô hạn |
| Sable | Track/flank | Theo dấu hoặc giữ flank slot | Lộ mọi secret tự động |
| Nyra | Conceal/ambush | Chờ counter window hay mở shadow route | Stealth giải quyết mọi encounter |
| Solkar/Crown | Rally/coordinate | Buff group và timing ngắt hiếm | Bắt buộc có Solkar để thắng finale |

Baseline thường là 1 large combat + 1 utility ground + Vara. Tổng fully simulated large beasts tối đa 2 kể cả hostile; boss nằm trong cap 4–6 hostile, không cộng ngoài cap. Support windows dùng reservation/hand-off rõ, không cho từng subsystem tự lấy quota riêng. Wild March dùng crowd representation riêng; không mô phỏng hàng trăm AI/nav/skinned actors full rate.

### 4.5 Bond và Dominion có lợi ích/hệ quả thực

Bond có ba milestone đề xuất 0–3: wary → cooperating → trusted → covenant. Đạt bằng story/ecosystem obligations đã định danh; combo có thể tăng progress nhỏ nhưng không thay thế covenant quest.

Dominion đề xuất mở phiên bản special mạnh sớm, giảm yêu cầu phối hợp tại một số encounter. Giá phải trả: posture bị nén, hub ít tự chủ, instability được báo trước, possession ở Solkar/Orun. Low Bond không làm AI bị kẹt hoặc cố tình giấu cảnh báo công bằng.

Possession là authored window có telegraph/counterplay nonlethal, không random phản bội khiến player chết. Từng leader domination được ghi lịch sử bất biến trong run; sửa quan hệ về sau không xóa sự kiện.

### 4.6 Ending predicate — một nguồn cho journal và finale

Baseline cụ thể để triển khai, cần art/narrative sign-off ở P0:

- `everDominatedLeader(runId) === false`.
- Cả sáu faction có covenant tier 3 và voluntary representative; Crown council hợp lệ nếu Solkar bị exile.
- Cả năm macro-region restored; Hollow resolution hoàn tất.
- Năm obligation chính: Canopy water+seed accord; Bamboo Tali safe+snare source neutralized; Moonpine pack civil-war settlement; Mistveil river source neutralized+Nyra truth acknowledged; Sunmane coercive tribute ended+voluntary governance.
- Cả sáu nhóm đã tái cam kết trong Chapter 7.
- Marek không bắt buộc sống; Hunter’s Remorse không tự động là điều kiện true ending. Bỏ Marek có route thông tin khác.

Living Pact là option ở final choice khi đủ predicate, không tự chọn hộ. Dominion và Severance vẫn có thể chọn khi đủ/thiếu predicate. UI cảnh báo rõ việc Dominion thủ lĩnh khóa ending theo lịch sử trước khi confirm. Không báo nhầm rằng chỉ tăng Bond lại là sửa được.

## 5. Campaign content và pacing

Thời lượng dưới đây là allocation thiết kế, cần newcomer playtest; tổng 580 phút ≈9 giờ 40 phút, không phải thời gian đã đo.

| Đoạn | Phút | Nội dung và payoff |
|---|---:|---|
| Greenwake | 25 | Night of Roars; Vara/Sky; staff; movement/né cơ bản/cleanse boar; không nhồi cả 17 dodge |
| Whispering Canopy | 70 | Fallen Scout, Thief in Branches, Empty Orchard; Koro boss; nước/hạt/cầu; hai cộng đồng sống lại |
| Blood Bamboo | 75 | Tracks Without Blood, Ash Hunters, Mother’s Roar; Asha ba phase; Tali; Fang; bảo hộ thay chiếm hữu |
| Moonpine Ridge | 75 | Third Howl, Two Packs, Alpha Below; Ruun; lựa chọn Ruun/Luma/Dominion; Sable; Yara reveal |
| Mistveil Basin | 80 | Eyes in Mist, Black River, Mire Maw; điều tra Nyra, Marek, Ghor; nước/route đổi |
| Sunmane Expanse | 80 | Silent Plains, Tribute of Teeth, Lion’s Offer; Solkar ba phase; Bond/Exile/Dominion |
| Fall of Grove | 25 | Nonlethal possession; cứu Tali; pillar; Yara; mất coercive Call; dịch vụ chuyển refuge |
| Return campaign | 60 | Năm objective mới phản ánh lịch sử, không chạy lại boss; tái cam kết; Wild March |
| Hollow + Orun | 80 | Route theo coalition, ký ức playable, Orun mirror/Crowned Beast/Crown choice |
| Ending/epilogue | 10 | Một ending + regional vignettes; Grove outcome; credits |

### Năm return beats bắt buộc có nội dung mới

1. **Canopy — Seeds on the Wind:** điều phối khỉ/chim mang hạt qua route bị rễ chặn; restored orchard cho cầu sống, chưa đủ restoration phải sửa nguồn nước.
2. **Bamboo — A Path for the Young:** sơ tán Tali/nursery qua đường bẫy còn sót; Asha tự chọn bảo vệ đội sơ tán hoặc tiên phong theo obligation đã hoàn tất.
3. **Moonpine — One Howl, Two Generations:** tổ chức tín hiệu liên lạc/phân vai hai đàn; lãnh đạo được chọn đổi formation, không chỉ câu thoại.
4. **Mistveil — Witness in the Reeds:** mở corridor ít nhiễm; Nyra đánh dấu đường; Marek sống có thể tháo cơ cấu trại, vắng hắn player dùng alternate route có sẵn.
5. **Sunmane — The Open Crossing:** giải phóng migration passage; Solkar tự hạn chế quyền hoặc council phân quyền; không thêm một full-animation companion mới chỉ để thay Solkar.

### Side quest ledger: 12

| Quest | Nguồn | Consequence thực |
|---|---|---|
| The Empty Nest | Bible | Tổ/đàn chim/scout opportunities; cảnh báo nền vẫn có |
| The Last Cub | Bible, phân biệt main rescue | Nursery/evac route, Asha army commitment |
| A Pack Divided | Bible | Cooperative hunt, patrol/supply, không lặp election |
| The Silent Hunter | Bible | Protected corridor, Ambush Counter |
| A King Without Subjects | Bible | Trust trial của Solkar; exile branch là council mediation |
| River of Black Sap | Bible | Phá đập nhanh đổi floodplain; sửa chậm giữ tuyến khác |
| The Hunter’s Remorse | Bible, conditional | Marek dismantle traps/supply; thiếu hắn không softlock |
| Seeds Between Branches | Đề xuất mới | Chia hạt theo thứ tự, nursery/orchard tradeoff |
| The Broken Snare Trail | Đề xuất mới | Dỡ bẫy tuyến hoặc chặn nguồn cung, safe-path khác |
| Winter Stores | Đề xuất mới | Phân phối dự trữ, patrol hỗ trợ khác |
| The Last Crossing | Đề xuất mới | Migration/prey safety, đường đi và encounter khác |
| Roots We Share | Đề xuất mới | Điều phối nước/chỗ ở hub, evacuation resilience |

Không tạo deadline giả để trừng phạt player nếu hệ thống không mô phỏng deadline đó. Mỗi choice có thông tin khám phá trước, lợi ích ngay, hậu quả nhìn/nghe được và callback.

## 6. Boss matrix và absence-safe design

| Boss | Bài kiểm tra | Arena/đổi phase | Resolution và đường không cần optional pet |
|---|---|---|---|
| Koro | Depth, high/low threat, contextual dodge | Branch/platform/log sweep | Tự né và lôi gai; Vara/Koro state theo mission; Canopy accord |
| Asha | Pounce/charge/claw/cone/wave | Stalk → rage → bảo vệ Tali | Script bảo đảm provisional Koro tại beat bó tre; nếu utility unavailable có interaction reset/retry, không mất vĩnh viễn |
| Ruun | Formation, hai nhịp, chain | Ice/chain/safe-gap lane | Player phá anchors/né; Asha/Koro tạo shortcut window, không loadout lock |
| Ghor | Occluded target, land/water timing | Mud/water surge/tail sweep | Ground markers + audio luôn đủ; Vara tăng thông tin, không cần free jump |
| Solkar | Command pressure, Bond | Strength → army → Dominion roar | Player cover/break signal; absence-safe support windows |
| Orun | Kiến thức tổng hợp, không input-reading vô hạn | Warden mirror → six aspects → choice | Mỗi aspect có player-only counter và optional assist; absent companion không khóa core |

Orun sáu aspect: Sky né shadow-bird lanes; Canopy phá root anchor rồi traversal; Fang side-evade pounce; Pack tìm gap formation; Shadow đọc core bằng cue nền; Crown núp/break suppression anchor trong cửa sổ. Vara/Koro/Asha/Sable/Nyra/Solkar rút ngắn hoặc làm rõ cơ hội, không thay thế gameplay.

## 7. Kiến trúc runtime đề xuất

### 7.1 Cấu trúc trong showcase

Các đường dẫn mới là đề xuất, chưa tạo code:

```text
wild-crown.html
src/games/wild-crown/
  main.ts
  app/             GameApp, GameLoop, SceneFlow, lifecycle
  simulation/      movement, combat, evasion, AI, companion, quest, world
  contracts/       actor/action/attack/region/save/asset schemas
  presentation/    GLB actors, AnimationController, CameraDirector, VFX, audio
  content/         actors, attacks, encounters, regions, quests, dialogue
  ui/              DOM menus, HUD, journal, accessibility
  tools/           authoring inspectors, replay/evidence capture
  tests/           behavioral contracts with isolated fixtures
public/wild-crown/ assets, region manifests, versioned GLBs/textures/audio
src/demos/wild-crown/ showcase launch/preview integration
```

Integrator cập nhật registry, page labels, build entry và asset base paths; không copy cả repo làm game mới. Game là showcase mới độc lập nội dung, không phải fork gallery với những framework song song.

### 7.2 Simulation authority

- Fixed 60Hz, accumulator có max catch-up. Tab hidden tự pause; resume không phát một loạt damage bù thời gian.
- Input snapshot → AI/token reservation → intents → collision/movement → authoritative action phase/hits → world events → presentation snapshot.
- Three.js AnimationMixer chạy theo phase/clock đã được controller quyết định. Render interpolation không gây damage/quest reward.
- Tách unscaled UI/audio clock, game simulation clock và local hitstop policy. Perfect Dodge 0.15–0.3s không làm cooldown phụ thuộc frame rate.
- World root/capsule, visual offset, skeleton root riêng; root curve không bị cộng hai lần. Collision-safe warp chỉ trong range đã được animator duyệt.
- CameraDirector là writer duy nhất; rail transitions chờ attack boundary. Zoom trước telegraph cần thiết, không đổi góc giữa đòn.
- Prefer modular actors + flat registries/data, không ECS framework/custom engine nếu chưa chứng minh cần.
- P1 physics spike chọn kinematic capsule sweeps, ground/slope/step handling; nếu thư viện chuyên dụng được chọn phải pin và kiểm thử trong browser. Không viết full physics engine.

### 7.3 Hợp đồng dữ liệu cần khóa

| Contract | Fields bắt buộc về hành vi |
|---|---|
| AttackDefinition | stable ID, phases, commit tick, shape/trajectory, height/depth, hit group, damage/Ferocity, counter window, avoidance class, telegraph/audio/VFX IDs, interrupt policy |
| ActionClipMap | action ID khác provider clip name; rig revision, root curve, contacts, loop proof, speed/warp limits, markers, cancel/exit policy |
| EncounterDefinition | arena/nav/ribbon, spawn bounds, token quotas, large-beast cap, allowed support slots, phase gates, failure/reset conditions |
| RegionDefinition | streaming cells, required assets, camera rails, collision/nav revision, route requirements, restoration delta, safe landing anchors |
| CompanionRuntime | mode/allegiance, slot/token ownership, cooldown, utility target, command status, recall safe points; relationship là durable state riêng |
| WorldFacts | unique fragments, faction representation, leader history, region restoration, objectives, quest completion, chapter, refuge/services |
| PresentationEvent | instance ID, sim tick, source/target/socket, spatial payload, lifecycle/cancel token; không ghi WorldFacts |
| AssetManifest | provenance, source/derivative hashes, rig/clip/LOD versions, coordinates, bounds, sockets, budget, evidence status |

### 7.4 Save và lịch sử Dominion

IndexedDB transactions cho checkpoint snapshot và run-level append-only domain ledger. Dùng runId riêng cho campaign/showcase/replay.

- Choice commit ghi event, new snapshot và unlocks trong cùng transaction; resume sau crash không phát reward lần hai.
- Ledger domination theo run độc lập checkpoint: load slot cũ trong cùng run vẫn hợp nhất lịch sử đã commit. “Load trước lựa chọn để xóa history” không phải đường UI hợp lệ theo quyết định strict của người dùng.
- New Game tạo run mới. Chapter replay/showcase không nhập rewards/eligibility vào campaign.
- Import cùng runId merge monotonic historical facts trong local ledger; export chứa ledger+snapshot+schemaVersion. Không hứa chống xóa local storage/sửa file save thủ công.
- Version migrations có backup; unknown future schema không overwrite save. Corrupt/quota failure báo rõ, giữ bản tốt trước; cho export thủ công.
- Skip cinematic commit cùng outcome với xem hết. Load giữa cleanse/restoration trở lại safe phase xác định hoặc reconstruct completed state; không drop objective vì dedup VFX.
- Postgame baseline: return-to-pre-finale checkpoint có nhãn rõ; epilogue là outcome view, không giả world hậu ending hoàn toàn playable.

### 7.5 Streaming/lifecycle

Region manifest load có progress/error/retry rõ; thất bại không spawn player vào void. Source assets offline, runtime dùng immutable hashed production derivatives. Cache bounded, dispose mixer/actions/geometries/textures/audio/observers/listeners; không chỉ remove Group.

Restoration đổi collider/nav/water tại safe commit; relocate actor nếu cần trước swap. Không làm mất ground dưới chân. Travel handoff giữ snapshot rollback-safe. Save/training/party ở refuge vẫn dùng sau Grove collapse.

## 8. Performance và chất lượng

P0 phải ghi máy/GPU/OS/browser/version, resolution/DPR, nguồn điện, network profile. Chưa có reference-machine benchmark Wild Crown trong lượt planning này.

Mục tiêu ban đầu: desktop 1920×1080, DPR cap 1–1.5; 60fps target, p95 frame interval <=17.5ms và p99 <=25ms trên fixed route sau warm-up; báo CPU/GPU riêng. Ngưỡng có thể điều chỉnh bằng evidence ở P1, không đổi lén cuối dự án.

Budget khởi điểm để profiler phân bổ, không phải bảo đảm cho mọi máy:

- <=250 draw calls gồm shadow passes; <=1M visible triangles; <=150k deforming triangles trong canonical worst-case encounter.
- Hero/boss LOD0 khoảng 25–45k triangles; companion phụ 10–20k; chỉ một shadowed directional và tối đa hai local light không shadow.
- VFX GPU khoảng <=2ms trên máy chuẩn; giảm cosmetic particles trước, không cắt mandatory telegraphs.
- Initial interactive payload <=25MB compressed; region streamed chunk target <=40MB. Full campaign tải theo vùng, không nhét tất cả vào initial bundle.
- GPU residency target <=350MB; ghi cách ước lượng/đo, không đồng nhất renderer.info count với GPU bytes chính xác.
- Sau 10 chu kỳ vào/ra cùng vùng: resource counts trở về baseline, post-GC heap không có trend tăng >5% trong controlled diagnostic.
- Stress hợp lệ: Aren + boss + Asha + Koro + Vara + tối đa 5 hostile nhỏ còn lại; boss+Asha =2 large, tổng hostile<=6. Nếu Asha chưa được unlock thì dùng phase appropriate support, không dùng roster sai canon làm acceptance duy nhất.

Browser matrix đề xuất Chrome/Edge Windows, Chrome/Safari macOS, Firefox desktop; WebGL2 baseline. Loading failure, tab pause, resize, controller disconnect, audio unlock, context loss đều có recovery path.

## 9. Roadmap cấp sản phẩm

Chi tiết work packages ở tài liệu 02. Không mở content mass-production trước proof camera/combat và một human + một quadruped đã chạy thật.

| Phase | Kết quả bắt buộc | Gate mở phase tiếp |
|---|---|---|
| P0 Design/toolchain lock | Canon decisions, scope, contracts, versions, rights, reference hardware | Không còn mâu thuẫn critical hoặc provider capability giả định |
| P1 Risk labs | Native GLB evidence, Aren/Asha deformation slice, camera-depth lab, environment qualification track | Measured motion + ground contact + fair depth; blocker được giải, không fake green |
| P2 Movement/camera | Runnable greybox với collision, rail, traversal, lifecycle/save tối thiểu | Người mới di chuyển/traversal không mất hướng/void |
| P3 Wild Flow/combat | 17 evasion entries mapped, attacks, hit windows, targeting, tokens, counter | Boundary scenarios và actual browser combat pass |
| P4 Companion/world | Vara/Koro, slots, commands, objectives, restore/save transactions | Không softlock/reward duplicate/path fail |
| P5 Asha encounter | Ba phase, Tali, cleanse, companion handoff | End-to-end encounter không console; mọi đòn có counter |
| P6 First Pact | 10–15 phút polished same-runtime excerpt, final assets/audio/UI | Slice DoD Bible đầy đủ; chưa gọi full game hoàn thành |
| P7 Full Act I/hub | Greenwake, Canopy full/Koro boss, Bamboo full, Grove | Chơi từ new game qua hai chương, không dựa curated flags |
| P8 Act II | Moonpine + Mistveil, Ruun/Ghor, Sable/Nyra, choices | 6 tổ hợp wolves×Marek đi qua được; consequences thật |
| P9 Act III | Sunmane/Solkar + Fall of Grove | Bond/Exile/Dominion và refuge hoạt động |
| P10 Act IV/finale | 5 return beats, Hollow, Orun, 3 endings | Thiếu companion vẫn hoàn thành; predicate/history đúng |
| P11 Content-complete alpha | 12 quests, progression, narrative variants, final roster | Full run critical path không stub/placeholder |
| P12 Beta/optimization | Newcomer playtests, accessibility, save migration, perf/soak | 8–12h đo thật, release blockers đóng |
| P13 Release/showcase | Production build, gallery entry, trailer từ gameplay, credits/rights, recovery docs | Clean-profile start→ending, deployed entry/assets/save verified |

Critical path: P0 → P1 evidence/gameplay risk → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10 → P11 → P12 → P13. Environment qualification và art preproduction chạy song song từ P1 nhưng phải xong trước nghiệm thu cảnh phụ thuộc. P8 hai vùng có thể làm đồng thời sau contracts đã ổn.

## 10. Quyết định, rủi ro và mức tin cậy

| Decision/risk | Confidence từ research + cross-review | Cách xử lý |
|---|---|---|
| Direct GLB, desktop, historical Dominion | Người dùng xác nhận | Không re-open hoặc thay bằng encoded TS |
| Game entry/loop riêng | Cao, current repo contract + hai nhánh đồng ý | Integrator owns gallery/build boundary |
| 2.0.0 + character plugin | Cao về upstream source, chưa installation proof | P0 discovery/pin; local 1.5.2 không dùng như latest |
| Native GLB rig gates | Trung bình về adapter effort, cao về missing producers | P1 đo actual importer; không áp threshold custom emitter mù quáng |
| Forest qualification | Chưa có bằng chứng pass | Explicit prerequisite; cấm đổi qualified flag bằng tay để thông qua |
| Tripo quad auto-rig | Tài liệu có support; chưa thử asset/account | Canary Asha; custom rig/animation nếu auto-rig không đạt, source mesh vẫn Tripo |
| Bird/primate/crocodile rig | Không giả định provider hỗ trợ | Bespoke rigs + family fixtures |
| 8–12h/60fps | Target chưa đo | Newcomer runs + profiler trên hardware đã chốt |
| Branch explosion | Cao | Shared level state deltas + present/absent matrix, không 18 campaign riêng |
| Strict Dominion reload | Cao sau clarification | Durable run ledger, warning rõ; không anti-tamper claim |

Không cần hỏi lại platform, asset route, historical Dominion, stylized cinematic, combat phi sát thương/không gore hoặc năm correction canon đã chốt. Gate P0 còn cần duyệt production reference cụ thể và các canon clarification còn lại nếu ảnh hưởng nội dung; quyền sử dụng asset, hạn mức generation, máy nghiệm thu và consent disclosure phải có trước bước thực thi tương ứng.

## 11. Bằng chứng planning và giới hạn

Đã làm: đọc Bible; khảo sát repository; hai nhánh chuyên môn + cross-critique + sanity check; tra official upstream tags/docs; tra official Tripo docs; tạo ba concept bằng Codex GenImage và xem trực tiếp.

Chưa làm: cài 2.0.0/plugins, gọi Tripo trả phí, tạo mesh/rig production, benchmark game, đạt Environment/Jev/rig gates, build/deploy game. Không có code gameplay được sửa trong planning này.

Nguồn upstream:
- https://github.com/img2threejs/img2threejs/tree/v2.0.0
- https://raw.githubusercontent.com/img2threejs/img2threejs/v2.0.0/SKILL.md
- https://raw.githubusercontent.com/img2threejs/img2threejs/v2.0.0/CHANGELOG.md
- https://raw.githubusercontent.com/img2threejs/img2threejs/v2.0.0/docs/STAGE_R_TEST_PLAN.md
- https://raw.githubusercontent.com/img2threejs/img2threejs/v2.0.0/docs/STAGE_R_BACKLOG.md
- https://github.com/img2threejs/plugin-character/tree/d8750638f9fc092714e7fcb4941053514455295d
- Local `img2-plugins/plugin-environment/SKILL.md`, `tools/_checks/_common.py`; `skill://img2-jev`.

Bản plan phân biệt rõ mục tiêu, bằng chứng và prerequisite; “hoàn thành plan” không đồng nghĩa “đã chứng minh full game khả thi ở chất lượng cuối”.
