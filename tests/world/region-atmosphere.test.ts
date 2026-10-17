import assert from 'node:assert/strict';
import test from 'node:test';
import { GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';
import { CANOPY_BIOME } from '../../src/world/CanopyBiome.js';
import { BAMBOO_BIOME } from '../../src/world/BambooBiome.js';
import { GROVE_BIOME } from '../../src/world/GroveBiome.js';
import { MOONPINE_BIOME } from '../../src/world/MoonpineBiome.js';
import { MISTVEIL_BIOME } from '../../src/world/MistveilBiome.js';
import {
  HOLLOW_STORY_BIOME,
  MISTVEIL_STORY_BIOME,
  MOONPINE_STORY_BIOME,
  REFUGE_STORY_BIOME,
  SUNMANE_STORY_BIOME,
} from '../../src/world/LaterBiomes.js';
import type { BiomeProfile } from '../../src/world/BiomeProfile.js';

const ALL_BIOMES: readonly BiomeProfile[] = [
  GREENWAKE_BIOME, CANOPY_BIOME, BAMBOO_BIOME, GROVE_BIOME, MOONPINE_BIOME, MISTVEIL_BIOME,
  MOONPINE_STORY_BIOME, MISTVEIL_STORY_BIOME, SUNMANE_STORY_BIOME, REFUGE_STORY_BIOME, HOLLOW_STORY_BIOME,
];

test('every biome ships a complete sky profile: zenith/horizon/ground within the RGB24 range, sun disc and glow sized, clouds non-negative', () => {
  for (const biome of ALL_BIOMES) {
    const sky = biome.atmosphere.sky;
    assert.ok(sky, `${biome.id} is missing atmosphere.sky`);
    for (const [name, value] of [['zenith', sky.zenith], ['horizon', sky.horizon], ['ground', sky.ground], ['sunDiscColor', sky.sunDiscColor], ['sunGlowColor', sky.sunGlowColor], ['cloudColor', sky.cloudColor]] as const) {
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffff, `${biome.id} ${name} out of range: ${value}`);
    }
    assert.ok(sky.sunDiscSize > 0 && sky.sunDiscSize < Math.PI / 4, `${biome.id} sun disc is a clean visible dot`);
    assert.ok(sky.sunGlowSize > sky.sunDiscSize && sky.sunGlowSize < Math.PI / 2, `${biome.id} sun glow halo larger than disc but bounded`);
    assert.ok(sky.cloudCoverage >= 0 && sky.cloudCoverage <= 1, `${biome.id} cloud coverage is 0..1`);
    assert.ok(sky.cloudSpeed > 0, `${biome.id} cloud speed is positive (drift freezes under reduced motion)`);
  }
});

test('every biome ships a height-fog profile with positive density and bounded sun tint', () => {
  for (const biome of ALL_BIOMES) {
    const fog = biome.atmosphere.heightFog;
    assert.ok(fog, `${biome.id} is missing atmosphere.heightFog`);
    assert.ok(fog.density > 0 && fog.density < 0.5, `${biome.id} height-fog density in a screen-space pass is positive and bounded`);
    assert.ok(fog.falloff >= 0 && fog.falloff < 1, `${biome.id} height-fog falloff in [0,1)`);
    assert.ok(fog.sunTint >= 0 && fog.sunTint <= 1, `${biome.id} height-fog sun tint in [0,1]`);
    for (const [name, value] of [['color', fog.color], ['sunTintColor', fog.sunTintColor]] as const) {
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffff, `${biome.id} ${name} out of range`);
    }
  }
});

test('every biome ships a colour grade: lift/gamma/gain in [0,2], saturation >= 0, split tones non-negative, vignette in [0,1]', () => {
  for (const biome of ALL_BIOMES) {
    const grade = biome.atmosphere.grade;
    assert.ok(grade, `${biome.id} is missing atmosphere.grade`);
    for (const triple of [grade.lift, grade.gamma, grade.gain, grade.warmHighlight, grade.coolShadow] as const) {
      for (const channel of triple) {
        assert.ok(channel >= 0 && channel <= 2, `${biome.id} grade tuple channel out of [0,2]: ${channel}`);
      }
    }
    assert.ok(grade.saturation >= 0, `${biome.id} grade saturation must be non-negative`);
    assert.ok(grade.vignette >= 0 && grade.vignette <= 1, `${biome.id} grade vignette in [0,1]`);
  }
});

test('every biome declares a non-negative lightShafts strength capped at 1', () => {
  for (const biome of ALL_BIOMES) {
    const shafts = biome.atmosphere.lightShafts;
    assert.ok(shafts !== undefined, `${biome.id} is missing atmosphere.lightShafts`);
    assert.ok(shafts >= 0 && shafts <= 1, `${biome.id} lightShafts in [0,1]: ${shafts}`);
  }
});
