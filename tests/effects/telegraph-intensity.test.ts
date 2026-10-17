import { afterEach, describe, expect, it } from 'bun:test';
import { GroundFx } from '../../src/effects/vfx/GroundFx.js';
import { Footprint } from '../../src/effects/vfx/footprint.js';

const layers: GroundFx[] = [];
afterEach(() => { for (const layer of layers.splice(0)) layer.dispose(); });
function ground() { const layer = new GroundFx(); layers.push(layer); return layer; }
const footprint = () => new Footprint().set('rect', 2, 0, 3, 0.5, 1, 2);

describe('telegraph contrast invariants', () => {
  it('boosts fill contrast without expanding the authored footprint or saturating the tell', () => {
    const layer = ground();
    const fill = layer.spawn('fill', footprint(), 'earth', 1, 0, 0)!;
    const bounds = fill.uniforms.uBounds.value.clone();
    const position = fill.mesh.position.clone();
    layer.setTelegraphIntensity('high');
    for (const tell of [0, 0.8]) {
      layer.drive(fill, 0.25, 1, 0.5, tell);
      expect(fill.uniforms.uTell.value).toBeGreaterThan(tell);
      expect(fill.uniforms.uTell.value).toBeLessThan(1);
      expect(fill.uniforms.uBounds.value.equals(bounds)).toBe(true);
      expect(fill.mesh.position.equals(position)).toBe(true);
    }
  });

  it('restores authored contrast on an already live fill', () => {
    const layer = ground();
    const fill = layer.spawn('fill', footprint(), 'earth', 1, 0, 0)!;
    layer.setTelegraphIntensity('high');
    layer.drive(fill, 0.25, 1, 0.5, 0.8);
    expect(fill.uniforms.uTell.value).toBeGreaterThan(0.8);
    layer.setTelegraphIntensity('standard');
    layer.drive(fill, 0.25, 1, 0.5, 0.8);
    expect(fill.uniforms.uTell.value).toBe(0.8);
  });

  it.each(['shock', 'decal', 'burn'] as const)('does not alter an unrelated %s effect', kind => {
    const layer = ground();
    const slot = layer.spawn(kind, footprint(), 'earth', 1, 0, 0)!;
    layer.drive(slot, 0.25, 1, 0.5, 0.6);
    const authored = slot.uniforms.uTell.value;
    layer.setTelegraphIntensity('high');
    layer.drive(slot, 0.25, 1, 0.5, 0.6);
    expect(slot.uniforms.uTell.value).toBe(authored);
  });
});
