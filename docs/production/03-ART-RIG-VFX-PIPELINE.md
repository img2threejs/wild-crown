# Wild Crown — Art, Tripo, Rigging, Animation, Environment và VFX

Liên quan: [Master plan](01-MASTER-PLAN.md), [Implementation](02-IMPLEMENTATION-AND-AGENTS.md). Tất cả asset/gate production dưới đây là kế hoạch, chưa được thực hiện. Ba ảnh trong `concepts/` là synthetic candidates đã sinh, không phải approved production references.

**Đã xác nhận với người dùng:** stylized cinematic; phi sát thương, không gore. Animation/VFX của Aren với poacher thể hiện đánh gục/khống chế, không lethal finisher, dismemberment hoặc blood spray. Giữ chất bi kịch qua diễn xuất, môi trường và backstory. Hướng mỹ thuật đã khóa; ảnh cụ thể vẫn phải sửa các lỗi nêu dưới đây rồi duyệt trước Tripo.

## 1. Quyền sở hữu pipeline và nguồn model

Người dùng đã chọn **GLB TripoAI trực tiếp**. Đường chuẩn:

```text
Codex GenImage candidate
→ art-direction review
→ identity-locked reference views
→ Tripo image/multiview generation
→ immutable source GLB + provider provenance
→ cleanup/retopo/material/LOD derivatives
→ rig + skin + authored/retargeted clips
→ native GLTFLoader import
→ measurements + visual + gameplay review
→ production manifest publish
→ region streaming
```

- Models nhân vật, động vật và props authored có nguồn Tripo; không âm thầm thay hero bằng primitives hoặc model từ provider khác.
- Terrain, collision proxies, scatter/layout, water surface và VFX là game systems có thể procedural. Tripo trees/rocks/cages vẫn giữ external-asset provenance dù layout do code tạo.
- `img2threejs` quản lý staged procedural work phù hợp và cung cấp vocabulary/tools đo; không gọi imported GLB là independently reconstructed procedural model.
- Environment code-only pass không chứng nhận imported GLB. Mixed scene cần game integration acceptance riêng; nếu muốn plugin hỗ trợ imported subjects phải có adapter contract/evidence mới, không khai sai inventory để pass.
- Generation offline; runtime không có Tripo/GenImage/TypeSafe secret. Không bắt game gọi dịch vụ AI khi người chơi đang chơi.

## 2. Concept direction: ấn tượng bằng silhouette và hành vi

Phong cách: stylized cinematic, tỷ lệ thú gần thật, khối lông rõ, texture vừa đủ; không dùng fur simulation dày làm điều kiện đẹp. Mỗi character có ít nhất ba identity anchors nhìn được ở camera gameplay và một contrast về hành vi trước/sau khế ước.

| Nhân vật | Identity anchors đề xuất | Diễn xuất/rig phải giữ |
|---|---|---|
| Aren | Áo ngắn bất đối xứng xanh rêu/ochre; dấu root ở tay trái; gậy thu gọn | Thân mềm cho acrobatics, tay đổi grip, ánh mắt lắng nghe trước khi ra hiệu |
| Yara | Vai/cổ tay có dấu nghề Warden; gỗ cũ và linen sáng; seed knot motif | Bàn tay từng làm Crown, hesitation/guilt; transformed wood statue vẫn nhận ra silhouette |
| Orun | Mặt người già đau buồn; crown rễ đứt sáu nhánh; rib-like empty chest | Phase 1 là Warden thật; mirror dodges; Crowned Beast là form riêng có transition authored |
| Marek | Dáng hunched thực dụng; dụng cụ bẫy/thủy tinh chứa Sap; một tay bảo vệ sample | Không dùng mặt “ác” thay storytelling; variant repentant thay posture/equipment |
| Vara | Hornbill casque mạnh, mỏ ngà/đen, patch cánh amber | Wing fold/perch/dive rõ; không humanoid expression |
| Koro | Vai/tay tạo silhouette dễ đọc, crest lông, đuôi nếu species lock có | Ground + climbing + grip; nghịch/ngờ vực → hợp tác, không copy biped run |
| Asha | Shoulder mass bảo hộ, stripe như nhánh sông, muzzle scar | Stalk/pounce/scapula/paw plant; nhìn Tali và thay tension bằng chuyển động thật |
| Tali | Tỷ lệ cub đầu/paw/lưng riêng; stripe echo Asha | Play/stumble/nuzzle; không scale nhỏ rig hổ trưởng thành |
| Ruun | Vai nặng, fur cổ bạc, một tai sẹo | Gait có tuổi nhưng vẫn mạnh; không skin trẻ rồi đổi màu |
| Luma | Silhouette gọn, tail/ear alert, contrast lông sáng | Đổi hướng nhanh, tín hiệu scout, quyền lãnh đạo khác Ruun |
| Sable | Fur tối/mảng cổ định danh, low tracking posture | Nose tracking, flank/hold, howl; distinct from Ruun/Luma |
| Nyra | Khối đen có roughness breakup đọc được, rosette hiện khi nghiêng sáng | Stealth crouch, spine stretch, rear attack; không mất vào background đen |
| Solkar | Bờm như mặt trời có negative space, scar/regal muzzle | Roar có breath/torso mechanics; Dominion rigid symmetry → Bond relaxed authority |
| Ghor | Jaw/tail profile dài, bùn/Black Sap ở scutes | Crocodilian belly/contact/water transition; không quadruped mammal retarget |
| Crowned Beast | Sáu aspect quanh một lõi Orun còn nhận diện | Silhouette mỗi phase/attack rõ; không chồng sáu con vật thành mớ chi tiết |

