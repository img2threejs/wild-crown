import { describe, expect, it } from 'bun:test';
import {
  GETUP_LEAD_SECONDS, HERO_LYING_ANGLE, KNOCKDOWN_CLIP_TIMING, ReactionPresenter, createReactionPose, fallSeconds, getupLeadSeconds, hitSideOf, impulseEnvelope, localReactionDirection, poiseBarModel,
  resolveReactionPose, sideRecoilWeight, type ReactionContext,
} from '../../src/rendering/ReactionPresenter.js';
import { REACTION_TICKS } from '../../src/game/combat/reactions.js';
import type { CombatReactionKind, CombatReactionSnapshot } from '../../src/game/contracts.js';

const context = (partial: Partial<ReactionContext> = {}): ReactionContext => ({
  body: 'monster', clockSeconds: 0, bodyHeight: 1.7, hasHit: true, hasKnockdown: true, hasKnockdownForward: true, afterLaunch: false, getupLead: 0,
  attacking: false, phase: 0, progress: 0, motionScale: 1, ...partial,
});
const reaction = (kind: CombatReactionKind, progress: number, partial: Partial<CombatReactionSnapshot> = {}): CombatReactionSnapshot => ({
  kind, direction: { x: 0, y: 0, z: -1 }, side: 'front', strength: 0.8, progress, durationTicks: 90, serial: 1, ...partial,
});
const pose = (r: CombatReactionSnapshot | undefined, c: ReactionContext) => resolveReactionPose(createReactionPose(), r, { ...c, progress: r?.progress ?? 0 });

describe('hit direction mapping', () => {
  // A body facing +Z (yaw 0): the attacker stands opposite the push.
  it('names the side the attacker came from', () => {
    expect(hitSideOf(0, -1, 0)).toBe('front');
    expect(hitSideOf(0, 1, 0)).toBe('back');
    expect(hitSideOf(-1, 0, 0)).toBe('left');
    expect(hitSideOf(1, 0, 0)).toBe('right');
  });

  it('follows the facing: the same world push is a different side for a turned body', () => {
    expect(hitSideOf(0, -1, Math.PI)).toBe('back');
    expect(hitSideOf(0, -1, Math.PI / 2)).toBe('right');
    expect(hitSideOf(0, -1, -Math.PI / 2)).toBe('left');
  });

  it('resolves the push into forward and right components of the body', () => {
    const local = { forward: 0, right: 0 };
    localReactionDirection(0, 1, 0, local);
    expect(local.forward).toBeCloseTo(1, 12);
    expect(local.right).toBeCloseTo(0, 12);
    localReactionDirection(-1, 0, 0, local);
    expect(local.forward).toBeCloseTo(0, 12);
    expect(local.right).toBeCloseTo(1, 12);
    localReactionDirection(0, 1, Math.PI / 2, local);
    expect(local.right).toBeCloseTo(1, 12);
  });

  it('weights the native recoil by side so a hit from behind leans on the procedural arch', () => {
    expect(sideRecoilWeight('front')).toBe(1);
    expect(sideRecoilWeight('back')).toBeLessThan(sideRecoilWeight('left'));
    const front = pose(reaction('flinch', 0.1, { side: 'front' }), context({ body: 'hero' }));
    const back = pose(reaction('flinch', 0.1, { side: 'back' }), context({ body: 'hero' }));
    expect(back.overlayShare).toBeLessThan(front.overlayShare);
    expect(back.overlayShare).toBeGreaterThan(0);
  });
});

describe('flinch and stagger', () => {
  it('a hero flinch is an aren-hit overlay with a directional bend; a monster flinch leaves the overlay to the profiles', () => {
    const hero = pose(reaction('flinch', 0.12), context({ body: 'hero' }));
    expect(hero.overlayAction).toBe('aren-hit');
    expect(hero.baseAction).toBeUndefined();
    expect(hero.spine).toBeGreaterThan(0);
    expect(hero.dirZ).toBe(-1);
    const monster = pose(reaction('flinch', 0.12), context());
    expect(monster.overlayAction).toBeUndefined();
    expect(monster.spine).toBeGreaterThan(0);
  });

  it('an overlay over an attack pose keeps less of the recoil', () => {
    const free = pose(reaction('flinch', 0.12), context({ body: 'hero' }));
    const attacking = pose(reaction('flinch', 0.12), context({ body: 'hero', attacking: true }));
    expect(attacking.overlayShare).toBeLessThan(free.overlayShare);
  });

  it('a stagger replaces the clip: monsters sweep the hurt window, heroes play aren-hit', () => {
    const monster = [0, 0.5, 1].map(p => pose(reaction('stagger', p), context()));
    expect(monster.every(r => r.baseAction === 'monster-hurt')).toBe(true);
    expect(monster[0]!.baseTime).toBeLessThan(monster[1]!.baseTime);
    expect(monster[1]!.baseTime).toBeLessThan(monster[2]!.baseTime);
    expect(monster[2]!.baseTime).toBeLessThanOrEqual(0.8 + 1e-9);
    const hero = pose(reaction('stagger', 0.5), context({ body: 'hero' }));
    expect(hero.baseAction).toBe('aren-hit');
    expect(hero.baseTime).toBeCloseTo(0.5, 12);
  });

  it('never names a clip the rig does not carry', () => {
    const none = pose(reaction('stagger', 0.5), context({ hasHit: false, hasKnockdown: false, hasKnockdownForward: false }));
    expect(none.baseAction).toBeUndefined();
    expect(none.tilt).toBeGreaterThan(0);
  });
});

