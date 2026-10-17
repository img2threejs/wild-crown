import { describe, expect, it } from 'bun:test';
import { BoxGeometry, BufferAttribute, Bone, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Quaternion, ShaderMaterial, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { CONTACT_SHADOW_PEAK, ContactShadows, GROUNDED_FADE, HOVER_FADE, contactShadowOpacity, contactShadowSize, measureFootprint } from '../../src/rendering/ContactShadows.js';

const material = new MeshBasicMaterial();

/** 0.6 m wide, 0.5 m deep legs and hips under a 2.4 m wide arm span at shoulder height, root yawed, scaled and offset. */
function body() {
  const root = new Group();
  root.position.set(5, 2, -3);
  root.rotation.y = 0.6;
  const model = new Group();
  model.scale.setScalar(2);
  root.add(model);
  const legs = new Mesh(new BoxGeometry(0.3, 0.9, 0.25).translate(0.05, 0.45, 0.1), material);
  const arms = new Mesh(new BoxGeometry(1.2, 0.05, 0.05).translate(0, 0.8, 0), material);
  const head = new Mesh(new BoxGeometry(0.2, 0.2, 0.2).translate(0, 0.95, 0), material);
  model.add(legs, arms, head);
  return root;
}

describe('contact shadow footprint', () => {
  it('measures the lower body in actor space, ignoring spread arms and the root transform', () => {
    const footprint = measureFootprint(body())!;
    expect(footprint.rx).toBeCloseTo(0.3, 5);
    expect(footprint.rz).toBeCloseTo(0.25, 5);
    expect(footprint.cx).toBeCloseTo(0.1, 5);
    expect(footprint.cz).toBeCloseTo(0.2, 5);
  });

  it('sizes from the skinned body only, so a prop hanging on a bone does not widen it', () => {
    const root = new Group(), bone = new Bone();
    const geometry = new BoxGeometry(0.4, 1.6, 0.3).translate(0, 0.8, 0);
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(count * 4), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(count * 4).map((_, index) => index % 4 === 0 ? 1 : 0), 4));
    const skin = new SkinnedMesh(geometry, material);
    skin.add(bone);
    root.add(skin);
    skin.bind(new Skeleton([bone]));
    const scabbard = new Mesh(new BoxGeometry(0.1, 0.1, 1.4).translate(-0.9, 0.5, 0.4), material);
    bone.add(scabbard);
    const footprint = measureFootprint(root)!;
    expect(footprint.rx).toBeCloseTo(0.2, 5);
    expect(footprint.rz).toBeCloseTo(0.18, 5);
    expect(footprint.cx).toBeCloseTo(0, 5);
  });

  it('clamps tiny bodies and returns null without geometry', () => {
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(0.02, 0.02, 0.02).translate(0, 0.01, 0), material));
    const footprint = measureFootprint(root)!;
    expect(footprint.rx).toBe(0.18);
    expect(footprint.rz).toBe(0.18);
    expect(measureFootprint(new Group())).toBeNull();
  });

  it('sizes the quad from the footprint and the actor scale', () => {
    const size = contactShadowSize({ cx: 0, cz: 0, rx: 0.3, rz: 0.2 }, 2);
    expect(size.x).toBeCloseTo(0.3 * 1.5 * 2 * 2, 9);
    expect(size.z).toBeCloseTo(0.2 * 1.5 * 2 * 2, 9);
  });
});

describe('contact shadow fade', () => {
  it('is full on the ground, strictly falling, and gone above the fade range', () => {
    expect(contactShadowOpacity(-0.2, GROUNDED_FADE)).toBe(1);
    expect(contactShadowOpacity(GROUNDED_FADE.start, GROUNDED_FADE)).toBe(1);
    let previous = 1;
    for (let height = 0.1; height < GROUNDED_FADE.end; height += 0.1) {
      const opacity = contactShadowOpacity(height, GROUNDED_FADE);
      expect(opacity).toBeLessThan(previous);
      previous = opacity;
    }
    expect(contactShadowOpacity(GROUNDED_FADE.end, GROUNDED_FADE)).toBe(0);
    expect(contactShadowOpacity(1.25, GROUNDED_FADE)).toBe(0);
  });

  it('hides a hovering flyer entirely and keeps a settled one', () => {
    expect(contactShadowOpacity(2.8, HOVER_FADE)).toBe(0);
    expect(contactShadowOpacity(0.6, HOVER_FADE)).toBe(0);
    expect(contactShadowOpacity(0.05, HOVER_FADE)).toBeGreaterThan(0.9);
  });
});