### Ba ảnh đã tạo trong lượt planning

Provider tool trả về `openai-codex`, model thực tế `gpt-image-2-codex`, quality medium:

- [Aren candidate](concepts/aren-candidate.webp), 1024×1536.
- [Asha candidate](concepts/asha-candidate.webp), 1536×1024.
- [Orun candidate](concepts/orun-candidate.webp), 1024×1536.

Đã xem trực tiếp cả ba. Đây là direction probes, **chưa duyệt**:

- Aren: giữ được cropped outfit, staff và mark trái; đang cầm gậy nên cần neutral A-pose không gậy để Tripo không dính ngón/staff.
- Asha: silhouette/paw/tail rõ ở một góc; fur hơi thiên chi tiết/realistic, cần giản lược khối để đồng bộ cinematic stylization. Chưa có bằng chứng stripe/back-view consistency.
- Orun: face/crown/root chest có hướng tốt; ảnh sinh thêm áo choàng dài, không phù hợp mirror acrobatics. Production concept phải đổi thành lớp vai/lưng ngắn hoặc panels cắt cao trước khi tạo mesh. Không rig quanh lỗi áo choàng rồi gọi hoàn thành.

Prompt-only generation không gửi workspace image. Khi edit/reference-conditioned bằng ảnh workspace, phải kiểm tra policy consent tương ứng trước từng call; không coi yêu cầu tạo ảnh là quyền tự cấp mọi consent của plugin.

## 3. GenImage production protocol

### 3.1 Một asset packet, không một ảnh đẹp

1. Art brief: vai trò truyện, gameplay scale, camera distance, species, ba identity anchors, constraints rig.
2. 2–3 candidate silhouettes cho hero quan trọng; review chọn một identity, không trộn mặt của nhiều candidate.
3. Front/side/back riêng, neutral light/background và cùng tỷ lệ; additional 3/4 chỉ để kiểm shape, không gửi contact sheet có nhiều người như một object image.
4. Biped A-pose với fingers/palms tách, tóc ngắn, phụ kiện/staff plate riêng. Quadruped stance bốn chân đọc được, tail tách body. Bird: body neutral và wing-spread sheet riêng để rig, không coi hai hình khác shape là cùng model đã khóa.
5. Detail plates: face, hands/paws, joint folds, markings, staff sockets. Mọi hidden side chưa quan sát ghi inferred.
6. Human review anatomy/identity/chirality/material consistency. Reject extra digits, fused limbs, inconsistent stripe landmarks, asymmetry ngoài chủ ý.
7. Hash prompt/output/reference approval; lưu synthetic provenance và license/terms cần xác nhận, không giả ảnh AI là scan thực tế.

### 3.2 Prompt recipe sử dụng lại

Không dùng tên nhân vật IP bên ngoài làm style shortcut. Cấu trúc prompt: original subject + story temperament + measured silhouette requirements + movement constraints + neutral pose + separate prop + neutral studio + negative constraints.

