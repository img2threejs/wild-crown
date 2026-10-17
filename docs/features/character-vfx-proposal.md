# Proposal: Character VFX — Dark, Living, Forceful

**Trạng thái:** đề xuất để duyệt, chưa triển khai và chưa có visual/performance acceptance.

## 1. Mục tiêu và phạm vi

Nâng cấp VFX cho bốn hero **Aren, Yara, Vesper, Sakda** và sáu companion **Koro, Vara, Asha, Sable, Nyra, Solkar**. Định hướng: tối và có chiều sâu hơn, chuyển động có chủ đích, đòn đánh có lực nhưng không che animation, phản ứng mục tiêu hoặc dấu hiệu báo đòn.

Đây là nâng cấp presentation trên bộ kỹ năng hiện có. Không đổi damage, hitbox, mana, cooldown, thời điểm trúng đòn, số hit, trạng thái bất tử, hiệu ứng hỗ trợ, quest hoặc save. Giữ native GLB/animation và bản sắc nguyên tố. Không thiết kế lại toàn bộ boss/quái, UI, camera hoặc âm thanh trong phạm vi này. Không gore: đỏ thẫm của Vesper là năng lượng, không phải máu.

Căn cứ hiện tại: `src/game/heroes.ts`, `src/game/companions/CompanionSkills.ts`, `src/effects/vfx/palette.ts`, `VfxSystem.ts`, `hero-fx.ts`, `CompanionFx.ts`. Hệ hiện có đã có alpha smoke tối, additive light, pool, giới hạn HDR/contact và Reduced Effects; đề xuất không coi những phần đó là còn thiếu.

## 2. Ngôn ngữ chung

**Dark không đồng nghĩa tất cả nhân vật đều phun khói đen.** Vesper dùng mực/bóng tối; Aren dùng bão và phù văn; Yara dùng rễ, nhựa cây và phấn; Sakda dùng than hồng, sức nóng và bụi. Companion giữ nguyên ngôn ngữ riêng.

Mỗi kỹ năng có ba nhịp, bám đúng thời gian simulation hiện tại:

1. **Tụ lực:** vật chất tập trung quanh đúng bàn tay, vũ khí hoặc bộ phận đang thi triển. Chiêu tức thời không bị thêm thời gian chờ.
2. **Giải phóng/chạm:** hình khối rõ hướng, nhấn sáng ngắn đúng sự kiện release/contact. Chém hụt có trail nhưng không có impact giả; projectile chỉ nổ khi sự kiện thực xác nhận.
3. **Tàn dư:** vật chất tiếp tục bay, rơi, xoáy hoặc tan hợp nguyên tố. Tàn dư chỉ trang trí, không ám chỉ vùng gây sát thương còn tồn tại.

### Quy tắc hình ảnh

- Silhouette và hướng lực quan trọng hơn số lượng particle; tránh mọi skill đều là vòng tròn phát sáng.
- Khối tối dùng alpha blending; lõi/viền sáng dùng additive. Giới hạn bloom để không biến chồng lớp thành mảng trắng.
- Telegraph báo nguy hiểm ưu tiên hơn VFX trang trí. Không thay đổi footprint gameplay bằng hình ảnh lớn hơn thực tế.
- Đòn thường gọn; heavy có trọng lượng; ultimate có trình tự riêng nhưng không che kín màn hình hoặc trì hoãn input.
- Buff nhẹ, nhận biết được từ hình dạng và vị trí, không chỉ màu. Hết buff, đứt mark, recall hoặc đổi scene phải hết VFX tương ứng.

## 3. Bốn hero

### Aren — Storm-Carved Warden

**Bản sắc:** cyan thép, xanh bão sâu; vàng cổ ở heavy. Hình chủ đạo là cung glaive sắc, nét rune có góc cạnh và sét phân nhánh. Cảm giác chắc, chính xác, có uy lực; không thành pháp sư bóng tối.