describe('knockback', () => {
  it('tilts the body along the push, peaks early and returns upright', () => {
    const tilt = [0, 0.1, 0.25, 0.5, 0.8, 1].map(p => pose(reaction('knockback', p), context({ body: 'hero' })).tilt);
    expect(tilt[0]).toBe(0);
    expect(Math.max(...tilt)).toBeGreaterThan(0.3);
    expect(tilt[2]!).toBeGreaterThan(tilt[1]!);
    expect(tilt[5]!).toBeLessThan(1e-9);
  });

  it('scales the tilt by strength and by body mass', () => {
    const light = pose(reaction('knockback', 0.3, { strength: 0.2 }), context({ body: 'hero' })).tilt;
    const hard = pose(reaction('knockback', 0.3, { strength: 1 }), context({ body: 'hero' })).tilt;
    expect(hard).toBeGreaterThan(light * 1.3);
    const small = pose(reaction('knockback', 0.3), context({ bodyHeight: 1.2 })).tilt;
    const big = pose(reaction('knockback', 0.3), context({ bodyHeight: 3.6 })).tilt;
    expect(big).toBeLessThan(small);
  });

  it('kicks dust only while the body slides', () => {
    expect(pose(reaction('knockback', 0.02), context()).dust).toBe(0);
    expect(pose(reaction('knockback', 0.4), context()).dust).toBeGreaterThan(0.5);
    expect(pose(reaction('knockback', 0.99), context()).dust).toBeLessThan(0.05);
  });
});

describe('knockdown sequence (authored clips)', () => {
  const seconds = 82 / 60;
  const kd = (t: number, c: ReactionContext, partial: Partial<CombatReactionSnapshot> = {}) => pose(reaction('knockdown', t / seconds, { durationTicks: 82, ...partial }), c);

  it.each(['hero', 'monster'] as const)('%s: the authored fall touches down when the simulated fall ends, settles, then holds the lying pose', body => {
    const timing = KNOCKDOWN_CLIP_TIMING[body], c = context({ body }), fall = fallSeconds(0.8, seconds);
    expect(kd(0, c).baseTime).toBe(0);
    expect(kd(fall / 2, c).baseTime).toBeCloseTo(timing.contact / 2, 9);
    expect(kd(fall, c).baseTime).toBeCloseTo(timing.contact, 9);
    const settled = fall + (timing.hold - timing.contact) * timing.fallSeconds;
    expect(kd(settled, c).baseTime).toBeCloseTo(timing.hold, 9);
    // The clip owns the body: no rigid procedural tilt or bounce on top of it.
    expect(kd(fall, c).tilt).toBe(0);
    expect(kd(fall + 0.03, c).lift).toBe(0);
  });

  it('a hero hit from behind falls onto the stomach and gets up from it; from the front onto the back', () => {
    const hero = context({ body: 'hero' });
    expect(kd(0.2, hero, { side: 'back' }).baseAction).toBe('aren-knockdown-forward');
    expect(kd(0.2, hero, { side: 'front' }).baseAction).toBe('aren-knockdown');
    expect(kd(0.2, hero, { side: 'left' }).baseAction).toBe('aren-knockdown');
    expect(pose(reaction('getup', 0.5, { side: 'back', durationTicks: REACTION_TICKS.getup }), hero).baseAction).toBe('aren-getup-forward');
    // A rig without the stomach pair still falls onto its back.
    expect(kd(0.2, context({ body: 'hero', hasKnockdownForward: false }), { side: 'back' }).baseAction).toBe('aren-knockdown');
  });

  it('starts the get-up clip in the last part of the lie and finishes it exactly when the get-up reaction ends', () => {
    const body = 'hero', strength = 0.8, lead = getupLeadSeconds(body, strength, seconds, false), c = context({ body });
    expect(lead).toBeGreaterThan(0);
    expect(lead).toBeLessThanOrEqual(GETUP_LEAD_SECONDS);
    expect(kd(seconds - lead - 0.01, c).baseAction).toBe('aren-knockdown');
    const atLieEnd = kd(seconds, c);
    expect(atLieEnd.baseAction).toBe('aren-getup');
    const getupSeconds = REACTION_TICKS.getup / 60;
    expect(atLieEnd.baseTime).toBeCloseTo(lead / (lead + getupSeconds), 9);
    // The get-up reaction continues the same clip time from where the knockdown left it and ends on 1.
    const up = (p: number) => pose(reaction('getup', p, { durationTicks: REACTION_TICKS.getup }), context({ body, getupLead: lead }));
    expect(up(0).baseTime).toBeCloseTo(atLieEnd.baseTime, 9);
    expect(up(1).baseTime).toBe(1);
  });

  it('after a launch the knockdown lies from its first frame and the launch carries the fall through the air', () => {
    const c = context({ body: 'hero' });
    expect(kd(0, context({ body: 'hero', afterLaunch: true })).baseTime).toBe(KNOCKDOWN_CLIP_TIMING.hero.hold);
    const launch = (p: number) => pose(reaction('launch', p, { durationTicks: REACTION_TICKS.launch }), c);
    expect(launch(0).baseTime).toBe(0);
    expect(launch(1).baseTime).toBeCloseTo(KNOCKDOWN_CLIP_TIMING.hero.contact, 9);
    expect(launch(0.5).lift).toBeGreaterThan(0.5);
    expect(launch(0.5).tilt).toBe(0);
  });

  it('the fall never outlasts half of the knockdown and grows with strength', () => {
    expect(fallSeconds(1, 0.4)).toBeCloseTo(0.2, 12);
    expect(fallSeconds(1, 3)).toBeGreaterThan(fallSeconds(0.1, 3));
  });
});