Ví dụ Aren production: “Original young adult forest mediator, compact asymmetric moss-and-ochre jacket, left forearm branching mark, exposed shoulder mobility, fitted trousers, short hair, neutral A-pose, fingers clearly separated, no staff in hands, full body, plain gray, neutral soft lighting, consistent approved identity, no cape, no armor skirt, no particles.” Reference conditioning chỉ khi có consent/quyền sử dụng đúng workflow.

### 3.3 Gate before Tripo spend

Art lead duyệt identity sheet; technical artist duyệt anatomical separation/deformation feasibility; game lead duyệt silhouette tại mock gameplay camera. Thiếu back view quan trọng = request/refine, không phỏng đoán thành approved hidden geometry.

## 4. TripoAI: capability đã tra và điều chưa chứng minh

Context7 lookup không trả về thư viện Tripo phù hợp; đã chuyển sang official developer docs qua web research. Không dựa vào kết quả tên thư viện gần giống.

Tài liệu đã tra:

- https://developers.tripo3d.ai/en/docs/generation-image-to-model
- https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard
- https://developers.tripo3d.ai/en/docs/animations-rig-check
- https://developers.tripo3d.ai/en/docs/animations-rig
- https://developers.tripo3d.ai/en/docs/animations-retarget
- https://developers.tripo3d.ai/en/docs/models-texture

Docs mô tả generation image/multiview, rig-check, auto-rig và retarget dạng async tasks. Quadruped docs có `rig_type: quadruped` với rig model `v2.5-20260210`; preset được tìm thấy cho quadruped là `preset:quadruped:walk`. **Không suy ra có sẵn pounce, claw, roar, tiger gait hay bird/primate rig.** Generation và rig model là hai version namespace khác nhau.

P0/P1 phải xác nhận actual account, endpoint/model hiện hành, quyền thương mại, quota, output formats và rig-check trên canary. Không có live Tripo task trong planning này; không có giá/cost quote được kiểm chứng.

### 4.1 Offline producer tasks

- `TRIPO-01` generation Aren/Asha canary theo approved single/multiview references; persist task IDs, params, model/version, timestamps, terminal response và downloaded outputs.
- `TRIPO-02` inspect geometry, UV/material slots, hidden surfaces, fused parts, fingers/paws, orientation, dimensions. Source immutable.
- `TRIPO-03` rig-check rồi auto-rig khi family được provider support; import rigged result để đo, không tin task success là rig success.
- `TRIPO-04` optional base idle/walk from supported presets; custom combat/traversal/story clips authored offline khi preset thiếu.
- `TRIPO-05` publish production derivatives chỉ sau gates. Download outputs về asset store, không ship URL tạm của provider.

Async job registry tránh generate lại khi agent resume: submitted/running/succeeded/failed/canceled, input hash, provider task ID, output hash. Poll theo provider guidance; generation retry có charge không tự diễn ra vô hạn. Hết quota/auth/schema error báo rõ. Secrets trong secret manager/local protected environment, không vào manifest/client/source control.

### 4.2 Source → derivative integrity

Retopo, cleanup, UV seam sửa, LOD, texture bake thực hiện trước geometry freeze của derivative. Mỗi LOD có source chain và hash riêng. Sau freeze rigging chỉ thêm/cập nhật rig/skin data được cho phép; sửa vertex phải mở geometry revision mới và invalidate dependent captures. Không re-freeze để che parity fail.

Native GLB đã rig hợp lệ: bảo toàn skin joint order, inverse binds, node transforms và animations từ importer; **không rebind identity chỉ vì một emitter khác dùng identity**. Coordinate normalization ở parent instance; record conversion. Manifest chốt meter/Y-up và forward axis rõ; adapter đổi sang canonical gameplay frame một lần, không flip trái/phải ngầm.

## 5. Rig families và clip inventory

### 5.1 Families

