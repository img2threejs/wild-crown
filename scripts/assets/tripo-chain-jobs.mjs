// Job tables for scripts/assets/tripo-greenwake-chain.mjs, one entry per playtest map.
// A job describes one asset: concept prompt (or an existing concept image), decimation face limit and,
// for animated assets, the rig type, optional extra rig parameters and the retarget preset batches.
export const STYLE = 'Stylized cinematic 3D game asset, hand-painted PBR texture style, strong readable silhouette, chunky sculpted forms. Plain pure white background, soft even studio lighting, no ground shadow, no text, no watermark.';
const QUADRUPED_POSE = 'Full body side three-quarter view, standing in a neutral stance on four straight separated legs, all four feet visible, tail visible, mouth closed, realistic animal proportions.';

// Tripo rig v2.5 accepts only the body-specific walk preset for quadrupeds (generic presets
// return 1004 on quadruped rigs); the remaining monster clips are authored offline on this rig.
const GREENWAKE_BATCHES = { quadruped: [['preset:quadruped:walk']] };

export const MAPS = {
  greenwake: {
    log: 'asset-source/generated/greenwake-sprint1-tripo-log.jsonl',
    batches: GREENWAKE_BATCHES,
    jobs: {
      'actor-ember-boar': {
        concept: 'Stylized cinematic 3D game creature concept, full body side three-quarter view. A corrupted Ember Boar: massive muscular wild boar with chunky sculpted dark umber fur clumps, a bristled mane ridge split by glowing molten-orange ember fissures like cooling lava, oversized curved ivory tusks with burning orange cracks, small smoldering ember vents on the shoulders, faint drips of black tree sap, glowing amber eyes. Standing in a neutral stance on four straight separated legs, all four hooves visible, tail visible, mouth closed. Strong readable silhouette, hand-painted PBR texture style, realistic animal proportions. Plain pure white background, soft even studio lighting, no ground shadow, no text, no watermark.',
        existingConcept: 'asset-source/generated/actor-ember-boar-concept-01/tripo-out/ember-boar-concept-01-19852d96/generated_image.png',
        faces: 20000, rig: 'quadruped',
      },
      'actor-frost-sap-stalker': {
        concept: `A corrupted Frost Sap-Stalker creature: a lean long-legged lynx-like forest predator with a long neck and long tufted ears, pale blue-grey and teal blocked-out fur, clusters of translucent icy-blue frozen tree-sap crystal spikes growing along its spine, shoulders and tail tip, swollen venom-green sap glands under the jaw, frost-rimed paws with dark claws, glowing cyan eyes. ${QUADRUPED_POSE} ${STYLE}`,
        faces: 20000, rig: 'quadruped',
      },
      'actor-root-rammer': {
        concept: `A corrupted Root Rammer creature: a hulking forest ram-bison hybrid with a massive humped shoulder, short thick legs and heavy hooves, huge spiraling curled horns woven from gnarled living tree roots, mossy bark-like armour plates and embedded cracked stones along its back, shaggy dark olive fur, glowing yellow-green sap veins between the bark plates, ember-hot cracks at the horn bases, glowing green eyes. ${QUADRUPED_POSE} ${STYLE}`,
        faces: 20000, rig: 'quadruped',
      },
      'prop-greenwake-root-gate': {
        concept: `A sealed ancient forest gate barrier for a fantasy action game: a thick wall of tightly interwoven gnarled tree roots and long black thorns spanning between two weathered mossy standing stones carved with faint glowing runes, a pulsing seal of glowing black-green corrupted tree sap knotted in the centre of the roots, small hanging moss and vines. Front three-quarter view, wide horizontal composition, entire object visible, standing upright on its base. ${STYLE}`,
        faces: 12000,
      },
      'prop-greenwake-boulder-cluster': {
        concept: `A cluster of three large weathered granite forest boulders of different sizes, partly covered by thick green moss and lichen, a few small ferns and dead leaves at their base, rounded but chunky shapes. Three-quarter view, whole cluster visible. ${STYLE}`,
        faces: 6000,
      },
      'prop-warden-glaive': {
        concept: `A fantasy weapon: the Warden Staff in its long combat form, a slender glaive. Straight dark ash-wood shaft wrapped with thin living green vines and three engraved silver bands, a leather grip in the lower middle, a single-edged curved crescent blade of pale moon-steel at the top end like a naginata with faint cyan rune engravings along the blade, a small glowing amber heartroot crystal set where blade meets shaft, a short silver spike pommel. Entire weapon visible, laid horizontally in pure side view, blade pointing right with its edge facing up, centred. ${STYLE}`,
        faces: 8000,
      },
      'prop-greenwake-bramble-wall': {
        concept: `A long dense wall-like thicket of dark thorny bramble bushes and tangled exposed tree roots, leaves in deep greens and browns, a few red berries, irregular top edge about two metres tall, wide horizontal composition, side three-quarter view, entire object visible. ${STYLE}`,
        faces: 9000,
      },
    },
  },
};

