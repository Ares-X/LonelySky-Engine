import test from 'node:test';
import assert from 'node:assert/strict';
import { createGravityField } from '../src/gravity.js';
import { evaluateBodyState } from '../src/orbits.js';
import { CELL_SIZE, encodeCell } from '../src/coordinates.js';

const close = (a, b) => a.forEach((n, i) => assert.ok(Math.abs(n - b[i]) < 1e-8));

for (const x of [0, 16383]) test(`gravity source motion stays local and detached across cell ${x}`, () => {
  const from = encodeCell({ x, y: 0, z: 0 });
  const to = encodeCell({ x: x === 16383 ? -16384 : x + 1, y: 0, z: 0 });
  const body = { id: 'moving', name: 'moving sphere', type: 'planet', radius: 10, position: [-9900, 0, 0],
    mu: 1e6, orbit: { semiMajorAxis: 60, eccentricity: .3, mu: 1e6 } };
  const field = createGravityField({ sector: index => index === to ? [body] : [] });
  const time = .13, state = evaluateBodyState(body, time);
  const before = field.sample(from, [9900, 0, 0], time);
  const after = field.sample(to, [9900 - CELL_SIZE, 0, 0], time);
  close(before.source.position, state.position.map((n, i) => n + (i === 0 ? CELL_SIZE : 0)));
  close(after.source.position, state.position);
  close(before.source.velocity, state.velocity); close(after.source.velocity, state.velocity);
  close(before.acceleration, after.acceleration);
  before.source.position.fill(0); before.source.velocity.fill(0);
  const again = field.sample(from, [9900, 0, 0], time);
  close(again.source.position, state.position.map((n, i) => n + (i === 0 ? CELL_SIZE : 0)));
  close(again.source.velocity, state.velocity);
  assert.deepEqual(body.position, [-9900, 0, 0]);
});

test('static source exposes a detached zero velocity and current position', () => {
  const body = { id: 'fixed', type: 'star', radius: 100, position: [1200, 20, 30] };
  const field = createGravityField({ sector: index => index === 0 ? [body] : [] });
  const sample = field.sample(0, [0, 0, 0], 123);
  assert.deepEqual(sample.source.position, body.position);
  assert.deepEqual(sample.source.velocity, [0, 0, 0]);
  sample.source.position[0] = 42;
  assert.deepEqual(field.sample(0, [0, 0, 0], 123).source.position, body.position);
});
