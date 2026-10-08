import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POWERUPS, randomPowerup } from '../public/js/kart.js';

test('Kat Kart power-ups: how often each comes up', () => {
  assert.equal(POWERUPS.triple.weight * 2, POWERUPS.double.weight, 'Triple Speed is 50% rarer than Double Speed');
  assert.ok(POWERUPS.food.weight < POWERUPS.mouse.weight && POWERUPS.food.weight > POWERUPS.thunder.weight);
  assert.ok(POWERUPS.thunder.weight < POWERUPS.mouse.weight);
  assert.deepEqual([POWERUPS.double.mul, POWERUPS.triple.mul, POWERUPS.mouse.mul, POWERUPS.food.mul, POWERUPS.thunder.mul], [1.5, 2, 0.5, 0.25, 0]);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tally = {};
  for (let i = 0; i < 20000; i++) {
    const k = randomPowerup(rand);
    tally[k] = (tally[k] ?? 0) + 1;
  }
  assert.ok(tally.double > tally.triple * 1.6 && tally.double < tally.triple * 2.4);
  assert.ok(tally.mouse > tally.food && tally.food > tally.thunder);
});
