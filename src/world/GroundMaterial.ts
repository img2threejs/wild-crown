import {
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  ClampToEdgeWrapping,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
  Vector4,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { SplatProfile } from './BiomeProfile';
import type { GroundMask } from './GroundMask';
import { withCheapShadows } from './GroundShadow';

/** The ground is ~10x minified at the fixed camera (≈35° elevation), so modest anisotropy is indistinguishable from 8x. */
const ANISOTROPY_ALBEDO = 4;
const ANISOTROPY_NORMAL = 2;

const VERTEX_PARS = `
varying vec3 vSplatPos;`;

const fixed = (value: number): string => value.toFixed(4);
const vec3 = (value: readonly [number, number, number]): string => `vec3(${fixed(value[0])}, ${fixed(value[1])}, ${fixed(value[2])})`;

/** Light through a canopy: slowly drifting patches of light and shade on the ground (two crossed trig fields, no fetches). */
function dappleCode(splat: SplatProfile): string {
  const dapple = splat.dapple;
  if (!dapple) return '';
  const scale = dapple.scale;
  return `
float dappleA = sin(vSplatPos.x * ${fixed(scale)} + 1.3 * sin(vSplatPos.z * ${fixed(scale * 0.8)} + uDappleTime * ${fixed(0.21 * dapple.speed)}));
float dappleB = sin(vSplatPos.z * ${fixed(scale * 1.15)} - uDappleTime * ${fixed(0.17 * dapple.speed)} + 1.1 * sin(vSplatPos.x * ${fixed(scale * 0.7)}));
float dapple = smoothstep(-0.35, 0.65, dappleA * dappleB);
splatAlbedo *= 1.0 - ${fixed(dapple.strength)} * (1.0 - dapple) + ${fixed(dapple.strength * 0.25)} * dapple;`;
}

/**
 * Per-fragment budget (the ground is the biggest surface on screen): two mask fetches, a third only inside the
 * trail's footprint, and one to three albedo+normal pairs depending on which layers carry weight. No noise is
 * evaluated per fragment: patch noise, anti-tiling cross-fade and edge grain are baked into the masks.
 */
function fragmentPars(layerCount: number): string {
  const samplers = Array.from({ length: layerCount }, (_, index) => `uniform sampler2D uAlbedo${index};\nuniform sampler2D uNrm${index};`).join('\n');
  const tints = [0, 1, 2, 3].map((index) => `uniform vec3 uTint${index};`).join('\n');
  return `
uniform sampler2D uMaskA;
uniform sampler2D uMaskB;
${samplers}
uniform vec4 uMaskRect;
uniform float uLayerScale[${layerCount}];
${tints}
uniform sampler2D uMaskC;
uniform vec4 uTerrainRect;
uniform vec3 uRockTint;
uniform vec3 uMudTint;
uniform vec3 uBedTint;
varying vec3 vSplatPos;
uniform float uDappleTime;

const mat2 SPLAT_ROT = mat2(0.8, 0.6, -0.6, 0.8);
// Ground texels are ~10x minified at the fixed camera, so one extra mip level is invisible and keeps fetches in cache.
const float SPLAT_LOD_BIAS = 1.3;

float splatSq(float v) {
  return v * v;
}

// out nrmOut = (tangent normal xy in [-1,1], roughness, ambient occlusion)
void splatSingle(sampler2D albedoTex, sampler2D nrmTex, vec2 p, vec2 dx, vec2 dy, float scale, out vec3 albedo, out vec4 nrmOut) {
  vec2 uv = p * scale;
  albedo = textureGrad(albedoTex, uv, dx * scale, dy * scale).rgb;
  vec4 n = textureGrad(nrmTex, uv, dx * scale, dy * scale);
  nrmOut = vec4(n.xy * 2.0 - 1.0, n.zw);
}

// Forest litter covers most of the screen: its albedo is cross-faded between two incommensurate scales to break tiling.
void splatDual(sampler2D albedoTex, sampler2D nrmTex, vec2 p, vec2 dx, vec2 dy, float scale, float blend, out vec3 albedo, out vec4 nrmOut) {
  float scaleB = scale * 0.43;
  // The first scale is warped by the baked noise (blend) and the mix is tinted by it, so no regular rows survive at the fixed camera.
  vec2 pw = p + (blend - 0.5) * 1.1;
  vec3 aA = textureGrad(albedoTex, pw * scale, dx * scale, dy * scale).rgb;
  vec3 aB = textureGrad(albedoTex, SPLAT_ROT * p * scaleB + vec2(0.37, 0.71), SPLAT_ROT * dx * scaleB, SPLAT_ROT * dy * scaleB).rgb;
  albedo = mix(aA, aB, blend * 0.8 + 0.1) * (0.92 + 0.16 * blend);
  vec4 n = textureGrad(nrmTex, p * scale, dx * scale, dy * scale);
  nrmOut = vec4(n.xy * 2.0 - 1.0, n.zw);
}`;
}

/** Computes weights, albedo, tangent normal, roughness, AO and the micro height used for ruts / footprints. */
function splatFragment(splat: SplatProfile): string {
  const { rock, bed, mud, depthShade, macroLow, macroHigh } = splat;
  return `
vec2 splatP = vec2(vSplatPos.x, -vSplatPos.z);
vec2 splatDx = dFdx(splatP) * SPLAT_LOD_BIAS;
vec2 splatDy = dFdy(splatP) * SPLAT_LOD_BIAS;
vec3 splatDPx = dFdx(vSplatPos) * SPLAT_LOD_BIAS;
vec3 splatDPy = dFdy(vSplatPos) * SPLAT_LOD_BIAS;
vec3 splatFaceN = normalize(cross(dFdx(vSplatPos), dFdy(vSplatPos)) + vec3(0.0, 1e-5, 0.0));
vec2 maskUv = (vSplatPos.xz - uMaskRect.xy) * uMaskRect.zw;
vec4 mA = texture2D(uMaskA, maskUv);

float wCore = 0.0;
float wEdge = 0.0;
float splatHeight = 0.0;
float rutDark = 0.0;
if (mA.r + mA.g > 0.004) {
  vec4 mB = textureLod(uMaskB, maskUv, 0.0);
  float grain = (mB.a - 0.5) * 0.22;
  wCore = smoothstep(0.38, 0.62, mA.r + grain);
  wEdge = smoothstep(0.12, 0.45, mA.g + grain) * (1.0 - wCore);
  float trailWeight = smoothstep(0.2, 0.75, mA.r);
  if (trailWeight > 0.004) {
    // Compacted-earth micro relief: two wheel ruts with a worn hump between them and alternating foot prints.
    vec2 stepPhase = mB.rg * 2.0 - 1.0;
    float lateral = (mB.b - 0.5) * 4.0;
    float rutShape = exp(-splatSq((abs(lateral) - 0.42) / 0.11));
    float humpShape = exp(-splatSq(lateral / 0.16));
    float footLeft = smoothstep(0.7, 0.96, -stepPhase.y) * exp(-splatSq((lateral + 0.17) / 0.075));
    float footRight = smoothstep(0.7, 0.96, stepPhase.y) * exp(-splatSq((lateral - 0.17) / 0.075));
    splatHeight = trailWeight * (-0.028 * rutShape + 0.012 * humpShape - 0.02 * (footLeft + footRight));
    rutDark = 0.32 * trailWeight * (0.8 * rutShape + 0.6 * (footLeft + footRight));
  }
}
// Terrain features (only fetched over the rectangle that carries any): rock on steep faces, wet mud and gravel in the channels.
vec4 mC = vec4(0.0);
if (vSplatPos.x > uTerrainRect.x && vSplatPos.x < uTerrainRect.z && vSplatPos.z > uTerrainRect.y && vSplatPos.z < uTerrainRect.w) {
  mC = textureLod(uMaskC, maskUv, 0.0);
}
float wRock = mC.b;
float wBed = mC.g * (1.0 - wRock);
float wMud = mC.r * (1.0 - wRock) * (1.0 - wBed);
float wKeep = 1.0 - clamp(wRock + wBed + wMud, 0.0, 1.0);
wCore *= wKeep;
wEdge *= wKeep;
float wRest = wKeep - wCore - wEdge;
float wMoss = wRest * mA.b;
float wLeaf = wRest - wMoss;

vec3 splatAlbedo = vec3(0.0);
vec4 splatPacked = vec4(0.0);
vec3 layerAlbedo;
vec4 layerPacked;
if (wLeaf > 0.004) {
  splatDual(uAlbedo0, uNrm0, splatP, splatDx, splatDy, uLayerScale[0], mA.a, layerAlbedo, layerPacked);
  splatAlbedo += layerAlbedo * uTint0 * wLeaf;
  splatPacked += layerPacked * wLeaf;
}
if (wMoss > 0.004) {
  splatSingle(uAlbedo1, uNrm1, splatP, splatDx, splatDy, uLayerScale[1], layerAlbedo, layerPacked);
  splatAlbedo += layerAlbedo * uTint1 * wMoss;
  splatPacked += layerPacked * wMoss;
}
if (wCore > 0.004) {
  splatSingle(uAlbedo2, uNrm2, splatP, splatDx, splatDy, uLayerScale[2], layerAlbedo, layerPacked);
  splatAlbedo += layerAlbedo * uTint2 * wCore;
  splatPacked += layerPacked * wCore;
}
if (wEdge > 0.004) {
  splatSingle(uAlbedo3, uNrm3, splatP, splatDx, splatDy, uLayerScale[3], layerAlbedo, layerPacked);
  splatAlbedo += layerAlbedo * uTint3 * wEdge;
  splatPacked += layerPacked * wEdge;
}
if (wRock > 0.004) {
  // Faces are steep: project the rock layer along the face's dominant horizontal axis (no top-down stretching) and band it into strata.
  float rockScale = uLayerScale[${rock.layer}] * ${fixed(rock.scale)};
  float rockAcross = abs(splatFaceN.x) / (abs(splatFaceN.x) + abs(splatFaceN.z) + 1e-4);
  vec2 rockUvX = vec2(vSplatPos.z, vSplatPos.y) * rockScale;
  vec2 rockUvZ = vec2(vSplatPos.x, vSplatPos.y) * rockScale;
  vec3 rockX = textureGrad(uAlbedo${rock.layer}, rockUvX, splatDPx.zy * rockScale, splatDPy.zy * rockScale).rgb;
  vec3 rockZ = textureGrad(uAlbedo${rock.layer}, rockUvZ + vec2(0.31, 0.17), splatDPx.xy * rockScale, splatDPy.xy * rockScale).rgb;
  float strata = 0.5 + 0.5 * sin(vSplatPos.y * 11.0 + 1.7 * sin(vSplatPos.x * 1.9 + vSplatPos.z * 1.3));
  vec3 rockAlbedo = mix(rockZ, rockX, rockAcross) * uRockTint * mix(1.0, 0.74 + 0.34 * strata, ${fixed(splat.strata)});
  splatAlbedo += rockAlbedo * wRock;
  splatPacked += vec4(0.0, 0.0, ${fixed(rock.roughness)}, 0.82) * wRock;
}
if (wBed > 0.004) {
  // Channel-bed pebbles: a stony layer at a finer scale, graded by the profile.
  splatSingle(uAlbedo${bed.layer}, uNrm${bed.layer}, splatP + vec2(3.1, 1.7), splatDx, splatDy, uLayerScale[${bed.layer}] * ${fixed(bed.scale)}, layerAlbedo, layerPacked);
  splatAlbedo += layerAlbedo * uBedTint * wBed;
  splatPacked += vec4(layerPacked.xy, ${fixed(bed.roughness)}, layerPacked.w) * wBed;
}
if (wMud > 0.004) {
  // Wet bank mud: dark, smooth earth.
  splatDual(uAlbedo${mud.layer}, uNrm${mud.layer}, splatP, splatDx, splatDy, uLayerScale[${mud.layer}] * ${fixed(mud.scale)}, mA.a, layerAlbedo, layerPacked);
  splatAlbedo += layerAlbedo * uMudTint * wMud;
  splatPacked += vec4(layerPacked.xy * 0.6, ${fixed(mud.roughness)}, layerPacked.w) * wMud;
}

// Macro variation from two cheap trig fields (about 20 m and 5 m wavelengths) instead of hashed noise.
float splatMacro = 0.5 + 0.28 * sin(vSplatPos.x * 0.052 + 1.7 * sin(vSplatPos.z * 0.031)) + 0.22 * sin(vSplatPos.z * 0.047 - vSplatPos.x * 0.019 + 2.3);
// Deep channel ground sits in the cliffs' shade and under the bridge: darken by depth below the surrounding ground and by the deck-underside weight.
splatAlbedo *= (1.0 - ${fixed(depthShade.strength)} * (1.0 - smoothstep(${fixed(depthShade.bottom)}, ${fixed(depthShade.top)}, vSplatPos.y))) * (1.0 - 0.45 * mC.a);
float splatMacro2 = 0.5 + 0.5 * sin(vSplatPos.x * 0.17 + vSplatPos.z * 0.13 + 1.4 * sin(vSplatPos.x * 0.07 - vSplatPos.z * 0.09));
splatAlbedo *= mix(${vec3(macroLow)}, ${vec3(macroHigh)}, splatMacro) * (0.9 + 0.2 * splatMacro2) * (0.9 + 0.2 * mA.a) * (1.0 - rutDark);${dappleCode(splat)}

vec3 splatTangentNormal = normalize(vec3(splatPacked.xy, sqrt(max(1.0 - dot(splatPacked.xy, splatPacked.xy), 0.04))));
float splatRoughness = clamp(splatPacked.z, 0.4, 1.0);
float splatAO = mix(1.0, splatPacked.w, 0.85);
diffuseColor.rgb *= splatAlbedo;`;
}

const SPLAT_NORMAL = `
{
  vec3 worldN = inverseTransformDirection(normal, viewMatrix);
  vec3 worldT = normalize(vec3(1.0, 0.0, 0.0) - worldN * worldN.x);
  vec3 worldB = cross(worldN, worldT);
  vec3 mapped = normalize(worldT * splatTangentNormal.x + worldB * splatTangentNormal.y + worldN * splatTangentNormal.z);
  normal = normalize(transformDirection(mapped, viewMatrix));
  vec3 sigmaX = dFdx(-vViewPosition);
  vec3 sigmaY = dFdy(-vViewPosition);
  vec3 r1 = cross(sigmaY, normal);
  vec3 r2 = cross(normal, sigmaX);
  float det = dot(sigmaX, r1);
  vec3 grad = sign(det) * (dFdx(splatHeight) * r1 + dFdy(splatHeight) * r2);
  normal = normalize(abs(det) * normal - grad);
}`;

interface SplatUniforms {
  maskA: { value: Texture };
  maskB: { value: Texture };
  maskC: { value: Texture };
  terrainRect: { value: Vector4 };
  rockTint: { value: Color };
  mudTint: { value: Color };
  bedTint: { value: Color };
  albedo: Array<{ value: Texture }>;
  nrm: Array<{ value: Texture }>;
  maskRect: { value: Vector4 };
  layerScale: { value: number[] };
  tint: Array<{ value: Color }>;
}

interface PixelBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

async function loadPixels(url: string): Promise<PixelBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Ground texture ${url} failed to load (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Ground textures require a 2D canvas context.');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: image.width, height: image.height, data: image.data };
}

/**
 * Ground shading of one biome. One MeshStandardMaterial (lights, shadow map and fog untouched) whose albedo / normal /
 * roughness / AO come from the profile's Poly Haven layers (litter, moss, compacted trail earth, gravel shoulder and, for
 * features, a river-gravel layer) weighted by the baked splat mask. Normal, roughness and AO are packed per layer into one
 * RGBA texture so the shader samples two textures per layer per scale. Steep faces (embankments, summits, channel banks),
 * wet mud and channel-bed gravel re-use profile layers (projected along the face, graded) through the terrain mask.
 */
export class GroundMaterial {
  readonly material: MeshStandardMaterial;
  /** Resolves once every layer texture is uploaded; rejects if any file is missing. */
  readonly ready: Promise<void>;
  private readonly uniforms: SplatUniforms;
  private readonly textures: Texture[] = [];
  private readonly placeholders: Texture[] = [];
  private readonly dappleTime = { value: 0 };
  private disposed = false;

  constructor(mask: GroundMask, private readonly splat: SplatProfile, profileId: string) {
    const maskA = this.dataTexture(mask.shade, mask.width, mask.height);
    const maskB = this.dataTexture(mask.detail, mask.detailWidth, mask.detailHeight);
    const maskC = this.dataTexture(mask.terrain, mask.width, mask.height);
    this.textures.push(maskA, maskB, maskC);
    const { rock, bed, mud, layers } = splat;
    this.uniforms = {
      maskA: { value: maskA },
      maskB: { value: maskB },
      maskC: { value: maskC },
      terrainRect: { value: new Vector4(...mask.terrainRect) },
      rockTint: { value: new Color().setRGB(...rock.tint) },
      mudTint: { value: new Color().setRGB(...mud.tint) },
      bedTint: { value: new Color().setRGB(...bed.tint) },
      albedo: layers.map(() => ({ value: this.placeholder(new Uint8Array([96, 84, 62, 255])) })),
      nrm: layers.map(() => ({ value: this.placeholder(new Uint8Array([128, 128, 230, 255])) })),
      maskRect: { value: new Vector4(mask.minX, mask.minZ, 1 / (mask.width * mask.texel), 1 / (mask.height * mask.texel)) },
      layerScale: { value: layers.map((layer) => 1 / layer.metersPerTile) },
      tint: layers.slice(0, 4).map((layer) => ({ value: new Color().setRGB(layer.tint[0], layer.tint[1], layer.tint[2]) })),
    };
    this.material = new MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    this.material.name = `${profileId}-ground`;
    const pars = fragmentPars(layers.length);
    const fragment = splatFragment(splat);
    this.material.onBeforeCompile = (shader) => this.patchShader(shader, pars, fragment);
    this.material.customProgramCacheKey = () => `${profileId}-ground`;
    this.ready = this.loadLayers();
  }

  /** Advances the canopy dapple from the shared world clock (no-op for profiles without one). */
  update(worldTimeSeconds: number): void {
    this.dappleTime.value = worldTimeSeconds;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.material.dispose();
    for (const texture of this.textures) texture.dispose();
    for (const texture of this.placeholders) texture.dispose();
    this.textures.length = 0;
    this.placeholders.length = 0;
  }

  private dataTexture(data: Uint8Array, width: number, height: number): DataTexture {
    const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
    texture.minFilter = texture.magFilter = LinearFilter;
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  private placeholder(pixel: Uint8Array): DataTexture {
    const texture = new DataTexture(pixel, 1, 1, RGBAFormat, UnsignedByteType);
    texture.needsUpdate = true;
    this.placeholders.push(texture);
    return texture;
  }

  private async loadLayers(): Promise<void> {
    const loader = new TextureLoader();
    await Promise.all(this.splat.layers.map(async (layer, index) => {
      const base = `${this.splat.textureRoot}/${layer.id}`;
      const [albedo, normal, arm] = await Promise.all([loader.loadAsync(`${base}/diffuse.jpg`), loadPixels(`${base}/normal.jpg`), loadPixels(`${base}/arm.jpg`)]);
      if (this.disposed) {
        albedo.dispose();
        return;
      }
      albedo.colorSpace = SRGBColorSpace;
      albedo.wrapS = albedo.wrapT = RepeatWrapping;
      albedo.anisotropy = ANISOTROPY_ALBEDO;
      albedo.needsUpdate = true;
      const { width, height } = normal;
      const packed = new Uint8Array(width * height * 4);
      // Rows are flipped so the packed texture shares the diffuse texture's flipY = true orientation.
      for (let row = 0; row < height; row++) {
        const source = row * width * 4;
        const target = (height - 1 - row) * width * 4;
        for (let col = 0; col < width; col++) {
          const s = source + col * 4;
          const t = target + col * 4;
          packed[t] = normal.data[s]!;
          packed[t + 1] = normal.data[s + 1]!;
          packed[t + 2] = arm.data[s + 1]!;
          packed[t + 3] = arm.data[s]!;
        }
      }
      const nrm = new DataTexture(packed, width, height, RGBAFormat, UnsignedByteType);
      nrm.wrapS = nrm.wrapT = RepeatWrapping;
      nrm.minFilter = LinearMipmapLinearFilter;
      nrm.magFilter = LinearFilter;
      nrm.generateMipmaps = true;
      nrm.anisotropy = ANISOTROPY_NORMAL;
      nrm.needsUpdate = true;
      this.textures.push(albedo, nrm);
      this.uniforms.albedo[index]!.value = albedo;
      this.uniforms.nrm[index]!.value = nrm;
    }));
  }

  /** Uploaded texture bytes (mask textures plus layer albedo / packed normals with their mip chains), for budget reporting. */
  get textureBytes(): number {
    let bytes = 0;
    for (const texture of this.textures) {
      const image = texture.image as { width: number; height: number } | undefined;
      if (!image) continue;
      bytes += image.width * image.height * 4 * (texture.generateMipmaps || texture.minFilter === LinearMipmapLinearFilter ? 4 / 3 : 1);
    }
    return Math.round(bytes);
  }

  private patchShader(shader: WebGLProgramParametersWithUniforms, pars: string, fragment: string): void {
    const uniforms = this.uniforms;
    shader.uniforms.uMaskA = uniforms.maskA;
    shader.uniforms.uMaskB = uniforms.maskB;
    shader.uniforms.uMaskC = uniforms.maskC;
    shader.uniforms.uTerrainRect = uniforms.terrainRect;
    shader.uniforms.uRockTint = uniforms.rockTint;
    shader.uniforms.uMudTint = uniforms.mudTint;
    shader.uniforms.uBedTint = uniforms.bedTint;
    shader.uniforms.uMaskRect = uniforms.maskRect;
    shader.uniforms.uLayerScale = uniforms.layerScale;
    shader.uniforms.uDappleTime = this.dappleTime;
    for (let index = 0; index < uniforms.albedo.length; index++) {
      shader.uniforms[`uAlbedo${index}`] = uniforms.albedo[index]!;
      shader.uniforms[`uNrm${index}`] = uniforms.nrm[index]!;
    }
    for (let index = 0; index < uniforms.tint.length; index++) shader.uniforms[`uTint${index}`] = uniforms.tint[index]!;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${VERTEX_PARS}`)
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSplatPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = withCheapShadows(shader.fragmentShader, 'bilinear')
      .replace('#include <common>', `#include <common>${pars}`)
      .replace('#include <map_fragment>', fragment)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = splatRoughness;')
      .replace('#include <normal_fragment_maps>', SPLAT_NORMAL)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= splatAO;');
  }
}