| Family | Actors | Bổ sung ngoài auto-rig |
|---|---|---|
| Human biped | Aren/Yara/Orun/Marek/poachers | Clavicle/twist/wrist/ankle, staff two-hand grips, gaze/face, hit reactions, acrobatics |
| Felid quadruped | Asha/Nyra/Solkar | Scapula, spine compression, paw IK/contact, tail/jaw, proportions retarget calibration |
| Canid quadruped | Ruun/Luma/Sable | Gait/neck/ears/hold bite, pack turns, separate stride calibration |
| Cub | Tali | Juvenile proportions, play contacts, bespoke retarget offsets |
| Primate | Koro | Hand grip, tree locomotion, hanging/pull/throw, tail only if species has it |
| Avian | Vara | Wing chain/fold/feather groups, tail fan, feet perch, takeoff/landing |
| Crocodilian | Ghor | Belly/short limbs/tail/jaw, crawl/swim/submerge |
| Bespoke hybrid | Crowned Beast | Form-specific hierarchy, attack sockets, safe core exposure, animated bounds |

Reusing family ≠ universal retarget. Every actor has rig version, node correspondence, root curve, contact windows, motion bounds and before/after comparison. Staff/eyes/armor có thể rigid bone attachments; G6 không bắt tất cả visible mesh phải skinned.

### 5.2 Aren coverage

Mandatory evasion matrix giữ đủ Bible §14.9:

1. Quick Step Left; 2. Quick Step Right; 3. Forward Shoulder Roll; 4. Back Handspring; 5. Left Cartwheel; 6. Right Cartwheel; 7. Forward-left Dive Roll; 8. Forward-right Dive Roll; 9. Back-left Pivot Roll; 10. Back-right Pivot Roll; 11. Low Slide; 12. Staff Vault; 13. Perfect Dodge Left; 14. Perfect Dodge Right; 15. Dodge Recovery; 16. Hard Landing; 17. Stumble Recovery.

Thêm locomotion idle/jog/run/start-stop/turn/strafe fwd-back-side; light1–3; heavy/charged-heavy/release; tether start/hold/break; counter variants; hits front/back/side; stagger/defeat/recover; command/ask; cleanse start/hold/complete; vault/ledge/swing/slide traversal; staff compact/extend; story listening/reaching/reunion.

Mirroring chỉ giảm authoring khi handed staff, chirality, root curve, contact và sockets được kiểm cả hai hướng. Không nhân tên clip để giả coverage. Loop không default Repeat: idle/gait cần continuity evidence; attack/dodge/cleanse one-shot với exit policy.

### 5.3 Creature coverage

| Actor | Gameplay clips phải author/verify | Story/relationship clips |
|---|---|---|
| Asha | idle/stalk/walk/trot/run/turn, pounce, claw chain, charge, roar, stagger, hit, block charge, follow | corrupted tension, tether restraint, cleanse, recognize Tali, nuzzle, bonded rest |
| Koro | ground/tree locomotion, climb/grab/hang, rock throw, log sweep, leap, pull lever, drop object | suspicious test, fear, cooperation signal, seed sharing |
| Vara | fly/glide/turn/dive, mark, takeoff/land/perch | injured/recover, alarm, voluntary return |
| Ruun/Luma/Sable | walk/trot/run/turn, bite/hold, pounce, stagger, howl, flank transitions | age/faction posture, pack negotiation, reunion |
| Nyra | stalk/crouch/run/leap, ambush, counter assist, wall/branch contextual route | watch from cover, reveal innocence, voluntary approach |
| Solkar | stride/turn, claw/charge/leap slam/roar, stagger/suppression | regal control, exile depart, voluntary rally |
| Ghor | crawl/swim/turn/submerge/surface, tail sweep/bite/lunge, water charge, stagger | corruption release, river retreat |
| Tali | walk/trot/play/stumble/hide/nuzzle/look/follow safe route | reunion, hub growth beats, rescue; no combat targeting |
| Orun | biped combat mirror, tether, dodge/counter, suppression | grief, offer crown, relinquish; Crowned Beast separate set |

Every combat clip includes anticipation/commit/active/cancel/recovery, relevant footfalls/landing and VFX sockets. Animators propose markers; combat owner approves authoritative windows. Animation speed changes within validated bounds only.

## 6. Character evidence and quality gates

### 6.1 Native GLB route adapter prerequisite

Official plugin-character 0.2.0 has missing G1/G3/G6/G10 producers and nonblocking aggregate. Build a **game-blocking evidence adapter**, not a fake gate toggle:

