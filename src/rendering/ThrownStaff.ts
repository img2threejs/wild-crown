import { AdditiveBlending, CircleGeometry, Color, DoubleSide, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, RingGeometry, Vector3, type Object3D } from 'three';

/**
 * Sap Lance throws the Heartroot staff instead of firing a beam: the staff leaves the fist, flies flat and spinning toward the lane end, and the
 * fist calls it back. Timing is presentation only; the simulation's lane hit and damage are unchanged.
 */
export const STAFF_THROW = Object.freeze({
  /** Seconds of the outward leg (ease-out) and of the return leg (ease-in). */
  outSeconds: 0.3, backSeconds: 0.3,
  /** Spin about world up, revolutions per second. */
  revolutionsPerSecond: 2.5,
  /** Seconds the staff takes to turn from the way it was held to the flat spin at launch, and from the spin to the held pose on arrival. */
  alignSeconds: 0.06,
  /** Radius of the defensive ward as a share of the staff length. */
  wardRadiusFraction: 0.55,
});

/**
 * When the throw leaves the fist: the authored release tick of the Sap Lance clip (`yara-sap-lance`, tick 16 of 30), which is when the simulation queues
 * the lance cue. The Skills-tab preview has no cues and throws at this progress; `previewReach` (m) is how far it flies there (the lane is 14 m in play).
 */
export const SAP_LANCE_RELEASE = Object.freeze({ clipId: 'yara-sap-lance', activeTick: 16, totalTicks: 30, previewReach: 3 });

const WARD_LEAVES = 14;
const WARD_AMBER = 0xffb347, WARD_PETAL = 0xff8fae, WARD_IVORY = 0xffe2c4;
const UP = new Vector3(0, 1, 0);
const scratchColor = new Color();
const smooth = (t: number): number => { const u = t <= 0 ? 0 : t >= 1 ? 1 : t; return u * u * (3 - 2 * u); };

/**
 * The flying staff: a preallocated instance (shared geometry and materials of the held staff) plus a translucent heartroot ward, a flat disc, two rings
 * and a circle of leaves that spin with it. The root's origin is the staff's centre and its +Z runs pommel → head, as in the held weapon frame. All per-frame
 * state lives in scratch fields, so a flight allocates nothing.
 */
export class ThrownStaff {
  /** World-space root while flying; hidden otherwise. */
  readonly root = new Group();
  private readonly ward = new Group();
  private readonly discs: MeshBasicMaterial[] = [];
  private readonly fades: number[] = [];
  private readonly leaves: InstancedMesh;
  private readonly disposables: { dispose(): void }[] = [];
  private flying = false;
  private time = 0;
  private readonly start = new Vector3();
  private readonly target = new Vector3();
  private readonly startQuat = new Quaternion();
  private readonly flat = new Quaternion();
  private readonly pose = new Quaternion();

  /** `mesh` is the shared-geometry staff mesh, already positioned so the staff's centre is the origin of this root's frame. */
  constructor(mesh: Mesh, readonly length: number) {
    this.root.name = 'wc:thrown-staff';
    this.root.visible = false;
    this.root.add(mesh, this.ward);
    const radius = length * STAFF_THROW.wardRadiusFraction;
    const flatten = new Matrix4().makeRotationX(-Math.PI / 2);
    const material = (color: number, opacity: number, side = DoubleSide): MeshBasicMaterial => {
      const result = new MeshBasicMaterial({ color, transparent: true, opacity, side, depthWrite: false, blending: AdditiveBlending, toneMapped: false });
      this.disposables.push(result); this.discs.push(result); this.fades.push(opacity);
      return result;
    };
    const flatMesh = (geometry: CircleGeometry | RingGeometry, mat: MeshBasicMaterial): Mesh => {
      geometry.applyMatrix4(flatten);
      this.disposables.push(geometry);
      const part = new Mesh(geometry, mat);
      part.castShadow = false; part.receiveShadow = false; part.renderOrder = 4;
      return part;
    };
    this.ward.add(
      flatMesh(new CircleGeometry(radius, 48), material(WARD_AMBER, 0.14)),
      flatMesh(new RingGeometry(radius * 0.94, radius, 64), material(WARD_AMBER, 0.6)),
      flatMesh(new RingGeometry(radius * 0.52, radius * 0.55, 48), material(WARD_IVORY, 0.35)),
    );
    // A circle of petal leaves around the rim, alternating pink and ivory; the whole ward turns with the staff, so they orbit it.
    const leafGeometry = new PlaneGeometry(radius * 0.17, radius * 0.1).rotateX(-Math.PI / 2);
    const leafMaterial = new MeshBasicMaterial({ color: WARD_PETAL, transparent: true, opacity: 0.85, side: DoubleSide, depthWrite: false, toneMapped: false });
    this.disposables.push(leafGeometry, leafMaterial);
    this.leaves = new InstancedMesh(leafGeometry, leafMaterial, WARD_LEAVES);
    this.leaves.name = 'wc:thrown-staff-leaves';
    this.leaves.renderOrder = 5;
    const placement = new Matrix4(), rotation = new Quaternion(), position = new Vector3(), scale = new Vector3(1, 1, 1);
    for (let i = 0; i < WARD_LEAVES; i++) {
      const angle = i / WARD_LEAVES * Math.PI * 2, r = radius * (i % 2 ? 0.8 : 0.96);
      position.set(Math.cos(angle) * r, (i % 3 - 1) * 0.04, Math.sin(angle) * r);
      rotation.setFromAxisAngle(UP, -angle + (i % 2 ? 0.5 : -0.4));
      placement.compose(position, rotation, scale);
      this.leaves.setMatrixAt(i, placement);
      this.leaves.setColorAt(i, scratchColor.setHex(i % 2 ? WARD_PETAL : WARD_IVORY));
    }
    this.leaves.instanceMatrix.needsUpdate = true;
    if (this.leaves.instanceColor) this.leaves.instanceColor.needsUpdate = true;
    this.leaves.frustumCulled = false;
    this.ward.add(this.leaves);
  }

