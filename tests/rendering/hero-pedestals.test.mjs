import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Box3, DoubleSide, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Parse the shipped geometry, not provenance bounds: a wrong scale/origin otherwise leaves visible floating feet.
const manifest = JSON.parse(await readFile('asset-source/playtests/hero-pedestals.json', 'utf8'));
for (const hero of ['aren', 'yara', 'vesper', 'sakda']) {
  test(`${hero} native pedestal fits the preview and supports planted feet at y=0`, async () => {
    const entry = manifest.find(asset => asset.id === `hero-pedestal-${hero}`);
    assert.ok(entry, `Missing ${hero} floor`);
    assert.equal(entry.sourceType, 'native-glb');
    assert.equal(entry.evidenceStatus, 'blocked');
    const bytes = await readFile(entry.runtimeUrl.replace(/^\//, ''));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.outputHash);
    const gltf = await new GLTFLoader()
      .register(() => ({ name: 'geometry-only-material', loadMaterial: () => Promise.resolve(new MeshBasicMaterial({ side: DoubleSide })) }))
      .parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const root = gltf.scene;
    const transform = entry.coordinateTransform;
    root.scale.setScalar(transform.scale);
    root.rotation.y = Math.atan2(transform.forward.x, transform.forward.z);
    const offset = transform.originOffset;
    root.position.set(offset.x, offset.y, offset.z);
    root.updateMatrixWorld(true);
    try {
      const box = new Box3().setFromObject(root);
      const size = box.getSize(new Vector3());
      assert.ok(Math.abs(Math.max(size.x, size.z) - 2.25) < 0.01, `Unexpected floor footprint ${size.toArray()}`);
      assert.ok(box.min.y < -0.04 && box.min.y > -0.65, `Base should sit below the feet: ${box.min.y}`);
      const ray = new Raycaster(new Vector3(), new Vector3(0, -1, 0));
      for (const x of [-0.22, 0, 0.22]) for (const z of [-0.22, 0, 0.22]) {
        ray.ray.origin.set(x, box.max.y + 1, z);
        const hit = ray.intersectObject(root, true)[0];
        assert.ok(hit, `No standing surface below ${x}, ${z}`);
        assert.ok(Math.abs(hit.point.y) < 0.025, `Foot contact at ${x}, ${z} misses floor by ${hit.point.y} m`);
      }
    } finally {
      root.traverse(node => {
        if (!node.isMesh) return;
        node.geometry.dispose();
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
      });
    }
  });
}
