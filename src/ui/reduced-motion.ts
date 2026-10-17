/** True when the operating system asks for reduced motion; the in-game setting is read separately from `GameSettings`. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
