import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionWorld } from '../src/collision.js';
import { encodeCell } from '../src/coordinates.js';

const h = 1 / 120;
const orbiting = (extra = {}) => ({ id: 'moon', type: 'planet', radius: 10, position: [0, 0, 0],
  orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 1e13 }, ...extra });
const provider = bodies => index => index === 0 ? bodies : [];

// Public snapshots and separate caller outputs may remain live while this
// instance services other moves and body queries.
test('reusable sweeps preserve prior snapshots and independent caller outputs', () => {
  const collision = createCollisionWorld({ sector: provider([orbiting()]) });
  const a = collision.createMoveResult(), b = collision.createMoveResult();
  const position = a.position, velocity = a.velocity;
  const start = Object.freeze([1000, 100, 0]), zero = Object.freeze([0, 0, 0]);
  const options = { deltaTime: h };
  const published = collision.move(0, start, start, zero, options);
  const safe = collision.ensureSafe(0, [1000, 0, 0], zero);
  const bodies = collision.bodies(0);
  const retained = structuredClone({ published, safe, bodies });
  assert.equal(collision.moveInto(0, start, start, zero, options, a), a);
  assert.deepEqual(a, published);
  const contact = a.contact, retainedContact = structuredClone(contact);
  const first = structuredClone(a);
  collision.moveInto(0, [-5000, 4000, 0], [-4999, 4000, 0], zero, { deltaTime: h, timeSeconds: .2 }, b);
  assert.deepEqual(a, first);
  for (const timeScale of [0, .4, 1]) {
    collision.bodies(0, .3, timeScale);
    collision.moveInto(0, [-5000, 4000, 0], [-4999, 4000, 0], zero, { deltaTime: h, timeScale }, a);
    assert.equal(a.position, position); assert.equal(a.velocity, velocity);
    assert.equal(a.contact, null); assert.equal(a.failure, undefined);
    assert.deepEqual(contact, retainedContact);
    assert.deepEqual({ published, safe, bodies }, retained);
  }
});

test('a reused output accepts its previous vectors as the next move inputs', () => {
  for (const moving of [false, true]) {
    const collision = createCollisionWorld({ sector: provider(moving ? [orbiting()] : []) });
    const out = collision.createMoveResult(), options = { deltaTime: h };
    out.position.splice(0, 3, -5000, 4000, 0); out.velocity.splice(0, 3, 120, 0, 0);
    const velocity = out.velocity;
    for (let i = 0; i < 20; i++) {
      const end = Object.freeze([out.position[0] + 1, 4000, 0]);
      collision.moveInto(0, out.position, end, out.velocity, options, out);
      assert.deepEqual(out.position, [-4999 + i, 4000, 0]);
      assert.equal(out.velocity, velocity); assert.deepEqual(out.velocity, [120, 0, 0]);
    }
  }
});

test('clock changes, recovery and crossed cells preserve reusable result behavior', () => {
  const target = encodeCell({ x: 3, y: 0, z: 0 });
  const scenarios = [
    { sector: provider([orbiting()]), start: [1000, 100, 0], end: [1000, 100, 0] },
    { sector: provider([orbiting()]), start: [1000, 0, 0], end: [1010, 10, 0] },
    { sector: provider([orbiting({ orbit: undefined })]), start: [-200, 0, 0], end: [200, 0, 0] },
    { sector: index => index === target ? [orbiting({ position: [-1000, 0, 0] })] : [], start: [0, 0, 0], end: [80000, 0, 0] },
  ];
  for (const { sector, start, end } of scenarios) {
    const collision = createCollisionWorld({ sector }), out = collision.createMoveResult();
    Object.freeze(start); Object.freeze(end);
    const velocity = Object.freeze([12, 0, 0]);
    for (const timeScale of [1, 0, .4, 1]) for (const timeSeconds of [0, .017, -.04]) {
      const options = { deltaTime: h, timeScale, timeSeconds };
      assert.deepEqual(collision.moveInto(0, start, end, velocity, options, out),
        createCollisionWorld({ sector }).move(0, start, end, velocity, options));
    }
  }
});

