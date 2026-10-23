import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderResolutionBudget } from '../../src/rendering/RenderResolutionBudget.js';

function run(budget: RenderResolutionBudget, interval: number, seconds: number): number {
  let scale = 1;
  for (let time = 0; time < seconds; time += interval) scale = budget.observe(interval);
  return scale;
}

test('normal 60 Hz and high-refresh frames retain full resolution', () => {
  const budget = new RenderResolutionBudget();
  assert.equal(run(budget, 1 / 60, 10), 1);
  assert.equal(run(budget, 1 / 144, 10), 1);
});

test('sustained missed frames reduce resolution without crossing the quality floor', () => {
  const budget = new RenderResolutionBudget();
  const reduced = run(budget, 1 / 40, 8);
  assert.equal(reduced, 0.75);
  assert.equal(run(budget, 1 / 20, 30), 0.75);
});

test('a single long task does not downgrade an otherwise smooth scene', () => {
  const budget = new RenderResolutionBudget();
  run(budget, 1 / 60, 1);
  budget.observe(0.2);
  assert.equal(run(budget, 1 / 60, 5), 1);
});

test('reaching smooth 60 Hz does not cause repeated down/up resolution oscillation', () => {
  const budget = new RenderResolutionBudget();
  const reduced = run(budget, 1 / 40, 8);
  assert.equal(run(budget, 1 / 60, 60), reduced);
});

test('sustained substantial headroom gradually restores detail without exceeding native resolution', () => {
  const budget = new RenderResolutionBudget();
  const reduced = run(budget, 1 / 40, 8);
  const recovered = run(budget, 1 / 144, 24);
  assert.ok(recovered > reduced && recovered < 1);
  assert.equal(run(budget, 1 / 144, 120), 1);
});

test('invalid/background intervals do not affect resolution and a new region starts at native resolution', () => {
  const budget = new RenderResolutionBudget();
  run(budget, 1 / 40, 8);
  for (const invalid of [NaN, Infinity, -1, 0, 1]) assert.equal(budget.observe(invalid), 0.75);
  budget.reset();
  assert.equal(run(budget, 1 / 60, 3), 1);
});

test('loading calibration remains stable at 60 Hz and cannot seed an out-of-range render scale', () => {
  const budget = new RenderResolutionBudget();
  budget.reset(0.8);
  assert.equal(run(budget, 1 / 60, 10), 0.8);
  budget.reset(0.1);
  assert.equal(budget.observe(0), 0.75);
  budget.reset(2);
  assert.equal(budget.observe(0), 1);
  budget.reset(NaN);
  assert.equal(budget.observe(0), 1);
});