- Export live loaded production GLB scene node/skin graph, inverse binds, skin indices/weights, clip sample transforms, attachments, raw mesh buffers and render evidence.
- G1 bindingSamples: disconnected track negative control must fail; measure all clips at >=5 times plus marker/transition boundary samples.
- G3 bindRestore: stop/reset/switch must restore intended pose without blend bleed; compare correct local/world spaces and quaternion equivalence.
- G6 meshVisibility: full inventory of deforming skinned, rigid attached and static scene meshes; each follows its declared policy. Missing body part cannot hide behind counts.
- G10 integrity sweep: clip/time/angle poses, occlusion/holes/tears/creases with valid same-asset controls. Do not copy example measurements or require irrelevant blend-off controls for an unmodified native skin.
- G11 freeze parity on exact derivative, not raw source versus retopo LOD. G12 joint correspondence/reference integrity when applicable.

Calibrate tolerance on actual Three.js importer/runtime and compressed/decompressed production artifact. Numerical thresholds such as 2^-23/1e-12 from a custom emitter are not universal native-glTF tolerances. Record precision, interpolation, root-motion/IK stage and comparison spaces.

**Species applicability:** a biped-specific gait/landmark check cannot pass a bird/crocodile by inventing human landmarks. Applicable plugin rows require current pass. Non-applicable rows keep explicit typed reason and equivalent species evidence under a separate Wild Crown acceptance contract; do not report this as raw plugin 12/12 pass. Aggregate/missing/error/stale never silently qualifies an asset.

P1 negative controls: disconnected clip, pose bleed, unbound torso, swapped joint index, broken hand/foot contact, mirrored wrist, torn skin, wrong LOD bind, wrong culling bounds. Each must fail its intended check before trusting known-good pass.

### 6.2 Visual proof

- Neutral studio front/rear/left/right/three-quarter pair plus detail face/hands/paws; actual gameplay rail views.
- All identity anchors inspect separately; average score cannot compensate missing face/stripe/scar.
- Stress extreme poses for every action family and both directions; feet/hands/staff contacts; no visible tearing/inside-out sections.
- Ground contact target initial <=0.01H during declared planted windows; landing target <=0.1m only where gameplay spec permits. Airborne/swimming windows do not use grounded-foot threshold.
- Animated bounds sampled across clips and blends; no disappearing wing/tail at frustum edge; do not globally disable culling to hide bad bounds.
- Closeup facial controls support story; no human mouth speech animations for animals.

### 6.3 Asset budgets

Initial allocations, profile before final lock: hero/boss 25–45k triangles LOD0, secondary 10–20k; roughly <=80 deform bones hero/boss and <=48 secondary when anatomy permits; 2K hero textures, 1K secondary, texture arrays/atlases only if actual tooling supports them. These numbers do not override a required wing/tail rig: optimize total scene, then remeasure.

LODs are real artifacts with silhouette/skin/contact checks, not aliases to high. KTX2/meshopt/other GLB compression chosen only after compatibility spike; loader decoder version ships with game. Keep no duplicate base64/TS copies of full source mesh.

## 7. Environment production and Jev

### 7.1 Scene inventory

Slice baseline: 4–6 tree variants, 3 bamboo, 4 rock, ground/grass, bridge, cage, hunter camp, gate, roots/ruins, stream/waterfall, Asha arena. Full game adds pine/ice/cave, marsh water/reeds, savanna/temple, Hollow root architecture, hub stages/refuge/ending set dressing.

Authored object meshes come from Tripo. Layout/terrain/water/collision/nav/camera are authored code/data. A scene manifest distinguishes procedural subject IDs, imported subject IDs and instanced placements, avoiding hidden subjects in quality reports.

### 7.2 Environment gate qualification workstream

Current `ADAPTER_PROFILES`: room qualified; street/vegetation-cluster/building-exterior unqualified. New support requires more than changing a boolean:

1. Rights-cleared reference scenes and approved subject inventory for a vegetation cluster.
2. Versioned evidenceMatrix matching 12 canonical checks, exact reference hashes, source/evaluator revision, metric methods/tolerances, required camera views and units.
3. Positive/negative/unknown fixtures: scale drift, floating trunks, foliage occlusion, ground mismatch, wrong material, absent provenance, stale render.
4. Actual local renders/typed measurements + independent review; synthetic values remain targets, not measurements.
5. Separate qualification for applicable biome variants; vegetation-cluster pass is not automatic water/fog/cavern acceptance.
6. Game mixed-scene test verifies external GLBs, terrain, occlusion, nav, camera and attack readability. Explicitly publish scope of plugin pass.
7. Fresh canonical Environment gate decides scene acceptance for supported scope; unknown/unqualified is not “almost pass”.

