import { AdditiveBlending, BufferGeometry, Color, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, PlaneGeometry, Points, ShaderMaterial, Sprite, SpriteMaterial, CanvasTexture, UniformsLib, UniformsUtils, type Scene } from 'three';
import type { AssetManifestEntry, Vec3 } from '../game/contracts';
import type { NativeAssetInstance, NativeAssetLoader } from './NativeAssetLoader';

export const WAYSTONE_ASSET_ID = 'prop-warden-waystone';
const ACCENTS: Readonly<Record<string, number>> = {
  greenwake: 0xb1d389, 'whispering-canopy': 0x77dfbc, 'the-grove': 0xf0c782,
  'moonpine-ridge': 0x97d9ff, 'mistveil-basin': 0x70ded0,
};
const VERTEX = `varying vec2 vUv;
#include <fog_pars_vertex>
void main() { vUv=uv; vec4 mvPosition=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`;
const FRAGMENT_HEADER = `uniform vec3 accent; uniform float time; uniform float power; uniform float arrival; varying vec2 vUv;
#include <fog_pars_fragment>
`;
const RING = `${FRAGMENT_HEADER}
void main() {
  vec2 p=(vUv-.5)*2.0; float r=length(p); float a=atan(p.y,p.x);
  float outer=1.0-smoothstep(.012,.028,abs(r-.92));
  float inner=1.0-smoothstep(.008,.018,abs(r-.68));
  float cell=mod(a+time*.025,6.2831853/24.0)/(6.2831853/24.0);
  float spokes=(1.0-smoothstep(.035,.09,abs(cell-.5)))*smoothstep(.71,.74,r)*(1.0-smoothstep(.84,.87,r));
  float links=(1.0-smoothstep(.007,.018,abs(r-(.77+.045*sin(floor((a+3.14159)*24.0/6.28318)*2.4)))))*step(.22,cell)*(1.0-step(.78,cell));
  float spiral=(1.0-smoothstep(.018,.035,abs(sin(a*3.0-r*12.0))))*smoothstep(.15,.3,r)*(1.0-smoothstep(.5,.6,r))*.35;
  float glow=(outer+inner*.6+spokes*.75+links*.65+spiral)*power;
  gl_FragColor=vec4(accent*1.4,clamp(glow,0.0,.72));
#include <fog_fragment>
}`;
const COLUMN = `${FRAGMENT_HEADER}
void main() {
  float edges=pow(abs(vUv.x-.5)*2.0,5.0)*.22;
  float streak=pow(max(0.0,sin(vUv.x*94.25+sin(vUv.y*5.0-time)*.5)),20.0)*.09;
  float fade=smoothstep(0.0,.07,vUv.y)*(1.0-smoothstep(.2,1.0,vUv.y));
  gl_FragColor=vec4(mix(accent,vec3(1.0,.87,.58),.3)*1.3,(edges+streak+.018)*fade*power*(1.0+arrival*.7));
#include <fog_fragment>
}`;
const WAVE = `${FRAGMENT_HEADER}
void main() { float r=length((vUv-.5)*2.0); float wave=1.0-smoothstep(.018,.045,abs(r-.88));
 gl_FragColor=vec4(accent*1.5,wave*arrival*.5);
#include <fog_fragment>
}`;

/** Local destination presentation; simulation and progress remain owned by the application. */
export class WaystoneVisual {
  readonly group = new Group();
  private readonly effects = new Group();
  private readonly ring: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly column: Mesh<CylinderGeometry, ShaderMaterial>;
  private readonly wave: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly motes: Points<BufferGeometry, ShaderMaterial>;
  private readonly halo: Sprite;
  private readonly meshes: readonly Mesh<BufferGeometry, ShaderMaterial>[];
  private elapsed = 0;
  private openness = 0;
  private arrivalTime = -1;
  private disposed = false;