  get active(): boolean { return this.flying; }

  /** Starts a flight from the held staff's centre (`start`, `startQuat`, world) toward `target` (world). */
  launch(start: Vector3, startQuat: Quaternion, target: Vector3): void {
    this.start.copy(start); this.startQuat.copy(startQuat); this.target.copy(target);
    this.time = 0; this.flying = true;
    this.root.position.copy(start); this.root.quaternion.copy(startQuat);
    this.root.visible = true;
    this.shape(0);
  }

  /** Ends a flight at once (the staff is back in the fist). */
  stop(): void {
    this.flying = false; this.time = 0;
    this.root.visible = false;
  }

  /**
   * Advances the flight by `dt` seconds; `home`/`homeQuat` are the held staff's current centre and orientation (the fist moves while the staff is away).
   * Returns true on the frame the staff arrives.
   */
  update(dt: number, home: Vector3, homeQuat: Quaternion): boolean {
    if (!this.flying) return false;
    const { outSeconds, backSeconds, revolutionsPerSecond, alignSeconds } = STAFF_THROW;
    this.time += dt;
    const total = outSeconds + backSeconds;
    if (this.time >= total) { this.stop(); return true; }
    if (this.time < outSeconds) {
      const u = this.time / outSeconds, eased = 1 - (1 - u) * (1 - u) * (1 - u);
      this.root.position.lerpVectors(this.start, this.target, eased);
    } else {
      const u = (this.time - outSeconds) / backSeconds, eased = u * u * u;
      this.root.position.lerpVectors(this.target, home, eased);
    }
    // The shaft stays horizontal and spins about world up; the turn from the held pose to the flat spin (and back) is smoothed over `alignSeconds`.
    this.flat.setFromAxisAngle(UP, Math.PI / 2 + this.time * revolutionsPerSecond * Math.PI * 2);
    const turnIn = smooth(this.time / alignSeconds), turnOut = smooth((total - this.time) / alignSeconds);
    this.pose.copy(this.startQuat).slerp(this.flat, turnIn);
    this.root.quaternion.copy(this.pose);
    if (turnOut < 1) this.root.quaternion.copy(homeQuat).slerp(this.pose, turnOut);
    this.shape(this.time / total);
    return false;
  }

  /** Ward fade and breathing at flight progress `t` (0..1). */
  private shape(t: number): void {
    const fade = smooth(t / 0.12) * smooth((1 - t) / 0.12);
    for (let i = 0; i < this.discs.length; i++) this.discs[i]!.opacity = this.fades[i]! * fade;
    (this.leaves.material as MeshBasicMaterial).opacity = 0.85 * fade;
    this.ward.scale.setScalar(0.35 + 0.65 * smooth(t / 0.15) + 0.03 * Math.sin(this.time * 24));
  }

  attach(parent: Object3D): void { if (this.root.parent !== parent) parent.add(this.root); }

  dispose(): void {
    this.stop();
    this.root.removeFromParent();
    this.leaves.dispose();
    for (const item of this.disposables) item.dispose();
  }
}
