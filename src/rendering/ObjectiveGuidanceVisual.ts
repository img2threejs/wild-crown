import {
  AdditiveBlending, BufferGeometry, Color, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, PlaneGeometry, Points,
  ShaderMaterial, UniformsLib, UniformsUtils, type Scene,
} from 'three';
import type { WorldObjectiveCue } from '../game/contracts.js';

type Status = WorldObjectiveCue['status'];

const MOTE_CAPACITY = 24;
const GREEN = 0x9fe08a;
const GOLD = 0xf2c76b;
const DIM = 0x7d8a72;

const MESH_VERTEX = `varying vec2 vUv;
#include <fog_pars_vertex>
void main() { vUv=uv; vec4 mvPosition=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`;
const MESH_HEADER = `uniform vec3 colorA; uniform vec3 colorB; uniform float time; uniform float motion; uniform float power; uniform float segments; uniform float gap; uniform float inner;
varying vec2 vUv;
#include <fog_pars_fragment>
`;
/** Broken ring (dashed when blocked, gapped while approaching, closed with an inner ring when ready). */
const RING_FRAGMENT = `${MESH_HEADER}
void main() {
  vec2 p=(vUv-.5)*2.0; float r=length(p); float t=atan(p.y,p.x)/6.2831853+.5;
  float breath=1.0+motion*.12*sin(time*2.0);
  float band=1.0-smoothstep(.03,.075,abs(r-.9));
  float cell=fract(t*segments+motion*time*.04);
  float arc=smoothstep(gap,gap+.07,cell)*(1.0-smoothstep(.93,1.0,cell));
  float closed=step(segments,1.5)*step(gap,.001);
  arc=mix(arc,1.0,closed);
  float innerBand=(1.0-smoothstep(.02,.05,abs(r-.58)))*inner;
  float glow=(1.0-smoothstep(.0,.9,r))*.07;
  float a=(band*arc+innerBand*.7+glow)*(1.0-smoothstep(.95,1.0,r))*power*breath;
  gl_FragColor=vec4(mix(colorA,colorB,band*arc)*1.35,clamp(a,0.0,.85));
#include <fog_fragment>
}`;
const COLUMN_FRAGMENT = `${MESH_HEADER}
void main() {
  float streak=pow(max(0.0,sin(vUv.x*62.83+sin(vUv.y*5.0-time*motion)*.6)),14.0)*.1;
  float fade=smoothstep(0.0,.06,vUv.y)*(1.0-smoothstep(.25,1.0,vUv.y));
  float a=(.045+streak)*fade*power*(1.0+motion*.08*sin(time*1.7));
  gl_FragColor=vec4(mix(colorA,colorB,.55+.4*vUv.y)*1.3,a);
#include <fog_fragment>
}`;
const MOTE_VERTEX = `uniform float time; uniform float motion; uniform float scale; uniform float height; uniform float radius;
varying float vMix;
#include <fog_pars_vertex>
void main() {
  float rise=fract(position.y+time*motion*.11);
  float angle=position.x+time*motion*.42;
  float r=position.z*radius*(.85+.15*sin(time*motion*.8+position.x*3.0));
  vec3 p=vec3(cos(angle)*r,.18+rise*height,sin(angle)*r);
  vMix=fract(position.x*.37);
  vec4 mvPosition=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mvPosition;
  gl_PointSize=clamp(scale/max(1.0,-mvPosition.z),1.5,9.0)*(.4+.6*sin(rise*3.14159));
#include <fog_vertex>
}`;
const MOTE_FRAGMENT = `uniform vec3 colorA; uniform vec3 colorB; uniform float power; varying float vMix;
#include <fog_pars_fragment>
void main() { float d=length(gl_PointCoord-.5);
  gl_FragColor=vec4(mix(colorA,colorB,vMix)*1.6,(1.0-smoothstep(.08,.5,d))*.8*power);
#include <fog_fragment>
}`;

/**
 * Read-only procedural presentation of a world objective or chapter exit.
 * Owns its geometry/materials, loads no assets, casts no light or shadow and never touches simulation state.
 */
export class ObjectiveGuidanceVisual {
  readonly group = new Group();
  private readonly ring: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly column: Mesh<CylinderGeometry, ShaderMaterial>;
  private readonly motes: Points<BufferGeometry, ShaderMaterial>;
  private readonly materials: readonly ShaderMaterial[];
  private readonly colorGreen = new Color(GREEN);
  private readonly colorGold = new Color(GOLD);
  private readonly colorDim = new Color(DIM);
  private elapsed = 0;
  private disposed = false;