describe('contact shadow pool', () => {
  const footprint = { cx: 0.1, cz: 0.2, rx: 0.3, rz: 0.25 };

  it('is one fixed-size instanced draw with a soft, subtle, non-writing material', () => {
    const shadows = new ContactShadows(4);
    expect(shadows.mesh).toBeInstanceOf(InstancedMesh);
    const shader = shadows.mesh.material;
    if (!(shader instanceof ShaderMaterial)) throw new Error('contact shadows must use a shader material');
    const peak = shader.uniforms.uPeak!.value;
    expect(shader.transparent).toBe(true);
    expect(shader.depthWrite).toBe(false);
    expect(shader.polygonOffset).toBe(true);
    expect(peak).toBeGreaterThanOrEqual(0.35);
    expect(peak).toBeLessThanOrEqual(0.5);
    expect(CONTACT_SHADOW_PEAK).toBe(peak);
    expect(shadows.mesh.count).toBe(0);
    shadows.dispose();
  });

  it('places each shadow under the actor, oriented by heading, tilted to the ground and sized by the footprint', () => {
    const shadows = new ContactShadows(4);
    shadows.begin();
    const yaw = 0.9, normal = new Vector3(0.2, 1, -0.1).normalize();
    expect(shadows.add(footprint, 4, 1.5, -2, yaw, normal.x, normal.y, normal.z, 1, 0.8)).toBe(true);
    shadows.end();
    expect(shadows.mesh.count).toBe(1);
    const matrix = new Matrix4(), position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
    shadows.mesh.getMatrixAt(0, matrix);
    matrix.decompose(position, quaternion, scale);
    const size = contactShadowSize(footprint);
    expect(scale.x).toBeCloseTo(size.x, 6);
    expect(scale.z).toBeCloseTo(size.z, 6);
    expect(new Vector3(0, 1, 0).applyQuaternion(quaternion).angleTo(normal)).toBeLessThan(1e-6);
    const heading = new Vector3(0, 0, 1).applyQuaternion(quaternion);
    expect(Math.atan2(heading.x, heading.z)).toBeCloseTo(yaw, 1);
    const centre = position.clone().sub(new Vector3(4, 1.5, -2));
    expect(centre.length()).toBeGreaterThan(0.2);
    expect(centre.dot(normal)).toBeGreaterThan(0);
    expect(shadows.mesh.geometry.getAttribute('aOpacity').getX(0)).toBeCloseTo(0.8, 6);
    shadows.dispose();
  });

  it('bounds the ground tilt, skips invisible shadows and refuses past capacity', () => {
    const shadows = new ContactShadows(2);
    shadows.begin();
    expect(shadows.add(footprint, 0, 0, 0, 0, 1, 0.1, 0, 1, 1)).toBe(true);
    expect(shadows.add(footprint, 0, 0, 0, 0, 0, 1, 0, 1, 0)).toBe(false);
    expect(shadows.add(footprint, 1, 0, 0, 0, 0, 1, 0, 1, 1)).toBe(true);
    expect(shadows.add(footprint, 2, 0, 0, 0, 0, 1, 0, 1, 1)).toBe(false);
    shadows.end();
    expect(shadows.mesh.count).toBe(2);
    const matrix = new Matrix4(), quaternion = new Quaternion();
    shadows.mesh.getMatrixAt(0, matrix);
    matrix.decompose(new Vector3(), quaternion, new Vector3());
    expect(new Vector3(0, 1, 0).applyQuaternion(quaternion).angleTo(new Vector3(0, 1, 0))).toBeLessThanOrEqual(35 * Math.PI / 180 + 1e-6);
    shadows.begin();
    shadows.end();
    expect(shadows.mesh.count).toBe(0);
    shadows.dispose();
  });

  it('detaches from its parent on dispose', () => {
    const parent = new Group(), shadows = new ContactShadows(2);
    parent.add(shadows.mesh);
    shadows.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
