import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollisionWorld} from '../src/collision.js';

const sphere = (id, position) => ({id, position, boundsRadius: 10, shape: {type: 'sphere', radius: 10}});
const worldFor = solids => createCollisionWorld({sector: () => [], solidProvider: () => solids, shipRadius: 7});
function assertClear(solids, position) {
  for (const solid of solids) {
    assert.ok(Math.hypot(...position.map((x, axis) => x - solid.position[axis])) >= 17,
      `recovered ship overlaps ${solid.id}`);
  }
}

test('recovery exits a second solid nearly tangent to its initial escape direction', () => {
  // The first sphere establishes +X recovery. Its exit overlaps a second
  // sphere whose expanded surface is almost tangent to that fixed ray.
  const solids = [sphere('first', [-10, 0, 0]), sphere('grazing', [7, 16.99, 0])];
  const start = [0, 0, 0], velocity = [0, 0, 0];
  const inputs = structuredClone({solids, start, velocity}), collision = worldFor(solids);
  const result = collision.ensureSafe(0, start, velocity), snapshot = structuredClone(result);
  assert.equal(result.corrected, true);
  assertClear(solids, result.position);
  const move = collision.move(0, start, start, velocity);
  assert.equal(move.failure, undefined);
  assertClear(solids, move.position);
  assert.deepEqual(result, snapshot);
  result.position.fill(1000); result.contact.normal.fill(1000); result.contact.position.fill(1000);
  assert.deepEqual(collision.ensureSafe(0, start, velocity), snapshot);
  assert.deepEqual({solids, start, velocity}, inputs);
});

test('opposing solid contacts retain an escape instead of alternating corrections', () => {
  const solids = [sphere('left', [-10, 0, 0]), sphere('right', [10, 0, 0])];
  const collision = worldFor(solids), result = collision.ensureSafe(0, [0, 0, 0], [0, 0, 0]);
  assert.equal(result.corrected, true);
  assertClear(solids, result.position);
});