  private constructor(private readonly native: NativeAssetInstance, position: Readonly<Vec3>, pillarPosition: Readonly<Vec3>, regionId: string) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Waystone crystal halo requires a canvas context.');
    this.group.name = 'warden-waystone';
    const holder = new Group(); holder.position.set(pillarPosition.x, pillarPosition.y, pillarPosition.z); holder.add(native.root);
    this.group.add(holder, this.effects);
    this.effects.position.set(position.x, position.y, position.z);
    const accent = new Color(ACCENTS[regionId] ?? 0xe8d49b);
    const material = (fragmentShader: string) => new ShaderMaterial({ vertexShader: VERTEX, fragmentShader,
      uniforms: UniformsUtils.merge([UniformsLib.fog!, { accent: { value: accent }, time: { value: 0 }, power: { value: .16 }, arrival: { value: 0 } }]),
      transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending, toneMapped: false, fog: true });
    this.ring = new Mesh(new PlaneGeometry(4.8, 4.8), material(RING));
    this.ring.name = 'waystone-runes'; this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = .065;
    this.column = new Mesh(new CylinderGeometry(1.1, 1.8, 7, 32, 1, true), material(COLUMN));
    this.column.name = 'waystone-column'; this.column.position.y = 3.5; this.column.visible = false;
    this.wave = new Mesh(new PlaneGeometry(1, 1), material(WAVE));
    this.wave.name = 'waystone-arrival-wave'; this.wave.rotation.x = -Math.PI / 2; this.wave.position.y = .08; this.wave.visible = false;
    this.effects.add(this.ring, this.column, this.wave);
    this.meshes = [this.ring, this.column, this.wave];
    const seeds = new Float32Array(48 * 3);
    for (let i = 0; i < 48; i++) { seeds[i * 3] = i * 2.39996; seeds[i * 3 + 1] = (i * .618034) % 1; seeds[i * 3 + 2] = .6 + (i % 7) * .18; }
    const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(seeds, 3));
    const points = material(`${FRAGMENT_HEADER}
void main() { float d=length(gl_PointCoord-.5); gl_FragColor=vec4(accent*1.5,(1.0-smoothstep(.1,.5,d))*.55*power);
#include <fog_fragment>
}`);
    points.vertexShader = `uniform float time; uniform float power;
#include <fog_pars_vertex>
void main() { float rise=fract(position.y+time*.09); float angle=position.x+time*.2; vec3 p=vec3(cos(angle)*position.z,rise*5.5,sin(angle)*position.z);
vec4 mvPosition=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mvPosition; gl_PointSize=clamp(80.0/max(1.0,-mvPosition.z),1.0,5.0)*sin(rise*3.14159);
#include <fog_vertex>
}`;
    this.motes = new Points(geometry, points); this.motes.frustumCulled = false; this.motes.name = 'waystone-motes'; this.effects.add(this.motes);
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32); gradient.addColorStop(0, '#fff3ca'); gradient.addColorStop(.15, '#ead094b0'); gradient.addColorStop(1, '#ead09400');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
    this.halo = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), color: accent, blending: AdditiveBlending, depthWrite: false, toneMapped: false, opacity: .2 }));
    this.halo.name = 'waystone-crystal-glow'; this.halo.position.set(pillarPosition.x, pillarPosition.y + 3.9, pillarPosition.z); this.halo.scale.set(1.3, 1.3, 1.3); this.group.add(this.halo);
  }

  static async load(scene: Scene, loader: NativeAssetLoader, manifest: AssetManifestEntry, position: Readonly<Vec3>, pillarPosition: Readonly<Vec3>, regionId: string): Promise<WaystoneVisual> {
    const native = await loader.load(manifest);
    try { const visual = new WaystoneVisual(native, position, pillarPosition, regionId); scene.add(visual.group); return visual; }
    catch (error) { native.dispose(); throw error; }
  }

  beginArrival(): void { if (this.arrivalTime < 0) this.arrivalTime = 0; }

  update(deltaSeconds: number, open: boolean, reducedMotion: boolean): void {
    if (this.disposed) return;
    const dt = Math.max(0, Math.min(.1, deltaSeconds));
    if (!reducedMotion) this.elapsed += dt;
    this.openness = open ? Math.min(1, this.openness + dt / 1.2) : 0;
    if (this.arrivalTime >= 0) this.arrivalTime = Math.min(1.8, this.arrivalTime + dt);
    const burst = !reducedMotion && this.arrivalTime >= 0 ? Math.sin(this.arrivalTime / 1.8 * Math.PI) : 0;
    const power = .16 + this.openness * .7;
    for (const mesh of this.meshes) { mesh.material.uniforms.time!.value = this.elapsed; mesh.material.uniforms.power!.value = power; mesh.material.uniforms.arrival!.value = burst; }
    this.column.visible = this.openness > 0;
    this.motes.visible = !reducedMotion;
    this.motes.material.uniforms.time!.value = this.elapsed; this.motes.material.uniforms.power!.value = power;
    this.wave.visible = burst > .01;
    const size = 3 + Math.max(0, this.arrivalTime) * 5; this.wave.scale.set(size, size, 1);
    this.halo.material.opacity = .18 + this.openness * .42 + burst * .15;
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.group.removeFromParent(); this.native.dispose();
    for (const mesh of this.meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
    this.motes.geometry.dispose(); this.motes.material.dispose(); this.halo.material.map?.dispose(); this.halo.material.dispose();
  }
}