// Whispering Canopy playtest (`?assetPlaytest=canopy`). Monsters are rigged with the Tripo rig v2.5 body
// types biped / avian / serpentine. `batches` per job lists the retarget preset batches (<= 5 each); every
// monster clip without a Tripo preset is authored offline by scripts/assets/author-creature-clips.mjs.
const BIPED_POSE = 'Full body front view, standing upright on two legs in a neutral A-pose with both arms hanging slightly away from the body and hands open, legs slightly apart, both feet visible, mouth closed.';
MAPS.canopy = {
  log: 'asset-source/generated/canopy-tripo-log.jsonl',
  batches: {},
  jobs: {
    'actor-thornback-howler': {
      concept: `A Black-Sap corrupted Thornback Howler creature: a hulking howler monkey in a hunched powerful posture about 1.7 metres tall, very long muscular arms with big knuckled hands reaching toward the knees, shaggy dark charcoal-black fur with russet-brown patches on the face and chest, jagged black thorn-like sap growths erupting along the back, spine and shoulders, glistening black-sap veins creeping over chest and forearms, a long dark tail curled behind, deep-set glowing amber eyes under a heavy brow. ${BIPED_POSE} ${STYLE}`,
      faces: 20000, rig: 'biped', checkRig: true,
      // Rig v2.5 rejects every biped preset (1004); rig v1.0 ships the 90+ `preset:biped:*` set. The monster-roar
      // chest-beat has no preset and is authored offline.
      rigParams: { model: 'rig-v1.0' },
      batches: [
        ['preset:biped:idle', 'preset:biped:walk', 'preset:biped:run', 'preset:biped:slash', 'preset:biped:pitch_baseball'],
        ['preset:biped:jump', 'preset:biped:hurt', 'preset:biped:turn', 'preset:biped:dive'],
      ],
    },
    'actor-storm-hornbill': {
      concept: `A giant corrupted Storm Hornbill: a huge hornbill bird with a massive curved beak topped by a big casque that is cracked and leaking glowing black sap veins, storm-blue and near-black plumage with pale grey-blue wing-tip feathers, jagged black sap-crystal thorns along the leading edges of the wings, white-grey tail band with long tail feathers, glowing pale-cyan eyes, two strong clawed legs. Full body, both wings fully spread out horizontally and symmetrically in a T-pose (about 3.2 metres wingspan), front three-quarter view slightly from above, beak closed, tail feathers visible. ${STYLE}`,
      faces: 20000, rig: 'avian', checkRig: true,
      // Rig v2.5 offers no avian presets (preset:idle/walk return 1004, preset:avian:* is rejected): all ten
      // clips, walk included, are authored offline on the Tripo skeleton.
      batches: [],
    },
    'actor-mire-viper': {
      concept: `A giant corrupted Mire Viper: an enormous venomous snake about seven metres long, thick muscular body covered in overlapping mossy dark-green scales with patches of moss and lichen along the back, black tree-sap veins and glowing toxic-green venom sacs swelling behind the jaw and along the neck, broad triangular head with glowing yellow slit eyes, jaw closed. Body lying in a gentle shallow S-curve along the ground, mostly straight, the front third of the body and head raised off the ground in a ready striking pose, head on the right, tail tip on the left, whole length visible in side view, wide horizontal composition. ${STYLE}`,
      faces: 20000, rig: 'serpentine', checkRig: true,
      // The serpentine rig only accepts its body-specific preset (generic presets return 1004).
      batches: [['preset:serpentine:march']],
    },
    'prop-vine-bridge': {
      concept: `A perfectly straight, rigid, level rainforest rope-and-plank bridge built like a long straight wooden boardwalk with rope railings: a flat horizontal deck of weathered wooden planks laid across two heavy straight horizontal timber beams, absolutely no sag, no curve and no droop anywhere, the deck and the top handrail ropes both pulled taut, perfectly straight and perfectly horizontal and parallel to each other, vertical rope posts of equal height holding thick vine-wrapped rope railings on both sides, a sturdy carved wooden post at each end, a few small hanging vines and moss patches. The bridge is long and narrow, about 12 metres long and 3.4 metres wide. Elevated three-quarter side view showing the whole bridge from end to end, wide horizontal composition, no cliffs, no water, no background. ${STYLE}`,
      faces: 14000,
    },
    'prop-ancient-canopy-shrine': {
      concept: `An overgrown ancient stone temple ruin in a rainforest: a broad moss-covered stepped plinth with a wide central staircase, several broken fluted stone pillars of different heights, a partly collapsed carved stone lintel and back wall, a small stone altar with faint glowing green runes, tree roots and hanging vines crawling over the stones, ferns growing in the cracks. About 14 metres wide. Front three-quarter view, wide horizontal composition, entire ruin visible, standing on its base. One single isolated object only, nothing floating or hanging above it, no blurry fragments, no fog, no background elements. ${STYLE}`,
      faces: 20000,
    },
    'prop-rainforest-canopy-tree': {
      concept: `A giant primeval rainforest canopy tree about 22 metres tall: enormous flaring buttress roots at the base, a thick straight trunk covered in moss, ferns and orchids, long hanging lianas and vines, a few huge horizontal branches, and a broad dense crown of dark green leaves at the top. Tall vertical composition, entire tree visible from root base to crown top, standing upright. ${STYLE}`,
      faces: 20000,
    },
    'prop-canopy-cliff-rock': {
      concept: `A tall mossy dark basalt rock outcrop for a rainforest cliff face: a cluster of tall vertical columnar basalt slabs and ledges in dark grey, thickly covered with green moss, ferns on the ledges and a few hanging vines, rough rocky silhouette about six metres tall, flat-ish base. Front three-quarter view, entire outcrop visible, standing upright on its base. ${STYLE}`,
      faces: 14000,
    },
    'prop-canopy-fern-cluster': {
      concept: `A dense low clump of tropical rainforest ferns and broadleaf plants: many arching fern fronds and a few large glossy broad leaves in several greens, a few small ground-cover plants and fallen leaves at the base, about 1.5 metres tall and 2 metres wide. Three-quarter view, whole clump visible, standing on its base. One single isolated clump only, nothing floating above it, no blurry or ghosted fronds, no background elements. ${STYLE}`,
      faces: 10000,
    },
  },
};

