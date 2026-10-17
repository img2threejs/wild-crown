import { describe, expect, it } from 'bun:test';
import { AdditiveBlending, Bone, BufferAttribute, BufferGeometry, Group, MeshBasicMaterial, NormalBlending, Scene, Skeleton, SkinnedMesh, Vector3, type Object3D } from 'three';
import { AFTERIMAGE_DASH_ACTIONS, PoseAfterimages, type AfterimageStyle } from '../../src/rendering/PoseAfterimages.js';
import type { ActorSnapshot, WorldClockSnapshot } from '../../src/game/contracts.js';

function fixture(withBlade = false) {
  const scene = new Scene(), parent = new Group(), root = new Group();
  parent.position.set(8, 0, -3); parent.rotation.y = 0.3; scene.add(parent); parent.add(root);
  root.scale.set(1.3, 1.6, 0.9); root.rotation.y = 0.7;
  const hips = new Bone(), arm = new Bone(); arm.name = 'arm'; arm.position.y = 1; hips.add(arm);
  if (withBlade) {
    const tip = new Group(); tip.name = 'wc:weapon-tip'; tip.position.x = 1;
    arm.add(tip);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([1, 1, 0]), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array([1, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0]), 4));
  const material = new MeshBasicMaterial(), mesh = new SkinnedMesh(geometry, material);
  mesh.name = 'body'; mesh.add(hips); root.add(mesh); mesh.bind(new Skeleton([hips, arm]));
  const ghosts = new PoseAfterimages(scene, root);
  const actor = { id: 'aren', archetypeId: 'aren', species: 'human', allegiance: 'player', position: { x: 0, y: 0, z: 0 }, velocity: { x: 6, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 }, actionId: 'aren-run', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false } as ActorSnapshot;
  const capture = (tick: number, policy: WorldClockSnapshot['policy'] = 'normal', reduced = false) => ghosts.update(actor, { simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: policy === 'paused' ? 0 : 1, policy }, reduced);
  const vertex = (body: SkinnedMesh) => { body.updateWorldMatrix(true, true); body.updateMatrixWorld(true); body.skeleton.update(); return body.applyBoneTransform(0, new Vector3().fromBufferAttribute(body.geometry.getAttribute('position'), 0)).applyMatrix4(body.matrixWorld); };
  const visible = () => ghosts.group.children.filter(node => node.visible);
  const dispose = () => { ghosts.dispose(); geometry.dispose(); material.dispose(); mesh.skeleton.dispose(); };
  return { root, arm, mesh, ghosts, actor, capture, vertex, visible, dispose, geometry, material };
}