test('independent collision instances retain their own active sweep state', () => {
  const a = createCollisionWorld({ sector: provider([orbiting()]) });
  const b = createCollisionWorld({ sector: provider([orbiting({ position: [0, -5000, 0] })]) });
  const outA = a.createMoveResult(), outB = b.createMoveResult();
  const start = [1000, 100, 0], zero = [0, 0, 0], options = { deltaTime: h };
  for (let i = 0; i < 10; i++) {
    a.moveInto(0, start, start, zero, options, outA);
    const snapshot = structuredClone(outA);
    b.moveInto(0, start, start, zero, options, outB);
    assert.deepEqual(outA, snapshot);
    assert.ok(outA.contact); assert.equal(outB.contact, null);
  }
});

test('a bounded moving-contact failure returns the safe start and does not leak to the next move', () => {
  const bodies = [-1, 1].map(sign => orbiting({ id: `closing-${sign}`, position: [sign * 60, -sign * 1000, 0],
    orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 4e9, meanAnomalyAtEpoch: sign * Math.PI / 2 } }));
  const collision = createCollisionWorld({ sector: provider(bodies) }), out = collision.createMoveResult();
  const options = { deltaTime: h }, zero = Object.freeze([0, 0, 0]);
  const published = collision.move(0, zero, [0, 0, .1], [0, 0, 12], options);
  const publishedPosition = [...published.position], publishedVelocity = [...published.velocity];
  const aliased = collision.createMoveResult(); aliased.velocity[2] = 12;
  collision.moveInto(0, aliased.position, [0, 0, .1], aliased.velocity, options, aliased);
  assert.deepEqual(aliased, published);
  collision.moveInto(0, zero, [0, 0, .1], [0, 0, 12], options, out);
  assert.equal(out.failure.code, 'infeasible-moving-contact');
  assert.deepEqual(out.position, zero); assert.deepEqual(out.velocity, [0, 0, 12]);
  assert.equal(out.failure.safeAtStart, true); assert.equal(out.distance, 0);
  const failure = out.failure, retained = structuredClone(failure.contacts);
  collision.moveInto(0, [-5000, 4000, 0], [-4999, 4000, 0], zero, options, out);
  assert.equal(out.failure, undefined); assert.equal(out.corrected, false); assert.equal(out.contact, null);
  assert.deepEqual(failure.contacts, retained);
  assert.deepEqual(published.position, publishedPosition); assert.deepEqual(published.velocity, publishedVelocity);
});

test('reusable output retains real ring holes, solid contacts and root-budget failure endpoints', () => {
  const solid = { id: 'ring', position: [0, 0, 0], boundsRadius: 203,
    shape: { type: 'compound', parts: [{ type: 'annular-sector-slab', innerRadius: 100, outerRadius: 200,
      minY: -10, maxY: 10, gapCenter: 0, gapHalfAngle: 0 }] } };
  const sector = provider([orbiting({ position: [0, 5000, 0] })]);
  for (const solidSweepBudget of [1, 32768]) {
    const config = { sector, solidProvider: () => [solid], solidSweepBudget };
    const collision = createCollisionWorld(config), out = collision.createMoveResult();
    for (const [start, end] of [[[0, -4000, 0], [0, 4000, 0]], [[-1000, 15, 0], [1000, 15, 0]], [[150, 0, 0], [150, 0, 20]]]) {
      const options = { deltaTime: h }, velocity = [240000, 0, 0];
      assert.deepEqual(collision.moveInto(0, start, end, velocity, options, out),
        createCollisionWorld(config).move(0, start, end, velocity, options));
    }
  }
});


test('unrecoverable initial overlap preserves inputs and marks the endpoint unsafe', () => {
  const giant = orbiting({ orbit: undefined, radius: 1e8 });
  const collision = createCollisionWorld({ sector: provider([giant]) }), out = collision.createMoveResult();
  const start = Object.freeze([0, 0, 0]), velocity = Object.freeze([12, 0, 0]);
  collision.moveInto(0, start, [1, 0, 0], velocity, { deltaTime: h }, out);
  assert.equal(out.failure.code, 'recovery-scan-limit'); assert.equal(out.failure.safeAtStart, false);
  assert.deepEqual(out.position, start); assert.deepEqual(out.velocity, velocity);
  assert.equal(out.corrected, false); assert.equal(out.distance, 0);
  const expectedPosition = [...out.position], expectedVelocity = [...out.velocity];
  collision.moveInto(0, out.position, [1, 0, 0], out.velocity, { deltaTime: h }, out);
  assert.equal(out.failure.safeAtStart, false);
  assert.deepEqual(out.position, expectedPosition); assert.deepEqual(out.velocity, expectedVelocity);
});