describe('knockdown sequence (rig without knockdown clips)', () => {
  const seconds = 90 / 60;
  const bare = (partial: Partial<ReactionContext> = {}) => context({ hasKnockdown: false, hasKnockdownForward: false, ...partial });

  it('a monster lies on the dazed hurt pose', () => {
    const r = pose(reaction('knockdown', 0.9), bare());
    expect(r.baseAction).toBe('monster-hurt');
    expect(r.baseTime).toBeCloseTo(0.52, 12);
  });

  it('a hero tips onto its back, bounces once, and rises back upright', () => {
    const hero = bare({ body: 'hero' }), fall = fallSeconds(0.8, seconds);
    const at = (t: number) => pose(reaction('knockdown', t / seconds), hero);
    expect(at(0).tilt).toBe(0);
    expect(at(fall).tilt).toBeCloseTo(HERO_LYING_ANGLE, 9);
    expect(at(fall + 0.03).lift).toBeGreaterThan(0.01);
    const rise = [0, 1].map(p => pose(reaction('getup', p), hero).tilt);
    expect(rise[0]).toBeCloseTo(HERO_LYING_ANGLE, 9);
    expect(rise[1]!).toBeLessThan(1e-9);
  });
});

describe('stun loop', () => {
  it('sways about a zero mean on the world clock and loops without drifting', () => {
    const sway = (clock: number) => pose(reaction('stun', 0.5, { durationTicks: 180 }), context({ clockSeconds: clock })).sway;
    const samples = Array.from({ length: 200 }, (_, i) => sway(i * 0.02));
    expect(Math.max(...samples)).toBeGreaterThan(0.08);
    expect(Math.min(...samples)).toBeLessThan(-0.08);
    expect(sway(0)).toBeCloseTo(sway(1 / 0.85), 9);
  });

  it('holds the dazed hurt pose with a small loop and eases in and out', () => {
    const mid = pose(reaction('stun', 0.5, { durationTicks: 180 }), context({ clockSeconds: 0.2 }));
    expect(mid.baseAction).toBe('monster-hurt');
    expect(Math.abs(mid.baseTime - 0.52)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(pose(reaction('stun', 0.0, { durationTicks: 180 }), context()).daze).toBe(0);
    expect(mid.daze).toBe(1);
    expect(pose(reaction('stun', 1, { durationTicks: 180 }), context()).daze).toBe(0);
  });

  it('a pack never sways in unison', () => {
    const a = pose(reaction('stun', 0.5), context({ clockSeconds: 0.3, phase: 0.1 })).sway;
    const b = pose(reaction('stun', 0.5), context({ clockSeconds: 0.3, phase: 0.6 })).sway;
    expect(a).not.toBeCloseTo(b, 3);
  });
});

describe('reduced motion', () => {
  it('shrinks the tilt and removes the sway but keeps the clip pose', () => {
    const full = pose(reaction('stun', 0.5), context({ clockSeconds: 0.3 }));
    const reduced = pose(reaction('stun', 0.5), context({ clockSeconds: 0.3, motionScale: 0.5 }));
    expect(reduced.sway).toBe(0);
    expect(reduced.tilt).toBeCloseTo(full.tilt * 0.5, 12);
    expect(reduced.baseAction).toBe(full.baseAction);
    const knock = pose(reaction('knockback', 0.3), context({ motionScale: 0.5 }));
    expect(knock.tilt).toBeCloseTo(pose(reaction('knockback', 0.3), context()).tilt * 0.5, 12);
  });
});

describe('smoothing between chained reactions', () => {
  const step = (presenter: ReactionPresenter, r: CombatReactionSnapshot | undefined, c: ReactionContext, dt = 1 / 60) => presenter.update(r, { ...c, progress: r?.progress ?? 0 }, dt);

  it('carries the clip through launch, knockdown and get-up and settles afterwards', () => {
    const presenter = new ReactionPresenter(), hero = context({ body: 'hero' });
    const run = (kind: CombatReactionKind, ticks: number, serial: number) => {
      let last: { action: string | undefined; time: number } = { action: undefined, time: 0 };
      for (let i = 0; i <= ticks; i += 1) {
        const p = step(presenter, reaction(kind, i / ticks, { durationTicks: ticks, serial }), hero);
        last = { action: p.baseAction, time: p.baseTime };
      }
      return last;
    };
    expect(run('launch', REACTION_TICKS.launch, 1)).toEqual({ action: 'aren-knockdown', time: KNOCKDOWN_CLIP_TIMING.hero.contact });
    const lying = run('knockdown', REACTION_TICKS.knockdownLie, 2);
    expect(lying.action).toBe('aren-getup');
    // The get-up reaction picks the clip up where the lie left it (no jump back to its first frame) and ends on the idle.
    const first = step(presenter, reaction('getup', 0, { durationTicks: REACTION_TICKS.getup, serial: 3 }), hero);
    expect(first.baseAction).toBe('aren-getup');
    expect(first.baseTime).toBeCloseTo(lying.time, 2);
    expect(run('getup', REACTION_TICKS.getup, 3)).toEqual({ action: 'aren-getup', time: 1 });
    for (let i = 0; i < 90; i += 1) step(presenter, undefined, hero);
    expect(presenter.pose.tilt).toBe(0);
    expect(presenter.active).toBe(false);
  });

  it('is inactive without a reaction and holds on a zero-length frame', () => {
    const presenter = new ReactionPresenter(), c = context({ body: 'hero' });
    expect(step(presenter, undefined, c).kind).toBeUndefined();
    expect(presenter.active).toBe(false);
    step(presenter, reaction('knockback', 0.3), c);
    const held = presenter.pose.tilt;
    step(presenter, reaction('knockback', 0.3), c, 0);
    expect(presenter.pose.tilt).toBe(held);
  });

  it('passes clip requests through unsmoothed and resets on demand', () => {
    const presenter = new ReactionPresenter();
    const p = step(presenter, reaction('stagger', 0.5), context({ body: 'hero' }));
    expect(p.baseAction).toBe('aren-hit');
    presenter.reset();
    expect(presenter.pose.tilt).toBe(0);
    expect(presenter.pose.baseAction).toBeUndefined();
  });
});

describe('impulse envelope', () => {
  it('rises within the attack, holds, and eases to zero', () => {
    expect(impulseEnvelope(0, 0.1, 0.3)).toBe(0);
    expect(impulseEnvelope(0.1, 0.1, 0.3)).toBeCloseTo(1, 12);
    expect(impulseEnvelope(0.3, 0.1, 0.3)).toBeCloseTo(1, 12);
    expect(impulseEnvelope(1, 0.1, 0.3)).toBeCloseTo(0, 12);
  });
});

describe('poise bar model', () => {
  it('has no bar for actors without poise', () => {
    expect(poiseBarModel({}).poise).toBeUndefined();
  });

  it('drains the stun timer from 1 to 0 over the stun', () => {
    expect(poiseBarModel({ poise: 0.4 })).toEqual({ poise: 0.4, stunned: false, stunRemaining: 0 });
    expect(poiseBarModel({ poise: 1, reaction: reaction('stun', 0.25) }).stunRemaining).toBeCloseTo(0.75, 12);
    expect(poiseBarModel({ poise: 1, reaction: reaction('stun', 1) }).stunRemaining).toBe(0);
    expect(poiseBarModel({ poise: 0.2, reaction: reaction('knockback', 0.5) }).stunned).toBe(false);
  });
});
