import { ShaderChunk } from 'three';

/**
 * three's PCFSoftShadowMap costs 16 depth fetches (each unpacking an RGBA8 depth) per shadow-receiving
 * fragment. The visual ground is the largest receiver on screen, so its material (and the small
 * ground-cover materials) swap that kernel for a cheaper one through `onBeforeCompile`:
 *  - 'bilinear': 4 fetches weighted like a hardware-filtered compare on a 1.5-texel virtual grid, i.e. a
 *    penumbra of about three shadow texels, which matches the width of the PCFSoft kernel it replaces.
 *  - 'hard': a single fetch, for blades and pebbles whose own detail hides any edge softness.
 * Non-PCF-soft builds, or a three release whose chunk text differs, keep the stock chunk untouched.
 */
export type ShadowKernel = 'bilinear' | 'hard';

const SOFT_BEGIN = '#elif defined( SHADOWMAP_TYPE_PCF_SOFT )';
const SOFT_END = '#elif defined( SHADOWMAP_TYPE_VSM )';

const BILINEAR = `#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			vec2 shadowTexel = vec2( 1.0 ) / shadowMapSize;
			vec2 shadowGrid = shadowCoord.xy * shadowMapSize / 1.5 - 0.5;
			vec2 shadowBase = floor( shadowGrid );
			vec2 shadowFrac = shadowGrid - shadowBase;
			vec2 shadowUv = ( shadowBase + 0.5 ) * 1.5 * shadowTexel;
			vec2 shadowStep = 1.5 * shadowTexel;
			shadow = mix(
				mix( texture2DCompare( shadowMap, shadowUv, shadowCoord.z ), texture2DCompare( shadowMap, shadowUv + vec2( shadowStep.x, 0.0 ), shadowCoord.z ), shadowFrac.x ),
				mix( texture2DCompare( shadowMap, shadowUv + vec2( 0.0, shadowStep.y ), shadowCoord.z ), texture2DCompare( shadowMap, shadowUv + shadowStep, shadowCoord.z ), shadowFrac.x ),
				shadowFrac.y );
		`;

const HARD = `#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			shadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );
		`;

const cache: Partial<Record<ShadowKernel, string>> = {};

function patchedChunk(kernel: ShadowKernel): string {
  const cached = cache[kernel];
  if (cached) return cached;
  const source = ShaderChunk.shadowmap_pars_fragment;
  const begin = source.indexOf(SOFT_BEGIN);
  const end = source.indexOf(SOFT_END);
  const patched = begin >= 0 && end > begin ? source.slice(0, begin) + (kernel === 'hard' ? HARD : BILINEAR) + source.slice(end) : source;
  cache[kernel] = patched;
  return patched;
}

/** Returns the fragment shader with the receiver's PCFSoft kernel replaced by the requested cheaper one. */
export function withCheapShadows(fragmentShader: string, kernel: ShadowKernel): string {
  return fragmentShader.replace('#include <shadowmap_pars_fragment>', patchedChunk(kernel));
}

/** True when the stock chunk could be patched (used by tests to catch a three upgrade that changes the text). */
export function shadowKernelPatchable(): boolean {
  const source = ShaderChunk.shadowmap_pars_fragment;
  const begin = source.indexOf(SOFT_BEGIN);
  return begin >= 0 && source.indexOf(SOFT_END) > begin;
}