  constructor(private readonly scene: Scene) {
    this.group.name = 'objective-guidance'; this.group.visible = false;
    const mesh = (fragmentShader: string): ShaderMaterial => new ShaderMaterial({
      vertexShader: MESH_VERTEX, fragmentShader,
      uniforms: UniformsUtils.merge([UniformsLib.fog!, {
        colorA: { value: new Color(GREEN) }, colorB: { value: new Color(GOLD) }, time: { value: 0 }, motion: { value: 0 }, power: { value: 1 },
        segments: { value: 5 }, gap: { value: .22 }, inner: { value: 0 },
      }]),
      transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending, toneMapped: false, fog: true,
    });
    this.ring = new Mesh(new PlaneGeometry(1, 1), mesh(RING_FRAGMENT));
    this.ring.name = 'objective-guidance-ring'; this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = .06;
    this.ring.castShadow = false; this.ring.receiveShadow = false; this.ring.renderOrder = 4;
    // Open unit cylinder; scaled per kind. UV y runs bottom to top.
    this.column = new Mesh(new CylinderGeometry(.5, .9, 1, 24, 1, true), mesh(COLUMN_FRAGMENT));
    this.column.name = 'objective-guidance-column'; this.column.castShadow = false; this.column.receiveShadow = false; this.column.renderOrder = 4;

    const seeds = new Float32Array(MOTE_CAPACITY * 3);
    for (let i = 0; i < MOTE_CAPACITY; i++) {
      seeds[i * 3] = i * 2.39996323; // orbit phase, golden angle
      seeds[i * 3 + 1] = (i * .61803399) % 1; // rise phase
      seeds[i * 3 + 2] = .35 + ((i * 5) % 11) / 11 * .65; // orbit radius fraction
    }
    const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(seeds, 3));
    const moteMaterial = new ShaderMaterial({
      vertexShader: MOTE_VERTEX, fragmentShader: MOTE_FRAGMENT,
      uniforms: UniformsUtils.merge([UniformsLib.fog!, {
        colorA: { value: new Color(GREEN) }, colorB: { value: new Color(GOLD) }, power: { value: 1 }, time: { value: 0 }, motion: { value: 0 },
        scale: { value: 90 }, height: { value: 2.2 }, radius: { value: 1 },
      }]),
      transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, fog: true,
    });
    this.motes = new Points(geometry, moteMaterial);
    this.motes.name = 'objective-guidance-motes'; this.motes.frustumCulled = false; this.motes.renderOrder = 5;
    this.materials = [this.ring.material, this.column.material, this.motes.material];
    this.group.add(this.ring, this.column, this.motes);
    scene.add(this.group);
  }

  update(cue: WorldObjectiveCue | null, dt: number, reducedMotion: boolean): void {
    if (this.disposed) return;
    if (!cue) { this.group.visible = false; return; }
    const step = Math.max(0, Math.min(.1, Number.isFinite(dt) ? dt : 0));
    const blocked = cue.status === 'blocked';
    const animated = !reducedMotion && !blocked;
    if (animated) this.elapsed += step;
    const exit = cue.kind === 'exit';
    this.group.visible = true;
    this.group.position.set(cue.position.x, cue.position.y, cue.position.z);

    const status: Status = cue.status;
    const ready = status === 'ready';
    const power = blocked ? .32 : ready ? 1.25 : .9;
    const ringSize = exit ? 4.6 : 2.6;
    this.ring.scale.set(ringSize, ringSize, 1);
    const radialScale = exit ? 1 : .45;
    const columnHeight = exit ? 7 : 2.6;
    this.column.scale.set(radialScale, columnHeight, radialScale); this.column.position.y = columnHeight / 2;
    // Blocked routes never show a beam, so a closed route is not mistaken for an open one.
    this.column.visible = !blocked;

    const ring = this.ring.material.uniforms;
    ring.segments!.value = blocked ? 6 : ready ? 1 : 5;
    ring.gap!.value = blocked ? .6 : ready ? 0 : .22;
    ring.inner!.value = ready ? 1 : 0;

    const a = blocked ? this.colorDim : this.colorGreen;
    const b = blocked ? this.colorDim : this.colorGold;
    for (const material of this.materials) {
      const u = material.uniforms;
      (u.colorA!.value as Color).copy(a); (u.colorB!.value as Color).copy(b);
      u.time!.value = this.elapsed; u.motion!.value = animated ? 1 : 0; u.power!.value = power;
    }
    const mu = this.motes.material.uniforms;
    mu.scale!.value = exit ? 130 : 90; mu.height!.value = exit ? 6.5 : 2.2; mu.radius!.value = exit ? 1.6 : 1;
    this.motes.geometry.setDrawRange(0, blocked ? 8 : exit ? MOTE_CAPACITY : 18);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.scene.remove(this.group);
    this.ring.geometry.dispose(); this.column.geometry.dispose(); this.motes.geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}