Task dependencies must preserve this track through release. If qualification cannot be completed, report blocked criterion and obtain explicit user scope decision; do not silently drop Environment/Jev requirement.

### 7.3 Jev flow

- Start shadow mode; recommendations recorded, baseline unchanged.
- Only route a fresh complete failed Environment snapshot with all 12 rows evaluated, correct hashed dependencies, no missing/conflicting/incomparable evidence and supported scene kind.
- Current live routing room-only; forest routing must be separately qualified along with exporter/router/outcome fixtures. Do not send vegetation using room label.
- Prepare structured bounded observation; no images/source bytes/credentials/path disclosures in provider payload. Consent is per canonical workspace.
- Provider error/pass/unknown/stale/partial means no fallback/retry to manufacture advice.
- Assist is opt-in; human reviews exact candidate patch and before snapshot. Use approved application boundary, no agent manually applying equivalent edit after approval.
- Rerender/re-evaluate Environment after repair; Jev confidence is not calibrated success probability and never acceptance authority.
- No auto/auto-safe, no automatic hooks. Default correction ceiling <=3/pass and <=6 total; stricter controller wins.

Separate consents: Environment workspace-image processing and Jev structured disclosure. Only user grants/revokes. Recheck per call where required. Text-only GenImage candidates are outside workspace-image upload consent but are still unapproved synthetic art.

## 8. VFX art bible: kể chuyện bằng hình, không particle spam

### 8.1 Ngôn ngữ

- **Heartroot:** amber/ivory branching paths, organic asynchronous pulses, energy flows in both directions.
- **Bond:** two-way exchange, distinct animal motif preserved, open loops that connect then release. Không xiềng/collar.
- **Dominion:** convergent lines into a single authority, rigid radial symmetry, compressed motion and silence; lợi ích mạnh nhưng unsettling.
- **Black Sap:** oily near-black with restrained warm/red glints, directional veins that amplify pain/fear; not universal purple evil smoke.
- **Instinct/Perfect Dodge:** thin temporal silhouette and brief time dilation; player/boss feet stay readable.
- **Restoration:** ecological sequence: water clears → roots relax → seeds/foliage respond → animals/audio return. Không chỉ color grading xanh hơn.

### 8.2 VFX cue matrix

| ID | Story/gameplay meaning | Anticipation → active → decay | Anchors/logic | Accessibility |
|---|---|---|---|---|
| FX-SAP | Orun emotion/control | veins tighten → directed surge → sticky residue retract | surface mask + true hazard footprint | shape/rhythm, not hue alone |
| FX-ECHO | Listening to memory | local ripple → sparse sensory fragments → dissolve | interactable source; pauseable subtitle phrase | readable text + no mandatory flash |
| FX-MARK | Vara lends perspective | wing cue → landing/weakness outline → release | actual committed landing, not guessed future position | edge shape + icon/audio |
| FX-TETHER | Restraint for rescue | root reaches → taut pair of endpoints → release | staff socket→target anchor; cancel clears rope | contrast strand, no screen veil |
| FX-PERFECT | Reading danger precisely | near miss edge → thin afterimage + 0.15–0.3s slow → fade | successful authoritative event only | reduced motion removes trails, retains counter cue |
| FX-POUNCE | Protective force distorted | bamboo bend/shadow → impact ring → dust strips | frozen commit footprint, contact normal | full ground footprint always visible |
| FX-ROAR | Territorial pressure | chest/breath ripple → expanding cone → air decay | cone math same as gameplay | visible bands + directional audio/subtitles |
| FX-WAVE | Corruption below ground | root bulges → traveling low ring → ground cracks fade | wave speed/radius authoritative | height cue distinct from body sweep |
| FX-CLEANSE | Restore self-control | steady root braid → sap peels outward → breath/clear eyes | cleanse phase, not timer alone | no explosion/whiteout obscuring Tali |
| FX-BOND | Voluntary alliance | animal initiates motif → reciprocal pulse → open orbit | two actors retain separate identities | soft/slow pulse, option reduced bloom |
| FX-DOMINION | Power removes choice | crown glyph converges → constrained spokes → suppressed idle | choice commit and controlled status | angular motifs/pose + audio silence |
| FX-RESTORE | Habitat repairs | channels reopen → local growth → ambient life | region state delta, safe nav/collision commit | staged effects, no rapid camera shake |
| FX-GROVE | Past decisions turn against Aren | interrupted Bond pulses → Crown pulls inward → broken links | possession windows, pillar objectives | allies remain identifiable/nonlethal UI |
| FX-MARCH | Alliance not army command | distant separate rhythms → shared cadence → settle | actual faction presence, low-cost crowd | cinematic skip retains result |
| FX-CROWN | Final philosophical choice | six motifs orbit → selected ending pattern → stable outcome | ending predicate + explicit player selection | readable motifs without color dependency |