// Story maps after the Whispering Canopy (docs/production/content/GAME-NARRATIVE.en.md §6). Quadruped monsters follow the
// Greenwake chain (walk preset only, every other clip authored offline); bipeds use rig v1.0 presets like the Howler;
// the heron follows the Hornbill (avian, all clips offline).
const ISOLATED = 'One single isolated object only, nothing floating above it, no background elements.';
const BIPED_RIG = { rig: 'biped', checkRig: true, rigParams: { model: 'rig-v1.0' } };
const QUADRUPED_RIG = { rig: 'quadruped', checkRig: true };

// The Grove: the sanctuary hub (a young Heartroot, Yara's camp, a spring, a monkey lookout and the evasion-practice ring).
MAPS.grove = {
  log: 'asset-source/generated/grove-tripo-log.jsonl',
  batches: GREENWAKE_BATCHES,
  jobs: {
    'prop-heartroot-trunk': {
      concept: `A young sacred Heartroot tree about 9 metres tall at the heart of a forest sanctuary: a gnarled twisting trunk of pale silver-brown bark braided from several living roots, warm amber sap-light glowing softly in its cracks and knots, wide spreading roots gripping mossy stones at the base, a broad young crown of fresh green and golden leaves with a few small glowing amber blossoms. Tall vertical composition, entire tree visible from roots to crown, standing upright. ${ISOLATED} ${STYLE}`,
      faces: 20000,
    },
    'prop-refuge-shelter': {
      concept: `A Warden mentor's woodland camp tent: a sturdy canvas tent in faded moss-green and ochre cloth stretched over a frame of bent wooden poles and living branches, a woven reed mat and a low wooden chest at the entrance, bundles of dried herbs and two small amber crystal lanterns hanging from the frame, a little stack of scrolls, about 4 metres wide. Front three-quarter view, entire camp visible, standing on its base. ${ISOLATED} ${STYLE}`,
      faces: 12000,
    },
    'prop-training-post': {
      concept: `A forest Warden evasion training post: a thick upright carved wooden pole about 2.5 metres tall wrapped with rope and living vines, three short wooden practice arms sticking out at different heights and angles, leather straps, carved spiral runes glowing faint amber, standing in a low ring of flat mossy stones. Three-quarter view, entire object visible, standing upright. ${ISOLATED} ${STYLE}`,
      faces: 8000,
    },
    'prop-water-basin': {
      concept: `A natural forest spring pool: a ring of large flat mossy stones and smooth river rocks forming a shallow round basin about 4 metres across, clear turquoise water inside with a few lily pads and small white flowers, a tiny trickle of water spilling over one stone, ferns at the edge. Three-quarter view from slightly above, entire basin visible, resting on its base. ${ISOLATED} ${STYLE}`,
      faces: 9000,
    },
    'prop-grove-platform': {
      concept: `A monkey-built treetop lookout platform: a round wooden plank platform about 4 metres across raised on four sturdy log stilts lashed with vines, a rope ladder, a woven leaf canopy roof, hanging fruit baskets and colourful bird feathers, rope railings. Three-quarter view, entire structure visible, standing on its base. ${ISOLATED} ${STYLE}`,
      faces: 12000,
    },
    'actor-grove-rootling': {
      concept: `A friendly Heartroot rootling sparring spirit: a slender humanoid forest guardian about 1.6 metres tall made of braided living roots and smooth pale bark, a rounded head crowned with fresh green leaves and tiny amber blossoms, glowing warm amber eyes, long thin twig-like arms ending in three root fingers, sturdy root-bundle legs, soft moss patches on the shoulders, gentle curious expression, no corruption. ${BIPED_POSE} ${STYLE}`,
      faces: 16000, ...BIPED_RIG,
      batches: [['preset:biped:idle', 'preset:biped:walk', 'preset:biped:slash', 'preset:biped:pitch_baseball', 'preset:biped:hurt']],
    },
    'actor-koro': {
      concept: `Koro, leader of the forest monkeys: a strong clever macaque-like monkey about 1.3 metres tall standing upright, sleek golden-brown fur with a grey mane over the shoulders, a scar across one brow, a woven vine sash carrying a small pouch of seeds, a healed scar on one shoulder where a black thorn was pulled out, alert amber eyes, long tail curled behind. ${BIPED_POSE} ${STYLE}`,
      faces: 16000, ...BIPED_RIG,
      batches: [['preset:biped:idle', 'preset:biped:walk']],
    },
  },
};

