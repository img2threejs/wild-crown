# Wild Crown — Visual approval round 01

## Gate mới theo yêu cầu người dùng

Concept Map / UI / Characters đã được người dùng duyệt. Yêu cầu hiện hành: giữ nguyên art/layout, chuyển toàn bộ player-facing copy sang English, sau đó báo hoàn thành; không bắt đầu gameplay implementation trong lượt chuyển ngôn ngữ. Tripo đã sẵn có/được phép dùng. Các prompt/ảnh sinh ban đầu có tiếng Việt chỉ còn là provenance, không là copy source production.

## Deliverables để xem

- M01: Erya world-map proposal, năm macro-region + Grove + Greenwake; Hollow là không gian dưới rễ.
- M02: The First Pact level-design map, sáu segment theo Bible, nhánh/shortcut/arena/depth rõ.
- U01: Exploration gameplay composition + HUD.
- U02: Asha boss gameplay composition + Ferocity/Corruption/telegraph HUD.
- U03: World map/journal screen có selected quest và legend.
- U04: Companion screen thể hiện 1 combat + 1 utility + 1 aerial, Bond không phải loot rarity.
- C01: Human cast: Aren, Yara, Orun, Marek.
- C02: First Pact creatures: Vara, Koro, Asha, Tali.
- C03: Wolf cast: Ruun, Luma, Sable — khác silhouette/age/posture.
- C04: Nyra, Solkar, Ghor — khác family, scale được ghi là editorial, không measured.
- C05: Crowned Beast — identity riêng cho Orun phase 2, sáu aspect có trật tự.

Đây là **ảnh tổng hợp bằng Codex GenImage**, không là screenshot Three.js hoặc bằng chứng runtime/Environment/rig pass. Character boards dùng để duyệt identity/silhouette chung, không trực tiếp làm multiview input Tripo. Chỉ sau duyệt mới tạo individual isolated front/side/back references và kiểm consistency.

## Hướng art và UI

Stylized cinematic đã được duyệt; shape-first, tactile simplified materials, no photoreal fur strands, no chibi, no gore. Palette world: forest green, bamboo ochre, cold blue-gray pine, teal mist, warm savanna. Heartroot/Bond amber-ivory organic exchange; Black Sap oily black/copper; Dominion rigid converging lines.

UI: dark charcoal-green backing, ivory text, restrained brass borders/root motifs. **All visible text must be English**, including map annotations, prompts, abilities, roles, quest states and navigation. Serif display headings and readable sans-serif body. No sci-fi/neon, loot rarity or icon spam. Gameplay information/contact shadows take priority. Use the English catalog rather than the original Vietnamese mockup strings.

## World topology đề xuất, chưa phải canon geography đã khóa

The Grove ở trung tâm; Greenwake phía nam; Canopy phía tây; Bamboo tây bắc; Moonpine phía bắc; Mistveil phía đông; Sunmane đông nam. Heartroot Hollow nằm dưới Grove, trình bày cutaway/inset riêng. Năm vùng có lối nối hub; story unlock order là Canopy → Bamboo → Moonpine → Mistveil → Sunmane, không hàm ý world seamless.

M01 là toàn bộ world-map đề xuất. U03 chỉ zoom/illustrate các vùng đã khám phá; vùng cuối chưa khám phá phải obscured, không tự tiết lộ toàn bộ final boss.

## Composition constraints

M02: six authored segments Forest Entry → Monkey Chase → Hunter Camp → Tiger Tracking → Asha Arena → First Pact. Bridges/traversal được chỉ định; loop optional không bypass required rescue. Asha arena có foreground/middle/background maneuvering space, một lối entry và shortcut exit mở sau cleanse, không free-jump gaps bắt buộc.

U01/U02: camera ba phần tư 2.75D, thật sự thấy foreground/background; Aren không quá lớn như close third-person, không top-down RTS. Aren lower-left/midfield, threats on right; feet/ground and telegraph visible. Koro support at side/background, Vara aerial; Asha là hostile boss ở U02 nên không đồng thời là party portrait đã unlock. Player HP khác boss Ferocity/Corruption. Two dodge charges; Instinct separate. HUD không che arena.

C01: Aren short moss/ochre jacket, forearm root mark, short hair; neutral unarmed pose, staff riêng. Orun không long cape/robe/skirt; short root shoulder structure, trousers và chân tự do cho acrobatics. Human nonlethal tone.

C02: Asha simplified fur masses, protective female tiger, ochre/charcoal stripes and scar; Tali cub khác tỷ lệ không scaled adult. Vara hornbill chứ không eagle, Koro primate với grasping hands và tail theo phương án đang đề xuất.

C03/C04: mỗi cá thể silhouette riêng, gray studio không forest để nhìn anatomy. Vũ khí/phụ kiện không dính tay/chân. Không giả six-view consistency từ một board.

## Tiêu chí duyệt trước implement

1. Map: nhận ra địa hình/vùng, đường chính/optional/locked route và địa điểm quan trọng; geography/story không mâu thuẫn.
2. Gameplay picture: đọc được player, feet, threat footprint, depth và companion roles ngay khi nhìn.
3. UI: hierarchy rõ, essential information lớn, không HUD spam; small generated glyphs/text chỉ là mockup, cần typeset chuẩn khi implement.
4. Characters: original identity, silhouette/age/species khác nhau, mặt/paws/hands hợp lý, outfit hỗ trợ animation; thống nhất stylization.
5. Concept quality không chứng minh rigging, navmesh, readability chuyển động hoặc performance. Những gate đó vẫn phải kiểm sau visual approval.

Người dùng duyệt riêng Map / UI / Characters. Bất kỳ nhóm nào cần sửa thì không coi cả bộ đã approved.