| Kỹ năng hiện có | VFX đề xuất |
|---|---|
| Warden Blade / Crescent Wave | Trail mỏng bám lưỡi glaive, phân biệt bốn hướng chém. Nhát xoay có cung kéo dài; nhát cuối phóng lưỡi liềm cyan với thân tối và cạnh sáng, không phải quả cầu sáng. |
| Heavy / Thunder Cleave | Heavy đẩy bụi theo hướng va chạm. Bản tích lực kéo tia điện về glaive; khi chạm, sét tách nhánh trong vùng tác động thật rồi tan thành bụi/rune vỡ. Không lặp sét ở mục tiêu không trúng. |
| Sigil Bolt / Barrage | Bolt có đầu rune dễ thấy và đuôi hạt phân mảnh. Barrage giữ rõ từng đường bay theo số projectile thực, không thêm bolt trang trí gây nhầm. |
| Root Tether / Cleanse | Tether là dây rễ có mạch cyan-vàng quấn quanh đúng mục tiêu. Cleanse rút Black Sap ra thành hạt tối, tách khỏi cơ thể rồi chuyển thành bụi sáng; không nổ tung sinh vật. |
| Dive | Bụi sát đất và vệt khí ngắn theo capsule; giữ thấy rõ động tác lăn native. |
| Warden's Judgement | Dash để lại từng mark theo simulation. Mark hiện có trật tự, kích hoạt đúng cue thực và tan thành nét rune; không bịa thêm chuỗi nổ hoặc đợt damage. |

**Khoảnh khắc chủ đạo:** glaive tích điện → Thunder Cleave chạm đất/mục tiêu → tia phân nhánh ngắn → bụi nặng rơi xuống.

### Yara — Ancient Heartroot

**Bản sắc:** xanh rêu sâu, nâu vỏ cây và hổ phách. Chuyển động mọc, quấn, nở và rơi. Quyền năng cổ xưa, hữu cơ; không dùng cùng khói/tia sáng với Aren.

| Kỹ năng hiện có | VFX đề xuất |
|---|---|
| Thornshot | Gai có thân và đầu rõ ràng, đuôi nhựa cây mảnh. Nhát seed cuối bung cụm gai đúng vùng burst, lá/phấn rơi chậm sau đó. |
| Root Spike / Heartroot Eruption | Rễ đi từ mặt đất lên theo hướng/vùng đánh thực. Đất tách và bụi bật ra trước khi rễ lùi/tan; tránh cột sáng che kín mục tiêu. |
| Sap Lance / Seed Storm | Lance là dòng nhựa hổ phách cô đặc, xuyên theo đường thực. Seed Storm giữ từng hạt theo projectile thật, có quỹ đạo và dấu va chạm riêng. |
| Binding Vines / Cleanse | Dây leo có nhịp siết vào thời điểm bind thực. Cleanse tách lớp Black Sap, để lại mạch sống và phấn ấm, không tạo cảm giác đốt cháy sinh vật. |
| Petal Step | Cơ thể tan theo cửa sổ vanish hiện có thành cánh lá/phấn, tập lại tại điểm đến thật. Không tự kéo dài thời gian mất thân hình hoặc bất tử. |
| Heartroot Bloom | Sigil rễ hữu cơ dẫn mắt tới từng seed rơi và pulse thực. Cánh hoa/rễ ôm mép field, giữ phần giữa đủ thoáng để nhìn hero và đối thủ. Không dựng cây lớn che chiến trường. |

**Khoảnh khắc chủ đạo:** mặt đất nứt theo rễ → ánh nhựa chạy trong khe → hoa/hạt bung thành từng nhịp của Heartroot Bloom.

### Vesper — Ink & Crimson

**Bản sắc:** mực đen pha tím sâu, cạnh lưỡi kiếm bạc-tím; crimson dành cho mark và đòn kết thúc. Tối nhất trong bốn hero, nét sắc và ít dư thừa. Giữ crimson hiện có, không đổi toàn bộ sang tím hoặc làm giống Black Sap.