// Chapter 3 — Moonpine Ridge: pine forest, cold mountains, a frozen lake, a buried wolf temple; Ruun's split pack.
MAPS.moonpine = {
  log: 'asset-source/generated/moonpine-tripo-log.jsonl',
  batches: GREENWAKE_BATCHES,
  jobs: {
    'actor-frostfang-tracker': {
      concept: `A Black-Sap corrupted Frostfang Tracker: a large grey timber wolf about 1.1 metres at the shoulder, thick layered silver-grey and white winter fur, a frost-crusted ruff and ice crystals along the spine, a tattered blue traditionalist pack cloth band around the neck, black sap veins creeping from the shoulders, pale icy-blue glowing eyes. ${QUADRUPED_POSE} ${STYLE}`,
      faces: 20000, ...QUADRUPED_RIG,
    },
    'actor-howl-scout': {
      concept: `A Black-Sap corrupted Howl Scout: a lean fast young wolf about 0.9 metres at the shoulder, sleek dark charcoal and rust-brown fur, long legs and big ears, a woven red cord scout band on one foreleg, jagged black sap thorns along the back, glowing violet eyes. ${QUADRUPED_POSE} ${STYLE}`,
      faces: 20000, ...QUADRUPED_RIG,
    },
    'actor-ruun-chained-howl': {
      concept: `Ruun, the Chained Howl: a huge ancient elder wolf leader about 1.6 metres at the shoulder, a heavy scarred body with long shaggy white and pale grey fur, a broken iron collar with snapped heavy black chains hanging from the neck and forelegs, black sap oozing through cracks in thick ice crusted along the back, a grey muzzle, deep glowing pale-gold eyes. ${QUADRUPED_POSE} ${STYLE}`,
      faces: 20000, ...QUADRUPED_RIG,
    },
    'prop-moonpine-tree': {
      concept: `A tall snow-laden mountain pine tree about 16 metres tall: a straight dark reddish-brown trunk with rough bark, dense layered dark blue-green needle branches heavily covered with clumps of fresh white snow, a few icicles, snowy roots at the base. Tall vertical composition, entire tree visible from base to tip, standing upright. ${ISOLATED} ${STYLE}`,
      faces: 14000,
    },
    'prop-buried-wolf-temple': {
      concept: `An ancient half-buried wolf temple ruin in snowy mountains: a broad stone stairway descending to a dark arched doorway carved with two great howling wolf heads, weathered grey granite blocks dusted with snow and frost, broken pillars, iron rings and heavy black chains hanging from the arch, faint black sap seeping from the cracks, about 14 metres wide. Front three-quarter view, wide horizontal composition, entire ruin visible, standing on its base. ${ISOLATED} ${STYLE}`,
      faces: 20000,
    },
    'prop-temple-chain-anchor': {
      concept: `A massive chain anchor post: a rough-hewn grey stone pillar about 2.5 metres tall carved with wolf runes, a huge rusted iron ring bolted into it and a length of heavy black iron chain coiled at its base, frost and snow on top, a crack oozing black sap. Three-quarter view, entire object visible, standing upright. ${ISOLATED} ${STYLE}`,
      faces: 8000,
    },
    'prop-snow-ridge-rock': {
      concept: `A cluster of large jagged grey granite mountain boulders with thick snow caps and frost, icy blue shadows in the cracks, a few dead pine twigs, about 5 metres wide and 3 metres tall. Three-quarter view, entire cluster visible, resting on its base. ${ISOLATED} ${STYLE}`,
      faces: 8000,
    },
    'prop-moonpine-log-bridge': {
      concept: `A perfectly straight, rigid, level mountain log bridge: three huge parallel peeled pine logs lashed together with rope into a flat walking deck, absolutely no sag, no curve and no droop, simple taut rope railings on both sides tied to short vertical posts of equal height, snow dusted along the deck edges. The bridge is long and narrow, about 12 metres long and 3.2 metres wide. Elevated three-quarter side view showing the whole bridge from end to end, wide horizontal composition. ${ISOLATED} ${STYLE}`,
      faces: 12000,
    },
  },
};

