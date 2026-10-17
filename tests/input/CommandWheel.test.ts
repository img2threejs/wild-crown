import { describe, expect, it } from 'bun:test';
import { CommandWheel, sectorFromVector } from '../../src/input/CommandWheel.js';

const always = () => true;
const never = () => false;

describe('sectorFromVector', () => {
  it('maps the eight compass directions clockwise from straight up (x right, y down)', () => {
    const directions: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    expect(directions.map(([x, y]) => sectorFromVector(x, y))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('selects nothing in the dead centre or for non-finite input', () => {
    expect(sectorFromVector(0, 0)).toBeNull();
    expect(sectorFromVector(0.1, -0.1)).toBeNull();
    expect(sectorFromVector(Number.NaN, 1)).toBeNull();
  });

  it('keeps a sector across its 45-degree arc and switches at the boundary', () => {
    expect(sectorFromVector(Math.sin(0.3), -Math.cos(0.3))).toBe(0);
    expect(sectorFromVector(Math.sin(Math.PI / 8 - 0.05), -Math.cos(Math.PI / 8 - 0.05))).toBe(0);
    expect(sectorFromVector(Math.sin(Math.PI / 8 + 0.05), -Math.cos(Math.PI / 8 + 0.05))).toBe(1);
  });
});

describe('CommandWheel', () => {

  it('opens with nothing selected, and a quick tap cancels instead of choosing Follow', () => {
    const wheel = new CommandWheel();
    wheel.openFor('asha');
    expect(wheel).toMatchObject({ open: true, companionId: 'asha', selectedSector: null });
    expect(wheel.release(always)).toEqual({ kind: 'cancel' });
    expect(wheel.open).toBe(false);
  });

  it('commits a deliberate selection exactly once for its equipped companion', () => {
    const wheel = new CommandWheel();
    wheel.openFor('koro');
    wheel.aim(1, 0);
    expect(wheel.selectedSector).toBe(2);
    const outcome = wheel.release(always);
    expect(outcome).toEqual({ kind: 'commit', companionId: 'koro', sector: 2, command: 'focus' });
    expect(wheel.release(always)).toEqual({ kind: 'cancel' });
  });

  it('selects by digit, steps with arrows in both directions and wraps', () => {
    const wheel = new CommandWheel();
    wheel.openFor('vara');
    wheel.selectSector(7);
    expect(wheel.selectedSector).toBe(7);
    wheel.step(1);
    expect(wheel.selectedSector).toBe(0);
    wheel.step(-1);
    expect(wheel.selectedSector).toBe(7);
    wheel.selectSector(null);
    wheel.step(-1);
    expect(wheel.selectedSector).toBe(7);
    wheel.selectSector(99);
    expect(wheel.selectedSector).toBeNull();
  });


  it('reports a refused selection with the command so the reason can be shown, and closes', () => {
    const wheel = new CommandWheel();
    wheel.openFor('asha');
    wheel.selectSector(6);
    expect(wheel.release(never)).toEqual({ kind: 'rejected', companionId: 'asha', sector: 6, command: 'special' });
    expect(wheel.open).toBe(false);
  });

  it('cancels without commanding and ignores gestures while closed', () => {
    const wheel = new CommandWheel();
    wheel.aim(1, 0);
    wheel.selectSector(1);
    expect(wheel).toMatchObject({ open: false, selectedSector: null });
    wheel.openFor('vara');
    wheel.selectSector(4);
    expect(wheel.cancel()).toEqual({ kind: 'cancel' });
    expect(wheel).toMatchObject({ open: false, selectedSector: null });
  });

});
