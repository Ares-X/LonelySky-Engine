import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollisionWorld} from '../src/collision.js';
import {describeCosmicSystem} from '../src/cosmic-systems.js';
import {rotationFrame3} from '../src/frame.js';

function withoutArrayAt(run) {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'at');
  try {
    Object.defineProperty(Array.prototype, 'at', {...descriptor, value: undefined});
    return run();
  } finally {Object.defineProperty(Array.prototype, 'at', descriptor);}
}

test('satellite systems preserve seeded outputs when Array.at is unavailable', () => {
  const frame = rotationFrame3([.4, .7, -.3]);
  const generate = () => Array.from({length: 120}, (_, index) => describeCosmicSystem({
    id: `compatibility-primary-${index}`, kind: index % 2 ? 'dark-world' : 'gas-giant',
    radius: 1000000, boundsRadius: 1000000, frame,
  }, 'array-compatibility-fixture'));
  const expected = generate();
  assert.ok(expected.some(system => system.satellites.length === 0));
  assert.ok(expected.some(system => system.satellites.length >= 4));
  assert.deepEqual(withoutArrayAt(generate), expected);
});

test('head-on and glancing collision sweeps preserve contact and velocity without Array.at', () => {
  const sweep = () => {
    const world = createCollisionWorld({sector: index => index === 0
      ? [{id: 'sphere', type: 'planet', radius: 100, position: [0, 0, 0]}] : []});
    return [world.move(0, [-500, 0, 0], [500, 0, 0], [1000, 0, 0]),
      world.move(0, [-500, 100, 0], [500, 100, 0], [1000, 0, 0])];
  };
  const expected = sweep();
  assert.ok(expected.every(result => result.corrected && result.contact?.id === 'sphere'));
  assert.deepEqual(withoutArrayAt(sweep), expected);
});
