import type { HeroId } from '../../heroes.js';
import type { HeroKit, KitFactory, KitHost } from './KitHost.js';
import { createSakdaKit } from './SakdaKit.js';
import { createVesperKit } from './VesperKit.js';

/**
 * Hero kit factories. A hero without an entry plays Aren's kit (Yara's engine paths aside); tests register their own
 * factory and remove it afterwards.
 */
export const KIT_FACTORIES: Partial<Record<HeroId, KitFactory>> = { vesper: createVesperKit, sakda: createSakdaKit };

export function createKit(heroId: HeroId, host: KitHost): HeroKit | undefined {
  return KIT_FACTORIES[heroId]?.(host);
}