### 8.3 Bespoke boss/environment effects

- Koro: log trajectory marked by disturbed leaves/shadow; twig impact is a spatial clue, not dense debris wall.
- Asha: bamboo “breathes” before unseen pounce; corrupted trail is torn resin, bonded pounce replaces it with dust/leaf wake. Tali reunion ends combat music before celebratory flourish.
- Ruun: three-beat howl visual rhythm across ice; chains transmit Sap phase-locked; unsafe ice readable before break.
- Ghor: submerged displacement ripple and sediment plume preserve contact hints; no opaque water hiding an unavoidable bite.
- Nyra: silhouette suppression only outside mandatory player cues; rear-counter leaves a thin negative-space streak.
- Solkar: circular sun-mane breath becomes straight coercive spokes; Bond rally radiates open arcs, exile scene removes central motif without erasing ambient life.
- Orun: mirror Aren’s root motifs in one-way flow; Crowned Beast alternates aspect silhouettes rather than stacking all motifs simultaneously. Living Pact ends with six distinct pulses, Dominion with one synchronized pulse, Severance with dispersed unsynchronized glimmers.

### 8.4 Technical VFX contract

`VfxCue` owns stable event/action instance ID, sim tick/phase, anchor/socket, footprint, priority, pool class, seed, lifetime, cancellation scope and reduced-effects variant. Gameplay owns truth; VFX never chooses hit time/range or commits world state.

- Preallocate repeated emitters; shader/instanced ribbons/decals before dense particle sprites when clearer.
- Telegraphs highest priority and reserved capacity; pool exhaustion drops cosmetic sparks first.
- Screen-space opacity/overdraw cap; guard silhouette/feet/landing zones.
- Cancel action, unload region, death/retry, skip cinematic and reload dispose all related cues; no orphan Sap hazards rendered after collision removed.
- Baseline and reduced mode keep same spatial information. Bloom/shake/trail intensity independently adjustable; avoid rapid flashes.
- Markers measured from motion, not guessed from animation clip names. Verify cue alignment within one 60Hz simulation tick at normal/slow/time-resume conditions.

## 9. Audio and UX integration

Every dangerous attack needs distinct body/environment/audio cue, with text/visual substitute for directional audio. Mixer buses: dialogue/Echo, combat cues, companions, ambience, music, UI. Duck cosmetic/music under warnings, not opposite.

Adaptive music follows authored state, not constant fight-or-flight volume: Sap pulse under scarcity; each restored community adds layer; Grove rupture removes familiar layers; March returns separate motifs before final cadence. Audio production may use licensed/authored sources; tool/provider selection and rights recorded, not implied generated in this plan.

HUD: vitality, dodge charges, Instinct, current companion special, Ferocity/Corruption, targeting/offscreen cue. Journal exposes covenant obligations/history and world consequences without requiring a wiki. Animals communicate via sensory phrases, not long human lip-synced dialogue.

## 10. Production acceptance packet

Each asset/scene handed off with: approved concept refs; source/derivative hashes; provider/rights; geometry/rig/clip/LOD manifests; actual native-loader measurement results; applicability declarations; visual captures; tested actions/transitions; budget readout; unresolved defects; owner/revision. No “animation-ready” label based only on skeleton existence.

Every region packet adds: corrected canon objectives; camera rails; collision/nav data; required/optional companions; present/absent cinematic variants; restoration delta; save checkpoint behavior; attack/VFX/audio readability proof; Environment gate scope and mixed-scene game QA. No final-art mass rollout before Aren and Asha canary packets pass in actual browser runtime.
