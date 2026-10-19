import { Bone, Object3D } from 'three';
import { LimbClearance } from '../../src/rendering/LimbClearance.ts';

/** Three.js bone hierarchy mirroring an authoring `Rig`, so the real runtime solver can be run on authored clip frames. */
export class ThreeSkeleton {
  constructor(rig) {
    this.rig = rig;
    this.nodes = rig.names.map((name, i) => { const node = new Bone(); node.name = name; node.position.copy(rig.restPosition[i]); node.quaternion.copy(rig.restQuaternion[i]); node.scale.copy(rig.restScale[i]); return node; });
    this.root = new Object3D();
    rig.parent.forEach((parent, i) => (parent < 0 ? this.root : this.nodes[parent]).add(this.nodes[i]));
    this.byName = (name) => this.nodes[rig.index.get(`mixamorig:${name}`)];
    const side = (s) => ({ arm: this.byName(`${s}Arm`), foreArm: this.byName(`${s}ForeArm`), hand: this.byName(`${s}Hand`), upLeg: this.byName(`${s}UpLeg`), leg: this.byName(`${s}Leg`), foot: this.byName(`${s}Foot`) });
    this.limbs = { hips: this.byName('Hips'), spine1: this.byName('Spine1'), neck: this.byName('Neck'), head: this.byName('Head'), left: side('Left'), right: side('Right') };
    this.clearance = new LimbClearance(this.limbs);
  }
  /** Poses frame data (`rotations[node]`, `positions[node]`) at index `k`. */
  setFrame(frames, k) {
    this.nodes.forEach((node, i) => { node.position.copy(this.rig.restPosition[i]); node.quaternion.copy(this.rig.restQuaternion[i]); node.scale.copy(this.rig.restScale[i]); });
    frames.rotations.forEach((track, i) => { if (track) this.nodes[i].quaternion.fromArray(track, k * 4); });
    frames.positions.forEach((track, i) => { if (track) this.nodes[i].position.fromArray(track, k * 3); });
    this.root.updateMatrixWorld(true);
  }
  /** Runs the runtime clearance solver; returns the world matrices indexed like `rig.world`. */
  solve() { this.clearance.apply(); return this.nodes.map((node) => node.matrixWorld); }
  raw() { return this.nodes.map((node) => node.matrixWorld); }
}
