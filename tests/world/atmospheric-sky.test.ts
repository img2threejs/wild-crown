import assert from 'node:assert/strict';
import test from 'node:test';
import { Color, Mesh, PerspectiveCamera, ShaderMaterial, Vector3 } from 'three';
import { AtmosphericSky, DEFAULT_SKY } from '../../src/world/AtmosphericSky.js';
import { GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';

type SkyUniforms = {
  uZenith: { value: Color };
  uTime: { value: number };
  uSunDiscSize: { value: number };
};

function meshOf(sky: AtmosphericSky): Mesh {
  return sky.mesh;
}

function uniformsOf(sky: AtmosphericSky): SkyUniforms {
  const material = meshOf(sky).material as ShaderMaterial & { uniforms: SkyUniforms };
  return material.uniforms;
}

function makeCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(49.5, 16 / 9, 0.1, 200);
  camera.position.set(0, 5, 12);
  camera.lookAt(new Vector3(0, 0, 0));
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

test('AtmosphericSky applies the profile colours to its shader uniforms on construction', () => {
  const sky = new AtmosphericSky({ fallback: GREENWAKE_BIOME.atmosphere.sky ?? DEFAULT_SKY });
  try {
    const profile = GREENWAKE_BIOME.atmosphere.sky!;
    assert.equal(sky.current, profile);
    const u = uniformsOf(sky);
    const r = (profile.zenith >> 16) & 0xff;
    const g = (profile.zenith >> 8) & 0xff;
    const b = profile.zenith & 0xff;
    assert.ok(Math.abs(u.uZenith.value.r - r / 255) < 1e-6);
    assert.ok(Math.abs(u.uZenith.value.g - g / 255) < 1e-6);
    assert.ok(Math.abs(u.uZenith.value.b - b / 255) < 1e-6);
    assert.equal(u.uSunDiscSize.value, profile.sunDiscSize);
  } finally {
    sky.dispose();
  }
});

test('AtmosphericSky follows the focus every frame and ages cloud time only when reduced motion is off', () => {
  const sky = new AtmosphericSky({ fallback: DEFAULT_SKY });
  try {
    sky.setSunDirection(new Vector3(0, 1, 0));
    sky.update(0, new Vector3(0, 0, 0), false);
    const mesh = meshOf(sky);
    assert.equal(mesh.position.x, 0); assert.equal(mesh.position.y, 0); assert.equal(mesh.position.z, 0);
    sky.update(2, new Vector3(5, 1, -3), false);
    assert.equal(mesh.position.x, 5); assert.equal(mesh.position.y, 1); assert.equal(mesh.position.z, -3);
    const u = uniformsOf(sky);
    assert.equal(u.uTime.value, 2, 'cloud time advances on real time when not reduced');
    sky.update(2, new Vector3(5, 1, -3), true);
    assert.equal(u.uTime.value, 0, 'cloud drift freezes under reduced effects');
  } finally {
    sky.dispose();
  }
});

test('AtmosphericSky normalises non-unit sun directions', () => {
  const sky = new AtmosphericSky({ fallback: DEFAULT_SKY });
  try {
    sky.setSunDirection(new Vector3(0, 50, 0));
    const read = sky.sunDirectionRead;
    assert.ok(Math.abs(read.x) < 1e-6);
    assert.ok(Math.abs(read.y - 1) < 1e-6);
    assert.ok(Math.abs(read.z) < 1e-6);
  } finally {
    sky.dispose();
  }
});
