import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionWorld } from '../src/collision.js';
import { encodeCell } from '../src/coordinates.js';

const orbiting = () => ({ id: 'moving', type: 'planet', radius: 10, position: [0, 0, 0],
  orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 1e13 } });

test('returned bodies and contacts remain isolated through repeated timed sweeps', () => {
  const body = orbiting(), sector = index => index === 0 ? [body] : [];
  const collision = createCollisionWorld({ sector }), position = [1000, 100, 0];
  const sweep = world => world.move(0, position, position, [0, 0, 0], { timeSeconds: 0, deltaTime: 1 / 120 });
  const expected = sweep(createCollisionWorld({ sector }));
  assert.ok(expected.contact);
  const snapshots = collision.bodies(0, 0);
  snapshots[0].position.fill(9999); snapshots[0].velocity.fill(9999); snapshots[0].orbit.mu = 1;
  snapshots[0].clearance = 0;
  assert.deepEqual(sweep(collision), expected);
  const result = sweep(collision);
  result.contact.position.fill(9999); result.contact.velocity.fill(9999);
  result.contact.normal.fill(9999); result.contact.orbit.mu = 1;
  assert.deepEqual(sweep(collision), expected);
  assert.deepEqual(collision.bodies(0, 0), createCollisionWorld({ sector }).bodies(0, 0));
});

test('timed collision sampling follows time reversal and changing curvature intervals', () => {
  const body = orbiting(), sector = index => index === 0 ? [body] : [];
  const collision = createCollisionWorld({ sector }), position = [1000, 100, 0];
  for (const timeSeconds of [0, .1, -.1, .1, 0, -0]) {
    for (const deltaTime of [1 / 120, 1 / 240, 1 / 120, 1 / 60, 0]) {
      const args = [0, position, position, [0, 0, 0], { timeSeconds, deltaTime }];
      assert.deepEqual(collision.move(...args), createCollisionWorld({ sector }).move(...args));
      assert.deepEqual(collision.bodies(0, timeSeconds), createCollisionWorld({ sector }).bodies(0, timeSeconds));
    }
  }
});

test('same-time collision queries follow toroidal rebases in both directions', () => {
  const west = encodeCell({ x: 16383, y: 0, z: 0 }), east = encodeCell({ x: -16384, y: 0, z: 0 });
  const body = { ...orbiting(), position: [-10000, 0, 0],
    orbit: { semiMajorAxis: 200, eccentricity: 0, mu: 4e10 } };
  const sector = index => index === east ? [body] : [], collision = createCollisionWorld({ sector });
  for (const [index, position] of [[west, [10200, 60, 0]], [east, [-9800, 60, 0]], [west, [10200, 60, 0]]]) {
    const args = [index, position, position, [0, 0, 0], { timeSeconds: .01, deltaTime: 1 / 120 }];
    assert.deepEqual(collision.move(...args), createCollisionWorld({ sector }).move(...args));
    assert.deepEqual(collision.bodies(index, .01), createCollisionWorld({ sector }).bodies(index, .01));
  }
});

test('home revisions replace same-cell collision samples at the same time', () => {
  let homes = [{ id: 'home', homeId: 'home', type: 'planet', radius: 100, position: [0, 0, 0] }];
  const world = { revision: 0, sector: index => index === 0 ? homes : [] };
  const collision = createCollisionWorld({ world });
  for (const position of [[0, 0, 0], [400, 0, 0], null]) {
    homes = position ? [{ ...homes[0], position }] : [];
    world.revision++;
    assert.deepEqual(collision.bodies(0, 12), createCollisionWorld({ world }).bodies(0, 12));
    assert.deepEqual(collision.ensureSafe(0, [0, 0, 0], [0, 0, 0], 12),
      createCollisionWorld({ world }).ensureSafe(0, [0, 0, 0], [0, 0, 0], 12));
  }
});
