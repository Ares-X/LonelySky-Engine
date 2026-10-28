import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollisionWorld, safeRadius} from '../src/collision.js';

test('recovery preserves shallow overlaps on every face of the sphere envelope', () => {
  const radius = 100, clearance = safeRadius('planet', radius);
  const collision = createCollisionWorld({sector: index => index === 0
    ? [{id: 'sphere', radius, position: [0, 0, 0]}] : []});
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    for (const offset of [-1e-7, 0, 1e-7]) {
      const position = [0, 0, 0]; position[axis] = sign * (clearance + offset);
      const result = collision.ensureSafe(0, position, [0, 0, 0]);
      assert.equal(result.corrected, offset < 0);
      assert.equal(result.contact?.id ?? null, offset < 0 ? 'sphere' : null);
      if (offset < 0) assert.ok(Math.hypot(...result.position) >= clearance);
      else assert.deepEqual(result.position, position);
      assert.deepEqual(position[axis], sign * (clearance + offset));
    }
  }
});

test('sphere box corners are clear while diagonal shallow overlaps still recover', () => {
  const radius = 100, clearance = safeRadius('planet', radius);
  const collision = createCollisionWorld({sector: index => index === 0
    ? [{id: 'sphere', radius, position: [0, 0, 0]}] : []});
  const corner = [clearance - 1e-7, clearance - 1e-7, clearance - 1e-7];
  assert.deepEqual(collision.ensureSafe(0, corner, [0, 0, 0]).position, corner);
  assert.equal(collision.ensureSafe(0, corner, [0, 0, 0]).contact, null);
  for (const sign of [-1, 1]) {
    const component = sign * (clearance - 1e-7) / Math.sqrt(3);
    const result = collision.ensureSafe(0, [component, component, component], [0, 0, 0]);
    assert.equal(result.corrected, true);
    assert.equal(result.contact.id, 'sphere');
    assert.ok(Math.hypot(...result.position) >= clearance);
  }
});
