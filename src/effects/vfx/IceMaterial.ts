import { Color, FrontSide, ShaderMaterial, type IUniform } from 'three';

const VERTEX = /* glsl */`
uniform float uHeightBase;
uniform float uHeightScale;
varying vec3 vNormalView;
varying vec3 vViewDir;
varying float vHeight;
void main() {
  vec4 local = vec4(position, 1.0);
  vec3 objectNormal = normal;
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  vec4 mv = modelViewMatrix * local;
  vNormalView = normalize(normalMatrix * objectNormal);
  vViewDir = normalize(-mv.xyz);
  vHeight = (position.y - uHeightBase) * uHeightScale;
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = /* glsl */`
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uRim;
uniform float uOpacity;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uTime;
varying vec3 vNormalView;
varying vec3 vViewDir;
varying float vHeight;
void main() {
  float nl = length(vNormalView);
  vec3 n = nl > 1e-4 ? vNormalView / nl : vec3(0.0, 1.0, 0.0);
  if (!gl_FrontFacing) n = -n;
  float vl = length(vViewDir);
  vec3 v = vl > 1e-4 ? vViewDir / vl : vec3(0.0, 0.0, 1.0);
  float facing = clamp(abs(dot(n, v)), 0.0, 1.0);
  float fresnel = pow(1.0 - facing, uRimPower);
  float h = clamp(vHeight, 0.0, 1.0);
  vec3 body = mix(uDeep, uMid, clamp(h * 0.8 + 0.25 * n.y, 0.0, 1.0));
  float glint = pow(max(0.0, dot(n, vec3(0.3500, 0.8001, 0.4500) / 0.9845)), 28.0);
  float shimmer = 0.85 + 0.15 * sin(uTime * 2.3 + h * 9.0 + n.x * 4.0);
  // Cyan rim and a thin glint: the only near-white is the specular pin-point.
  vec3 color = body * shimmer + uRim * fresnel * uRimStrength + vec3(0.9, 1.5, 2.0) * glint;
  gl_FragColor = vec4(clamp(color, vec3(0.0), vec3(4.0)), clamp(mix(uOpacity, 1.0, fresnel), 0.0, 1.0));
}`;

export type IceUniforms = {
  uDeep: IUniform<Color>; uMid: IUniform<Color>; uRim: IUniform<Color>; uOpacity: IUniform<number>;
  uRimPower: IUniform<number>; uRimStrength: IUniform<number>; uTime: IUniform<number>;
  uHeightBase: IUniform<number>; uHeightScale: IUniform<number>;
};

export type IceMaterial = ShaderMaterial & { uniforms: IceUniforms };

/**
 * Unlit translucent crystal: view-dependent fresnel rim (HDR, blooms) over a height-graded body.
 * Works for plain and instanced meshes; facet normals come from non-indexed geometry.
 */
export function createIceMaterial(options: { opacity: number; transparent: boolean; heightBase: number; heightScale: number; rimStrength?: number }): IceMaterial {
  const uniforms: IceUniforms = {
    uDeep: { value: new Color().setRGB(0.03, 0.14, 0.32) }, uMid: { value: new Color().setRGB(0.32, 0.68, 0.95) },
    uRim: { value: new Color().setRGB(0.35, 0.8, 1) }, uOpacity: { value: options.opacity },
    uRimPower: { value: 2.4 }, uRimStrength: { value: Math.min(1.8, options.rimStrength ?? 1.6) }, uTime: { value: 0 },
    uHeightBase: { value: options.heightBase }, uHeightScale: { value: options.heightScale },
  };
  const material = new ShaderMaterial({
    name: 'vfx-ice-crystal', vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms,
    transparent: options.transparent, depthWrite: !options.transparent, side: FrontSide,
  });
  return Object.assign(material, { uniforms });
}