describe('native pose afterimages', () => {
  it('matches the deformed native vertex under a rotated/scaled parent, then freezes independently', () => {
    const f = fixture();
    try {
      f.arm.rotation.z = 0.6; f.root.position.x = 2; f.capture(20);
      const ghost = f.visible()[0]!, body = ghost.getObjectByName('body') as SkinnedMesh;
      const expected = f.vertex(f.mesh);
      expect(f.vertex(body).distanceTo(expected)).toBeLessThan(1e-6);
      f.arm.rotation.z = -0.8; f.root.position.x += 0.4; f.capture(24);
      expect(f.vertex(body).distanceTo(expected)).toBeLessThan(1e-6);
      expect(f.vertex(body).distanceTo(f.vertex(f.mesh))).toBeGreaterThan(0.5);
      expect(body.skeleton).not.toBe(f.mesh.skeleton);
    } finally { f.dispose(); }
  });

  it('freezes real in-place umbral sword poses without inventing root travel or repeating a held pose', () => {
    const f = fixture(true);
    try {
      f.ghosts.setStyle('umbral'); f.actor.actionId = 'vesper-iai-1'; f.actor.phase = 'active';
      f.actor.velocity = { x: 0, y: 0, z: 0 };
      f.capture(20);
      const first = f.visible()[0]!.getObjectByName('body') as SkinnedMesh, expected = f.vertex(first);
      f.capture(23); expect(f.visible()).toHaveLength(1);
      f.arm.rotation.z = 0.7; f.capture(24);
      expect(f.visible()).toHaveLength(2);
      expect(f.vertex(first).distanceTo(expected)).toBeLessThan(1e-6);
      expect(f.vertex(first).distanceTo(f.vertex(f.mesh))).toBeGreaterThan(0.5);
      expect((first.material as MeshBasicMaterial).blending).toBe(NormalBlending);
      f.capture(27); expect(f.visible()).toHaveLength(2);
      f.actor.phase = 'idle'; f.arm.rotation.z = -1; f.capture(36);
      expect(f.visible()).toHaveLength(0);
    } finally { f.dispose(); }
  });

  it('suppresses in-place blade echoes for reduced motion and motion-blur off, and leaves other hero styles unchanged', () => {
    const f = fixture(true);
    try {
      f.actor.actionId = 'vesper-iai-2'; f.actor.phase = 'active'; f.actor.velocity = { x: 0, y: 0, z: 0 };
      f.capture(20); expect(f.visible()).toHaveLength(0);
      f.ghosts.setStyle('umbral'); f.capture(24); expect(f.visible()).toHaveLength(1);
      f.capture(25, 'normal', true); expect(f.visible()).toHaveLength(0);
      f.ghosts.setMotionBlur(false); f.arm.rotation.z = 0.8; f.capture(30);
      expect(f.visible()).toHaveLength(0);
      f.ghosts.setMotionBlur(true); f.capture(34); expect(f.visible()).toHaveLength(1);
    } finally { f.dispose(); }
  });

  it('ages on the world clock, freezes on pause, expires after movement stops', () => {
    const f = fixture();
    try {
      f.capture(20); const body = f.visible()[0]!.getObjectByName('body') as SkinnedMesh;
      const opacity = (body.material as MeshBasicMaterial).opacity;
      f.capture(20, 'paused'); expect((body.material as MeshBasicMaterial).opacity).toBe(opacity);
      f.actor.actionId = 'aren-idle' as ActorSnapshot['actionId']; f.capture(38);
      expect(f.visible()).toHaveLength(0);
    } finally { f.dispose(); }
  });

  it('captures moving Dive but never stationary Walk, and removes trails for reduced motion or death', () => {
    const f = fixture();
    try {
      f.actor.actionId = 'aren-walk' as ActorSnapshot['actionId']; f.capture(20); expect(f.visible()).toHaveLength(0);
      f.actor.actionId = 'aren-forward-left-dive-roll' as ActorSnapshot['actionId']; f.capture(24); expect(f.visible()).toHaveLength(1);
      f.capture(25, 'normal', true); expect(f.visible()).toHaveLength(0);
      f.capture(30); f.actor.downed = true; f.capture(31); expect(f.visible()).toHaveLength(0);
    } finally { f.dispose(); }
  });

  it('captures the real airborne pose of a vertical jump, freezes it on pause and removes it for reduced motion', () => {
    const f = fixture();
    try {
      f.actor.actionId = 'aren-jump';
      f.actor.velocity = { x: 0, y: 3, z: 0 };
      f.actor.jumpPhase = 'takeoff';
      f.capture(20); expect(f.visible()).toHaveLength(0);
      f.actor.jumpPhase = 'rising'; f.arm.rotation.z = .7; f.root.position.y = 1;
      f.capture(24);
      const body = f.visible()[0]!.getObjectByName('body') as SkinnedMesh;
      const expected = f.vertex(f.mesh), opacity = (body.material as MeshBasicMaterial).opacity;
      expect(f.vertex(body).distanceTo(expected)).toBeLessThan(1e-6);
      f.arm.rotation.z = -.5; f.capture(24, 'paused');
      expect(f.vertex(body).distanceTo(expected)).toBeLessThan(1e-6);
      expect((body.material as MeshBasicMaterial).opacity).toBe(opacity);
      f.capture(25, 'normal', true); expect(f.visible()).toHaveLength(0);
    } finally { f.dispose(); }
  });

  it('never disposes native geometry, material or skeleton when the scene trail is released', () => {
    const f = fixture(); let released = 0;
    f.geometry.addEventListener('dispose', () => released++); f.material.addEventListener('dispose', () => released++);
    f.capture(20); f.ghosts.dispose(); f.ghosts.dispose(); f.capture(24);
    expect(released).toBe(0); expect(f.ghosts.group.parent).toBeNull();
    expect(f.mesh.skeleton.bones[1]).toBe(f.arm);
    f.dispose();
  });

  it('Warden\'s Judgement dash leaves a denser cyan additive streak than run or Dive, and ordinary ghosts keep their gold-green tint', () => {
    const f = fixture();
    try {
      f.actor.actionId = 'aren-judgement' as ActorSnapshot['actionId'];
      for (let k = 0; k < 4; k++) { f.root.position.x += 1; f.capture(20 + k * 2); }
      expect(f.visible()).toHaveLength(4);
      for (const ghost of f.visible()) {
        const material = (ghost.getObjectByName('body') as SkinnedMesh).material as MeshBasicMaterial;
        expect(material.blending).toBe(AdditiveBlending);
        expect(material.color.b).toBeGreaterThan(material.color.r * 3);
        expect(material.opacity).toBeGreaterThan(0.1);
      }
      f.capture(60);
      expect(f.visible()).toHaveLength(0);
      // The same cadence while running captures at most every fourth tick, with the original tint.
      f.actor.actionId = 'aren-run' as ActorSnapshot['actionId'];
      f.root.position.x += 1; f.capture(70); f.root.position.x += 1; f.capture(72);
      expect(f.visible()).toHaveLength(1);
      const run = (f.visible()[0]!.getObjectByName('body') as SkinnedMesh).material as MeshBasicMaterial;
      expect(run.blending).toBe(NormalBlending);
      expect(run.color.b).toBeLessThan(run.color.r * 3);
    } finally { f.dispose(); }
  });

  it('setStyle switches ghosts between the Warden jade/cyan and the Heartroot amber palette', () => {
    const f = fixture();
    try {
      expect(f.ghosts.style).toBe('warden');
      f.root.position.x += 1; f.capture(20);
      const warden = (f.visible()[0]!.getObjectByName('body') as SkinnedMesh).material as MeshBasicMaterial;
      expect(warden.color.g).toBeGreaterThan(warden.color.r);
      f.ghosts.setStyle('heartroot');
      expect(f.ghosts.style).toBe('heartroot');
      expect(f.visible()).toHaveLength(0);
      f.root.position.x += 1; f.capture(30);
      const amber = (f.visible()[0]!.getObjectByName('body') as SkinnedMesh).material as MeshBasicMaterial;
      expect(amber.color.r).toBeGreaterThan(amber.color.g);
      expect(amber.color.g).toBeGreaterThan(amber.color.b);
      // The Heartroot dash is an amber HDR silhouette, not the cyan one.
      f.actor.actionId = 'aren-judgement' as ActorSnapshot['actionId'];
      f.root.position.x += 1; f.capture(40);
      const dash = f.visible().map(ghost => (ghost.getObjectByName('body') as SkinnedMesh).material as MeshBasicMaterial).find(material => material.blending === AdditiveBlending)!;
      expect(dash.color.r).toBeGreaterThan(dash.color.b * 3);
      f.ghosts.setStyle('warden');
      f.root.position.x += 1; f.capture(60);
      const back = (f.visible()[0]!.getObjectByName('body') as SkinnedMesh).material as MeshBasicMaterial;
      expect(back.color.b).toBeGreaterThan(back.color.r * 3);
    } finally { f.dispose(); }
  });
});