// Chapter 4 — Mistveil Basin: wetlands, fog, submerged ruins, great root trees, luminous animals and Marek's Black Sap river.
MAPS.mistveil = {
  log: 'asset-source/generated/mistveil-tripo-log.jsonl',
  batches: GREENWAKE_BATCHES,
  jobs: {
    'actor-bog-lurker': {
      concept: `A Black-Sap corrupted Bog Lurker: one single giant swamp toad about 1.4 metres tall, a wide squat body with warty dark olive and mud-brown skin and a pale yellow belly, swollen glowing black-sap blisters on the back, a wide closed mouth, bulging glowing amber eyes, four thick legs with webbed feet. Full body side three-quarter view, standing on four separated legs, all four feet visible, mouth closed. Exactly one creature in the image, no duplicate or ghosted copies, nothing behind it. ${STYLE}`,
      faces: 20000, ...QUADRUPED_RIG,
    },
    'actor-lantern-heron': {
      concept: `A giant corrupted Lantern Heron: a tall elegant swamp heron about 2.4 metres tall with a long S-curved neck and a long dagger beak, pale grey-blue plumage with softly glowing teal feather tips like lanterns in the mist, black sap streaks dripping along the wings, long thin legs. Full body, both wings fully spread out horizontally and symmetrically in a T-pose (about 3.6 metres wingspan), front three-quarter view slightly from above, beak closed. ${STYLE}`,
      faces: 20000, rig: 'avian', checkRig: true,
      batches: [],
    },
    'actor-ghor-mire-maw': {
      concept: `Ghor, the Mire Maw: a colossal corrupted swamp crocodile about 8 metres long, a massive armoured body with dark mossy green-black scutes, swamp plants and mud growing on its back, black sap oozing from cracks between the scales, glowing toxic yellow-green eyes, a huge closed jaw with protruding teeth, four thick sprawling legs with all four clawed feet on the ground, a long heavy tail. Full body side three-quarter view, whole length visible, wide horizontal composition, mouth closed. ${STYLE}`,
      faces: 20000, ...QUADRUPED_RIG,
    },
    'prop-mistveil-root-tree': {
      concept: `A great swamp mangrove root tree about 14 metres tall: a massive trunk lifted on dozens of arching stilt roots, dark wet bark draped with hanging moss, small luminous blue fungi on the roots, a wide flat crown of dark green leaves. Tall vertical composition, entire tree visible, standing upright on its roots. ${ISOLATED} ${STYLE}`,
      faces: 18000,
    },
    'prop-mistveil-reed-cluster': {
      concept: `A dense clump of tall wetland reeds, cattails and broad marsh grasses about 2.5 metres tall, a few pale luminous blue swamp flowers and small glowing mushrooms at the base. Three-quarter view, whole clump visible, standing on its base. One single isolated clump only, no blurry or ghosted leaves, no background elements. ${STYLE}`,
      faces: 10000,
    },
    'prop-mire-bank-rock': {
      concept: `A low flat mossy swamp bank rock: a wide weathered dark stone slab covered in thick wet moss, lichen and small ferns, a few mushrooms, about 4 metres wide and 1.2 metres tall. Three-quarter view, entire object visible, resting on its base. ${ISOLATED} ${STYLE}`,
      faces: 6000,
    },
    'prop-hunter-extraction-rig': {
      concept: `A hunter's Black Sap extraction rig: a crude scaffold tower of lashed timber and rusted iron about 6 metres tall, a large iron pump wheel, pipes and leather hoses dripping glowing black sap into stacked wooden barrels, chains, hooks and traps hanging from the frame, a tattered tarpaulin. Three-quarter view, entire structure visible, standing on its base. ${ISOLATED} ${STYLE}`,
      faces: 16000,
    },
    'prop-black-sap-filter-drum': {
      concept: `A large rusted iron filtration drum used by poachers: a fat riveted cylindrical iron tank about 2 metres tall on a wooden pallet, a glass gauge window glowing with black-purple sap, valves, a leaking pipe, two wooden crates beside it. Three-quarter view, entire object visible, standing on its base. ${ISOLATED} ${STYLE}`,
      faces: 8000,
    },
    'prop-root-cavern-mouth': {
      concept: `An enormous cave mouth formed by gigantic twisted ancient tree roots: a dark arching opening about 8 metres wide between huge gnarled moss-covered roots, hanging root tendrils, faint amber Heartroot light deep inside, black sap stains on the roots. Front three-quarter view, entire object visible, standing on its base. ${ISOLATED} ${STYLE}`,
      faces: 18000,
    },
  },
};