| Kỹ năng hiện có | VFX đề xuất |
|---|---|
| Moonlit Iai / Crescent Rift | Vệt chém như nét bút mảnh, ôm sát đường katana. Mực tách thành sợi ngắn sau lưỡi kiếm; Crescent Rift để lại khe sáng hẹp dọc dash thực. |
| Shadow Step / Thousand Cuts | Shadow Step co bóng ở điểm rời và bật nét chém ở điểm đến thật. Thousand Cuts phân tách từng contact, giữ thấy phản ứng mục tiêu; không dùng quả cầu tím che toàn bộ chuỗi. |
| Kunai Fan / Shade Swap | Kunai vẫn nhìn rõ thân và ba đường bay. Shade có silhouette đọc được, điểm hoán đổi liên kết bằng sợi mực ngắn; không tạo thêm bản sao có vẻ gây damage. |
| Severing Shadow / Cleanse | Một nét cắt phá thế đánh, nhấn đúng interrupt thực. Cleanse rút sợi ô nhiễm ra khỏi mục tiêu, khác hình death mark/impact thông thường. |
| Mist Blink | Khói co vào thân tại điểm rời, bóng mỏng tại điểm đến; cả hai tan nhanh. Không rải màn sương đen dài che telegraph. |
| Crimson Requiem | Mark crimson rõ trên đúng các mục tiêu được chọn. Các vệt kiếm xuất hiện theo từng blink/contact thật; kết thúc mark vỡ như ấn mực rạn, không máu và không flash trắng toàn màn hình. |

**Death Mark:** số lớp dấu bám đúng stack thực; không dùng bộ đếm trang trí tự chạy. Mốc đủ stack có hình dạng rõ, không chỉ sáng hơn. Execution chỉ xuất hiện khi simulation xác nhận.

**Khoảnh khắc chủ đạo:** mực co lại → đường kiếm rất ngắn, rất sắc → ấn crimson vỡ đúng contact cuối.

### Sakda — Charcoal Impact

**Bản sắc:** than đen/nâu cháy, cam lửa, lõi vàng nhỏ. Đường lực xuất phát từ nắm tay, khuỷu, gối, ống chân và bàn chân. Không phủ lửa toàn thân khiến mất động tác Muay Thai.

| Kỹ năng hiện có | VFX đề xuất |
|---|---|
| Eight Limbs | Mỗi jab/elbow/knee/kick có vệt riêng theo đúng chi. Chạm tạo xung áp lực nhỏ và tro bật theo lực; roundhouse cuối có vòng ember gọn đúng vùng tác động. |
| Tempest Stomp / Flying Knee | Stomp đẩy bụi và vòng than hồng sát đất, chỉ ra bán kính thật. Flying Knee tập nhiệt quanh gối và vệt khí sau thân; impact tập trung tại contact, không nổ sớm trong charge. |
| Echo Wave / Hundred Elbows | Echo Wave dùng vòng sóng nén và mark dễ đọc. Recast lao tới đúng mục tiêu thật. Hundred Elbows nhấn từng hit bằng xung nhỏ; chiêu kết là điểm nhấn lớn nhất, không phủ toàn chuỗi bằng lửa. |
| Iron Clinch / Cleanse | Clinch dùng vòng lực ở điểm giữ và tàn than quanh tay. Cleanse gỡ Black Sap ra bằng mạch ember có kiểm soát, không thể hiện thiêu chết mục tiêu. |
| Guard Dash | Tấm khiên ember hình cung phía hướng lao, thể hiện rõ đang có shield. Hình còn/mất theo trạng thái thực, không sáng kéo dài sau khi shield bị phá. |
| Tiger's Wrath | Đề xuất silhouette hổ bằng ember/ribbon ngắn, gắn với đường đá và knockback thật. Đây là hình năng lượng cách điệu, không phải triệu hồi một nhân vật hổ hoặc thêm collider. Đường tro tan phía sau, không tạo mặt đất cháy giả gây damage. |

**Khoảnh khắc chủ đạo:** gối tích nhiệt → va chạm tập trung → sóng áp lực và tro bật ra, thân mục tiêu vẫn thấy rõ.

## 4. Sáu companion

VFX companion nhỏ và ít lớp hơn hero, thể hiện rõ **ai nhận lợi ích gì**. Không biến skill hỗ trợ thành một vụ nổ có vẻ gây damage lớn.