function materialOf(ghost: Object3D): MeshBasicMaterial {
  const body = ghost.getObjectByName('body');
  if (!(body instanceof SkinnedMesh) || !(body.material instanceof MeshBasicMaterial)) throw new Error('afterimage ghost has no basic body material');
  return body.material;
}
const luma = (color: { r: number; g: number; b: number }): number => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

describe('four hero afterimage styles', () => {
  it('switching style drops live ghosts and recolours the next captures: jade, amber, violet-black/crimson, flame orange/gold', () => {
    const f = fixture();
    try {
      const tint = (name: AfterimageStyle, tick: number): MeshBasicMaterial => {
        f.ghosts.setStyle(name);
        expect(f.ghosts.style).toBe(name);
        expect(f.visible()).toHaveLength(0);
        f.root.position.x += 1; f.capture(tick);
        return materialOf(f.visible()[0]!);
      };
      const warden = tint('warden', 20), heartroot = tint('heartroot', 40), umbral = tint('umbral', 60), ember = tint('ember', 80);
      expect(warden.color.g).toBeGreaterThan(warden.color.r);
      expect(heartroot.color.r).toBeGreaterThan(heartroot.color.b);
      expect(luma(umbral.color)).toBeLessThan(0.1);
      expect(umbral.color.b).toBeGreaterThan(umbral.color.g);
      expect(ember.color.r).toBeGreaterThan(ember.color.g);
      expect(ember.color.g).toBeGreaterThan(ember.color.b);
      // Both tints of the pair are used by alternating ghosts: umbral's second tint is its crimson rim.
      f.ghosts.setStyle('umbral');
      for (let k = 0; k < 2; k++) { f.root.position.x += 1; f.capture(100 + k * 3); }
      const rim = f.visible().map(ghost => materialOf(ghost).color).find(color => color.r > color.b)!;
      expect(rim).toBeDefined();
      expect(rim.r).toBeGreaterThan(rim.g * 2);
    } finally { f.dispose(); }
  });

  it('umbral blink ghosts stay dark while the other heroes retain additive HDR dashes', () => {
    const f = fixture();
    try {
      const dash = (name: AfterimageStyle, action: string, tick: number): MeshBasicMaterial => {
        f.ghosts.setStyle(name); f.actor.actionId = action as ActorSnapshot['actionId'];
        f.root.position.x += 1; f.capture(tick);
        return materialOf(f.visible()[0]!);
      };
      const warden = dash('warden', 'aren-judgement', 20), heartroot = dash('heartroot', 'aren-judgement', 40);
      const umbral = dash('umbral', 'vesper-shadow-step', 60), ember = dash('ember', 'sakda-flying-knee', 80);
      for (const material of [warden, heartroot, ember]) expect(material.blending).toBe(AdditiveBlending);
      expect(umbral.blending).toBe(NormalBlending);
      expect(luma(umbral.color)).toBeLessThan(0.1);
      expect(warden.color.b).toBeGreaterThan(warden.color.r * 3);
      expect(heartroot.color.r).toBeGreaterThan(heartroot.color.b * 3);
      expect(umbral.color.r).toBeGreaterThan(umbral.color.g * 3);
      expect(umbral.color.b).toBeGreaterThan(umbral.color.g * 3);
      expect(ember.color.r).toBeGreaterThan(ember.color.g);
      expect(ember.color.g).toBeGreaterThan(ember.color.b * 3);
    } finally { f.dispose(); }
  });

  it('umbral captures denser (every 2 ticks on a blink dash, every 3 on a run) and its ghosts outlive the others\'', () => {
    const run = (name: AfterimageStyle, action: string, step: number): number => {
      const f = fixture();
      try {
        f.ghosts.setStyle(name); f.actor.actionId = action as ActorSnapshot['actionId'];
        for (let tick = 20; tick < 20 + step * 6; tick++) { f.root.position.x += 0.5; f.capture(tick); }
        return f.visible().length;
      } finally { f.dispose(); }
    };
    expect(run('umbral', 'vesper-shadow-step', 2)).toBe(6);
    expect(run('umbral', 'aren-run', 3)).toBe(6);
    expect(run('warden', 'aren-run', 3)).toBe(5);
    const lived = (name: AfterimageStyle): number => {
      const f = fixture();
      try {
        f.ghosts.setStyle(name); f.actor.actionId = 'aren-run' as ActorSnapshot['actionId'];
        f.root.position.x += 1; f.capture(20);
        f.actor.actionId = 'aren-idle' as ActorSnapshot['actionId'];
        let tick = 20;
        while (f.visible().length > 0 && tick < 80) f.capture(++tick);
        return tick - 20;
      } finally { f.dispose(); }
    };
    expect(lived('umbral')).toBeGreaterThan(lived('warden'));
    expect(lived('ember')).toBe(lived('warden'));
  });

  it('captures during run, every shared dodge, jumps and the dash skills; never during other skills or a stationary walk', () => {
    const f = fixture();
    try {
      f.ghosts.setStyle('umbral');
      let tick = 20;
      const captures = (action: string, velocity = { x: 6, y: 0, z: 0 }): number => {
        f.ghosts.clear(); f.actor.actionId = action as ActorSnapshot['actionId']; f.actor.velocity = velocity;
        f.root.position.x += 1; f.capture(tick += 10);
        return f.visible().length;
      };
      for (const action of ['aren-run', 'aren-forward-left-dive-roll', 'aren-forward-right-dive-roll', 'aren-perfect-dodge-left', 'aren-perfect-dodge-right', 'aren-quick-step-left', 'aren-quick-step-right', 'aren-forward-shoulder-roll', 'aren-back-handspring', 'aren-left-cartwheel', 'aren-right-cartwheel', 'aren-back-left-pivot-roll', 'aren-back-right-pivot-roll', 'aren-low-slide']) {
        expect(captures(action), action).toBe(1);
      }
      for (const action of Object.keys(AFTERIMAGE_DASH_ACTIONS)) expect(captures(action), action).toBe(1);
      expect(Object.keys(AFTERIMAGE_DASH_ACTIONS)).toEqual(expect.arrayContaining(['vesper-iai-4', 'vesper-shadow-step', 'vesper-thousand-cuts', 'vesper-shade-swap', 'vesper-requiem', 'sakda-resonating-strike', 'sakda-flying-knee', 'sakda-hundred-elbows', 'sakda-tigers-wrath']));
      for (const action of ['aren-idle', 'aren-walk', 'vesper-iai-1', 'vesper-kunai-fan', 'sakda-limb-1', 'sakda-tempest', 'sakda-echo-wave']) expect(captures(action), action).toBe(0);
      // A jump is captured while airborne only.
      f.actor.jumpPhase = 'rising'; expect(captures('aren-jump', { x: 0, y: 3, z: 0 })).toBe(1);
      f.actor.jumpPhase = 'takeoff'; expect(captures('aren-jump', { x: 0, y: 3, z: 0 })).toBe(0);
    } finally { f.dispose(); }
  });

  it('a dash skill that teleports the body keeps its ghosts, and captures even with no reported velocity; other actions reset on a jump of more than 3 m', () => {
    const f = fixture();
    try {
      f.ghosts.setStyle('umbral');
      f.actor.actionId = 'vesper-thousand-cuts' as ActorSnapshot['actionId']; f.actor.velocity = { x: 0, y: 0, z: 0 };
      f.root.position.x += 1; f.capture(20);
      f.root.position.x += 9; f.capture(23);
      expect(f.visible()).toHaveLength(2);
      f.actor.actionId = 'aren-run' as ActorSnapshot['actionId']; f.actor.velocity = { x: 6, y: 0, z: 0 };
      f.root.position.x += 9; f.capture(26);
      // The 9 m jump reset both skill ghosts; only the fresh, ordinary run ghost remains.
      expect(f.visible()).toHaveLength(1);
      expect(materialOf(f.visible()[0]!).blending).toBe(NormalBlending);
      // A dash skill that has not moved the body adds nothing.
      f.actor.actionId = 'vesper-requiem' as ActorSnapshot['actionId']; f.actor.velocity = { x: 0, y: 0, z: 0 };
      f.capture(40); f.capture(44);
      expect(f.visible()).toHaveLength(1);
    } finally { f.dispose(); }
  });

  it('keeps one pooled set of ghosts: the pool never grows past its fixed size', () => {
    const f = fixture();
    try {
      f.ghosts.setStyle('umbral'); f.actor.actionId = 'vesper-shade-swap' as ActorSnapshot['actionId'];
      for (let tick = 20; tick < 200; tick += 2) { f.root.position.x += 1; f.capture(tick); }
      expect(f.ghosts.group.children).toHaveLength(12);
      expect(f.visible().length).toBeLessThanOrEqual(12);
    } finally { f.dispose(); }
  });
});