// Shared by every playtest map: the Warden waystone that marks each stage destination (the teleport point at the exit).
MAPS.shared = {
  log: 'asset-source/generated/shared-tripo-log.jsonl',
  batches: GREENWAKE_BATCHES,
  jobs: {
    'prop-warden-waystone': {
      concept: `An ancient Warden waystone obelisk about 4 metres tall: one single tapering four-sided standing stone of pale weathered grey-green granite with flowing spiral leaf runes carved as shallow channels on its faces, an open circular stone ring at the top cradling a faceted pale gold crystal held by three carved stone prongs, living Heartroot roots of silver-brown wood spiralling up from the base and gripping the stone, small moss patches and tiny white flowers at the foot, the base widens into a low stepped octagonal plinth about 1.6 metres across. Front three-quarter view, entire object visible, standing upright on its base. ${ISOLATED} ${STYLE}`,
      faces: 14000,
    },
  },
};

// Playable hero expansion: concept and max-option model only (`--through=model`). Heroes are rigged by hand on the
// full-quality model output with spec mixamo, exactly like Aren and Yara; the katana continues through decimate.
const HERO_POSE = 'Full body front view, standing upright in a neutral A-pose with both arms hanging slightly away from the body, hands open with fingers together, legs slightly apart, both feet flat and visible, mouth closed, nothing held in the hands, no weapons, no sheath, no cape touching the legs.';
MAPS.heroes = {
  log: 'asset-source/generated/heroes-tripo-log.jsonl',
  batches: {},
  jobs: {
    'actor-vesper-hero': {
      concept: `Vesper, the Moonshade Blade: a tall, lean, strikingly handsome male samurai assassin hero for a dark fantasy action game, eerie and ghostly. Pale porcelain skin, sharp elegant face with high cheekbones, intense glowing violet eyes, long jet-black hair tied in a high ponytail with loose strands framing the face, a sleek black lacquered half-mask covering nose and mouth with thin crimson lines. Fitted layered black and deep violet kimono-style light armour with crimson inner lining and tarnished silver trims, a short tattered dark scarf, black lamellar shoulder plates on one side, wrapped forearms with dark leather bracers, a crimson obi sash, dark hakama trousers tucked into black tabi boots, faint violet glowing crescent-moon rune tattoos on the forearms. Athletic slim build, 1.82 metres tall. ${HERO_POSE} ${STYLE}`,
      faces: 60000,
    },
    'actor-sakda-hero': {
      concept: `Sakda, the Ember Fist: a tall, powerfully muscular male Muay Thai fighter hero for a fantasy action game, heroic and intimidating. Broad shoulders, chiselled athletic physique, bronze tanned skin, short black hair with a shaved undercut, a sacred mongkol headband of braided crimson and gold rope, a long red silk blindfold tied over the eyes with two trailing tails, red and gold prajioud armbands on both upper arms, glowing ember-orange sak yant tiger and geometric tattoos across the chest, back and shoulders, cream cloth hand wraps and ankle wraps, traditional satin Muay Thai shorts in deep crimson with gold trim and a gold tiger emblem, barefoot. 1.88 metres tall. ${HERO_POSE} ${STYLE}`,
      faces: 60000,
    },
    'prop-vesper-katana': {
      concept: `A fantasy katana for a shadow samurai assassin: a gently curved single-edged blade of dark blackened steel with a glowing violet-to-crimson hamon line along the cutting edge, a round blackened tsuba guard engraved with a crescent moon, a long tsuka grip wrapped in black and crimson silk diamond wrap over ray skin, a small silver kashira pommel, about 1.05 metres long overall. Entire weapon visible, laid horizontally in pure side view, blade pointing right with its edge facing up, centred. ${ISOLATED} ${STYLE}`,
      faces: 8000,
    },
  },
};