| Companion | Vai trò hiện có | VFX đề xuất |
|---|---|---|
| Koro | Wood / Healing | Mending Seed giữ hình hạt giống bay tới mục tiêu thực; khi heal được xác nhận, lá và mạch xanh hướng về hero. Không lặp heal flash khi cast chưa chạm hoặc không có hồi phục. Move Object dùng bụi đất tại tay/chân và điểm tiếp xúc, không quả cầu hồi máu. |
| Vara | Wind / Haste | Luồng gió cuộn dọc cánh khi lao xuống; boon hiện bằng sợi gió quanh chân hero. Mark Weakness giữ dấu mục tiêu riêng và sắc lightning đúng skill, không bị thay bằng Wind chỉ vì đó là nguyên tố chính của Vara. |
| Asha | Earth / Control | Charge Block có cung chắn đất/đá thấp, impact tại điểm chặn thật. Searing Pin giữ Fire phụ: vệt móng ember nhỏ và dấu pin ngắn. Không dựng lồng đá gợi cảm giác stun mạnh/kéo dài hơn thật. |
| Sable | Water / Slow | Undertow Flank có vệt nước xanh sâu theo cú vòng/lunge; khi slow thành công, dòng nước ôm thấp quanh chân mục tiêu và hết theo trạng thái. Không dùng băng cho skill Water. Distract vẫn được dùng Ice theo khai báo riêng. |
| Nyra | Lightning / Cooldown | Static Ambush là đường điện gãy ngắn theo cú pounce; khi giảm cooldown thực, một xung điện nhỏ nối nhịp về hero. Không giả thêm attack speed, damage hoặc reset toàn bộ skill. Search/Distract giữ Shadow phụ riêng. |
| Solkar | Fire / Power | Roar tạo lớp áp lực cong và ember, boon biểu hiện gọn quanh vũ khí/tay hero. Không biến roar thành nổ gây damage/heal. Search/Distract giữ Light phụ, không đổi tất cả thành Fire. |

**Field commands:** Follow/Stay/Recall/Focus/Search/Distract giữ feedback hình dạng dễ phân biệt; search chỉ đánh dấu trace/trap đã được engine phát hiện, không VFX tự phát minh đường đi hoặc phần thưởng. Tất cả 20 skill companion hiện có giữ nguyên element và hành vi khai báo.

## 5. Hiệu ứng chung và giới hạn

- **Cleanse:** có nhịp ô nhiễm được tách ra → ánh sống trở lại. Hình chung để người chơi nhận ra cùng một hành động; chất liệu viền khác nhau theo hero.
- **Black Sap:** có hình dạng hữu cơ bệnh lý riêng. Không dùng chính mẫu mark/slash của Vesper khiến người chơi tưởng hero đang bị nhiễm.
- **Hit / miss / block / immune:** khác phản hồi. Không hiện impact thành công khi đòn bị từ chối; không bịa burn, root hoặc lightning status từ particle trang trí.
- **Jump/double jump/landing:** giữ số lần bật và pose ghost theo trạng thái thật; bụi/ember/petal ngắn theo hero, không thêm nền phép thường trực.
- **Pause/slow motion/retry/load:** dùng world clock hiện có, không tạo RAF hoặc đồng hồ độc lập. Hết owner/scene thì clear; không phát lại hit cũ sau Continue.
- **Reduced Effects / Reduced Motion:** giữ dấu target, mark, vùng tác động và trạng thái cần thiết; giảm khói, ghost, rung/flash và lớp trang trí. Không dùng nhấp nháy làm kênh thông tin duy nhất.

## 6. Công cụ và asset miễn phí

**Chọn mặc định:** giữ hệ Three.js/pool hiện có; nâng atlas/flipbook và các kit hiện tại. Không thêm runtime mới chỉ để đổi hình thức. Hệ có alpha/additive, ribbons, debris và scope cancellation sẵn để tái sử dụng.

Nguồn nguyên liệu:

