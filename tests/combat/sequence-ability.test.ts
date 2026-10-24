import { describe, expect, it } from 'bun:test';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { HEROES } from '../../src/game/heroes.js';

const idle: CombatInput = { tick: 0, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

/** The application chooses the contextual Q flags from the engine's currently advertised skill. */
function pressAbility(engine: CombatEngine): void {
  const skills = engine.snapshot().skills;
  engine.fixedStep({ ...idle, abilityPressed: 'contextual', tetherPressed: skills.some(skill => skill.id === 'root_tether'), cleansePressed: skills.some(skill => skill.id === 'cleanse') });
}

describe('contextual ability during authored cleanse openings', () => {
  for (const hero of HEROES) {
    for (const encounter of [
      { id: 'encounter-koro', regionId: 'whispering-canopy', bossId: 'koro', step: 'thorn-exposed', phaseIndex: 1 },
      { id: 'encounter-asha', regionId: 'blood-bamboo-valley', bossId: 'asha', step: 'exposed', phaseIndex: 2 },
    ] as const) {
      it(`${hero.id} can tether the already-stunned ${encounter.bossId}, then cleanse with the same ability binding`, () => {
        const engine = new CombatEngine(), runId = `sequence-${hero.id}-${encounter.bossId}`;
        engine.loadRegion({ regionId: encounter.regionId, runId, presentActorIds: [encounter.bossId] });
        engine.setPlayerHero(hero.id);
        engine.startEncounter({ encounterId: encounter.id, regionId: encounter.regionId, runId });
        // Isolate a genuine late-fight opening, not the route/quest prerequisites or the player's save.
        const opening = JSON.parse(engine.serialize());
        const boss = opening.actors.find((actor: { id: string }) => actor.id === encounter.bossId);
        const player = opening.actors.find((actor: { id: string }) => actor.id === opening.playerId);
        player.position = { x: boss.position.x - 2, y: boss.position.y, z: boss.position.z };
        player.facing = { x: 1, y: 0, z: 0 };
        opening.targetId = boss.id;
        opening.phaseIndex = encounter.phaseIndex;
        opening.player.mana = 50;
        opening.chapter.sequence.step = encounter.step;
        opening.chapter.sequence.until = opening.worldTick + 420;
        boss.ferocity = 25;
        boss.staggerUntil = opening.worldTick + 420;
        if (encounter.bossId === 'asha') {
          boss.cleansedCoreIds = boss.corruptionCoreIds.slice(0, 2);
          boss.corruption = 34;
        }
        engine.restore(JSON.stringify(opening));

        expect(engine.snapshot().skills.find(skill => skill.binding === 'ability')?.id).toBe('root_tether');
        pressAbility(engine);
        let tethered = false;
        for (let tick = 0; tick < 300; tick++) {
          const snapshot = engine.snapshot();
          tethered ||= snapshot.encounterStatus?.sequence?.step === 'tethered';
          if (snapshot.boss?.corruption === 0) break;
          if (snapshot.skills.some(skill => skill.id === 'cleanse' && skill.available)) pressAbility(engine);
          else engine.fixedStep(idle);
        }
        const result = engine.snapshot();
        expect(tethered).toBe(true);
        expect(result.player.mana).toBe(0);
        expect(result.actors.find(actor => actor.id === boss.id)?.allegiance).toBe('ally');
        expect(result.events.some(event => event.type === 'encounter-resolved' && event.encounterId === encounter.id && event.resolution === 'cleansed')).toBe(true);
      });
    }
  }
});