- [Kenney Particle Pack](https://kenney.nl/assets/particle-pack) — CC0; hạt, texture mask.
- [Kenney Smoke Particles](https://kenney.nl/assets/smoke-particles) — CC0; khói, bụi, tàn dư.
- [Effekseer Samples](https://effekseer.github.io/en/contribute.html) — chỉ dùng phần được ghi CC0; không mặc định áp dụng cho mục Sample Effects (Old). Công cụ [Effekseer](https://effekseer.github.io/en/) có thể dùng author/export animation 2D thay vì buộc thêm runtime playback.
- [OpenGameArt: Animated Particle Effects #2](https://opengameart.org/content/animated-particle-effects-2) — bộ cụ thể CC0; không suy rộng license cho toàn site.
- [three.quarks](https://github.com/Alchemist0823/three.quarks) — thư viện MIT, là lựa chọn thay thế nếu thực sự cần workflow particle editor; chưa đề xuất cài song song với pool hiện tại.

CC0 không đồng nghĩa texture đã phù hợp art direction. Mọi asset đưa vào game cần lưu nguồn, license, bản gốc và bản chỉnh; chỉ phân phối atlas/runtime đã chọn. Không tải cả kho vào build, không thêm provider trả phí trong proposal này.

## 7. Trình tự thực hiện đề xuất

1. **Chốt ba mẫu chuẩn:** Vesper Moonlit Iai + Mist Blink; Aren Thunder Cleave; Koro Mending Seed. Ba mẫu lần lượt chứng minh bóng tối/trail, impact/telegraph, và support nhận lợi ích thật. Duyệt clip native trong scene trước khi nhân rộng.
2. **Hoàn thiện bốn hero:** toàn bộ sáu nhóm action mỗi hero, tap/hold, projectile/contact, marks, Cleanse và movement feedback. Nhất quán chất liệu nhưng không dùng một emitter đổi màu cho mọi chiêu.
3. **Hoàn thiện companion:** toàn bộ 20 skill hiện có, cả hỗ trợ chiến đấu và field commands, giữ từng nguyên tố phụ.
4. **Tích hợp và nghiệm thu:** kiểm tra phối hợp hero + companion + enemy telegraph, hủy chiêu/đổi scene/pause/load, Reduced Effects và hiệu năng. Không kết luận hoàn thành từ selector preview hoặc test CPU đơn lẻ.

Mẫu chuẩn là cổng duyệt art direction, không phải phạm vi giao hàng bị thu nhỏ. Proposal đầy đủ vẫn bao gồm cả bốn hero và sáu companion.

## 8. Tiêu chí nghiệm thu

- Nhìn silhouette, chuyển động và vật chất nhận ra bốn hero ngay cả khi không dựa vào màu.
- Thấy rõ tay/chân/vũ khí và phản ứng đối thủ tại contact. Telegraph nguy hiểm không bị VFX hero/companion che mất trong góc camera gameplay.
- Mọi release/contact/mark/status bám simulation. So sánh hit, miss, block, immune, cast bị ngắt và hết buff; không có thông báo hình ảnh về lợi ích chưa xảy ra.
- Không thấy vết nối atlas, hình vuông khói, sprite xuyên mặt đất gây nổi bật hoặc dấu nền sai tầng địa hình.
- Chạy native scene ở Greenwake và Canopy; kiểm tra bốn hero, sáu companion và các nguyên tố phụ. Có clip before/after cùng camera, cùng ánh sáng và cùng kịch bản, kèm capture lúc đông hiệu ứng nhất.
- Kiểm tra Reduced Effects/Motion, pause/resume, retry, chuyển scene và load: không hiệu ứng tồn dư, bật lại sai hoặc tiếp tục chạy sau pause.
- **Mục tiêu hiệu năng đề xuất, chưa đo:** trên cùng máy/browser, độ phân giải, setting và kịch bản, p95 frame time sau nâng cấp không cao hơn baseline quá 10%. Ghi rõ tổng frame time, GPU time nếu công cụ hỗ trợ, draw calls, particle/slot peak và bộ nhớ; không tự coi 60 FPS là đã đạt khi chưa có baseline. Nếu vượt, ưu tiên bỏ lớp trang trí/giảm overdraw, không bỏ telegraph hoặc feedback bắt buộc.
- Không regeneration/re-rig model, không thay quyền điều khiển camera, không đổi gameplay/save. VFX/asset mới không tự được coi là release-verified vì build thành công.

## 9. Đề xuất chốt

Chọn **Dark, Living, Forceful**: tối ở chất liệu và khoảng nghỉ; mạnh ở đường lực và contact; sinh động ở chuyển động riêng từng nguyên tố. Vesper đen/tím/crimson; Aren cyan bão/vàng cổ; Yara rễ/hổ phách; Sakda than/ember. Giữ sáu companion đọc rõ vai trò hỗ trợ, không cạnh tranh với hero bằng kích thước vụ nổ.

Chưa có thay đổi runtime, thư viện hoặc asset nào được thực hiện theo proposal này. Cần duyệt art direction trước khi triển khai các mẫu chuẩn.
