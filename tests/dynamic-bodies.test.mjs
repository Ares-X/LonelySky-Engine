import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyGravity, createGravityField } from '../src/gravity.js';
import { createCollisionWorld, safeRadius } from '../src/collision.js';
import { evaluateBodyState, orbitalPeriod } from '../src/orbits.js';
import { CELL_SIZE, encodeCell } from '../src/coordinates.js';

const sphere = (changes = {}) => ({ id: 'comet', type: 'planet', radius: 10, position: [0, 0, 0],
  orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 1e9 }, ...changes });
const provider = body => index => index === 0 ? [body] : [];
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const close = (actual, expected, tolerance = 1e-7) => assert.ok(distance(actual, expected) < tolerance, `${actual} != ${expected}`);

test('explicit mu is inverse square outside the surface and bounded inside; legacy profile remains softened', () => {
  const body = { ...sphere({ orbit: undefined, radius: 100 }), mu: 1e6, influence: 10000 };
  close(bodyGravity(body, [200, 0, 0]), [-25, 0, 0]);
  close(bodyGravity(body, [400, 0, 0]), [-6.25, 0, 0]);
  close(bodyGravity(body, [1, 0, 0]), [-100, 0, 0]);
  assert.deepEqual(bodyGravity(body, [0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(bodyGravity(body, [10000, 0, 0]), [0, 0, 0]);
  assert.ok(Math.hypot(...bodyGravity(body, [9999.999, 0, 0])) < 1e-12);
  const legacy = { ...body, mu: undefined };
  const ratio = Math.hypot(...bodyGravity(legacy, [200, 0, 0])) / Math.hypot(...bodyGravity(legacy, [400, 0, 0]));
  assert.ok(ratio > 3 && ratio < 4);
  for (const mu of [0, -1, Infinity, NaN, '100']) assert.deepEqual(bodyGravity({ ...body, mu }, [200, 0, 0]), bodyGravity(legacy, [200, 0, 0]));
});

test('gravity and collision snapshots evaluate moving bodies at every requested time without regeneration', () => {
  const body = sphere(), period = orbitalPeriod(body.orbit);
  let calls = 0;
  const sector = index => { calls++; return provider(body)(index); };
  const field = createGravityField({ sector }), collision = createCollisionWorld({ sector });
  const before = field.sample(0, [0, 0, 0], 0), after = field.sample(0, [0, 0, 0], period / 4);
  assert.ok(before.acceleration[0] > 0 && Math.abs(before.acceleration[1]) < 1e-10);
  assert.ok(after.acceleration[1] > 0 && Math.abs(after.acceleration[0]) < 1e-10);
  close(collision.bodies(0, 0)[0].position, [1000, 0, 0]);
  close(collision.bodies(0, period / 4)[0].position, [0, 1000, 0]);
  assert.equal(calls, 54);
  const snapshot = collision.bodies(0, 0)[0]; snapshot.position[0] = 3; snapshot.orbit.mu = 3;
  close(collision.bodies(0, 0)[0].position, [1000, 0, 0]);
  assert.equal(body.orbit.mu, 1e9);
});

test('moving body hits a stationary ship and transfers its inward surface velocity', () => {
  const body = sphere({ orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 1e13 } });
  const collision = createCollisionWorld({ sector: provider(body) });
  const position = [1000, 100, 0], h = 1 / 120;
  const result = collision.move(0, position, position, [0, 0, 0], { timeSeconds: 0, deltaTime: h });
  assert.equal(result.contact.id, body.id); assert.equal(result.corrected, true);
  assert.ok(result.position[1] > position[1]); assert.ok(result.velocity[1] > 0);
  const relativeVelocity = result.velocity.map((n, i) => n - result.contact.velocity[i]);
  assert.ok(dot(relativeVelocity, result.contact.normal) >= -1e-6);
  assert.ok(distance(result.position, evaluateBodyState(body, h).position) >= safeRadius(body.type, body.radius) - 1e-7);
});

test('fast orbit crossing is detected even when neither endpoint overlaps the ship', () => {
  const body = sphere({ orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 1e13,
    meanAnomalyAtEpoch: -.15 } });
  const collision = createCollisionWorld({ sector: provider(body) });
  const position = [1000, 0, 0], h = .03;
  assert.ok(distance(position, evaluateBodyState(body, 0).position) > 100);
  assert.ok(distance(position, evaluateBodyState(body, h).position) > 100);
  const result = collision.move(0, position, position, [0, 0, 0], { deltaTime: h });
  assert.equal(result.contact.id, body.id); assert.ok(result.position[1] > 100);
  assert.ok(distance(result.position, evaluateBodyState(body, h).position) >= safeRadius(body.type, body.radius) - 1e-7);
});

test('curvature envelope catches a full fast orbit whose endpoint chord misses', () => {
  const h = 1 / 120, angularSpeed = 2 * Math.PI / h;
  const body = sphere({ orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: angularSpeed ** 2 * 1e9 } });
  const collision = createCollisionWorld({ sector: provider(body) });
  const position = [-1000, 0, 0];
  const result = collision.move(0, position, position, [0, 0, 0], { deltaTime: h });
  assert.equal(result.contact.id, body.id); assert.equal(result.corrected, true);
  assert.ok(distance(result.position, evaluateBodyState(body, h).position) >= safeRadius(body.type, body.radius));
});

test('time-dependent recovery uses relative surface velocity and static defaults remain identical', () => {
  const body = sphere(), collision = createCollisionWorld({ sector: provider(body) });
  const timeSeconds = orbitalPeriod(body.orbit) / 4;
  const state = evaluateBodyState(body, timeSeconds);
  const result = collision.ensureSafe(0, state.position, [0, 0, 0], timeSeconds);
  assert.equal(result.distance, 0); assert.equal(result.corrected, true);
  assert.ok(distance(result.position, state.position) >= safeRadius(body.type, body.radius));
  assert.ok(dot(result.velocity.map((n, i) => n - state.velocity[i]), result.contact.normal) >= -1e-7);
  const fixed = createCollisionWorld({ sector: provider(sphere({ orbit: undefined })) });
  const args = [0, [-1000, 0, 0], [1000, 0, 0], [10000, 0, 0]];
  assert.deepEqual(fixed.move(...args), fixed.move(...args, { timeSeconds: 9, deltaTime: 0 }));
});

test('moving source offsets agree after ordinary and toroidal neighbor-cell rebases', () => {
  for (const x of [0, 16383]) {
    const index = encodeCell({ x, y: 0, z: 0 });
    const neighbor = encodeCell({ x: x === 16383 ? -16384 : x + 1, y: 0, z: 0 });
    const body = sphere({ position: [-10000, 0, 0], orbit: { semiMajorAxis: 200, eccentricity: 0, mu: 4e10 } });
    const sector = cell => cell === neighbor ? [body] : [];
    const field = createGravityField({ sector }), collision = createCollisionWorld({ sector });
    const timeSeconds = .01, h = 1 / 120, start = [10200, 60, 0], rebased = [-9800, 60, 0];
    close(field.sample(index, start, timeSeconds).acceleration, field.sample(neighbor, rebased, timeSeconds).acceleration);
    const a = collision.move(index, start, start, [0, 0, 0], { timeSeconds, deltaTime: h });
    const b = collision.move(neighbor, rebased, rebased, [0, 0, 0], { timeSeconds, deltaTime: h });
    close(a.position, b.position.map((n, i) => n + (i === 0 ? CELL_SIZE : 0)));
    close(a.velocity, b.velocity); assert.equal(a.contact?.id, b.contact?.id);
  }
});

test('dynamic intervals have explicit bounded failure and reject invalid times without mutating inputs', () => {
  const collision = createCollisionWorld({ sector: provider(sphere()) });
  const start = [0, 0, 0], end = [1, 0, 0], velocity = [1, 0, 0];
  assert.throws(() => collision.move(0, start, end, velocity, { deltaTime: 1 }), /subdivide/);
  assert.throws(() => collision.move(0, start, end, velocity, { deltaTime: -1 }), RangeError);
  assert.throws(() => collision.move(0, start, end, velocity, { timeSeconds: NaN }), TypeError);
  assert.throws(() => collision.bodies(0, Infinity), TypeError);
  assert.throws(() => collision.ensureSafe(0, start, velocity, NaN), TypeError);
  assert.throws(() => createGravityField({ sector: provider(sphere()) }).sample(0, start, Infinity), TypeError);
  assert.deepEqual(start, [0, 0, 0]); assert.deepEqual(end, [1, 0, 0]); assert.deepEqual(velocity, [1, 0, 0]);
});


test('world revision replaces cached orbit descriptors without freezing evaluated poses', () => {
  const body = sphere();
  const world = { revision: 0, sector: provider(body) };
  const field = createGravityField({ world }), collision = createCollisionWorld({ world });
  const before = field.sample(0, [0, 0, 0], 0);
  close(collision.bodies(0, 0)[0].position, [1000, 0, 0]);
  body.position[0] = 400;
  body.orbit.meanAnomalyAtEpoch = Math.PI;
  assert.deepEqual(field.sample(0, [0, 0, 0], 0), before);
  close(collision.bodies(0, 0)[0].position, [1000, 0, 0]);
  world.revision++;
  close(collision.bodies(0, 0)[0].position, [-600, 0, 0]);
  assert.ok(field.sample(0, [0, 0, 0], 0).acceleration[0] < 0);
  close(collision.bodies(0, orbitalPeriod(body.orbit) / 2)[0].position, [1400, 0, 0]);
});


test('large explicit gravity remains finite at the field cap or fails with a scale error', () => {
  const body = sphere({ orbit: undefined, radius: 1, mu: 1e308 });
  const sample = createGravityField({ sector: provider(body) }).sample(0, [1, 0, 0]);
  close(sample.acceleration, [-120, 0, 0]);
  assert.throws(() => bodyGravity({ ...body, radius: .1 }, [.1, 0, 0]), /representable numeric range/);
});


test('positive-duration static pinches retain simultaneous contact constraints and the static sweep result', () => {
  const bodies = [-139, 139].map((x, i) => sphere({ id: `fixed-${i}`, position: [x, 0, 0], radius: 100, orbit: undefined }));
  let calls = 0;
  const collision = createCollisionWorld({ sector: index => { calls++; return index === 0 ? bodies : []; } });
  const height = Math.sqrt(140 ** 2 - 139 ** 2), start = [0, height + 1, 0], end = [0, height - 1, 0];
  const expected = collision.move(0, start, end, [0, -240, 0]);
  const result = collision.move(0, start, end, [0, -240, 0], { deltaTime: 1 / 120 });
  assert.deepEqual(result, expected);
  close(result.velocity, [0, 0, 0]);
  assert.equal(calls, 27);
  for (const body of bodies) assert.ok(distance(result.position, body.position) >= 140 - 1e-7);
});

test('mixed moving and static pinches satisfy both surface constraints without alternating contacts', () => {
  const bodies = [sphere({ id: 'fixed', position: [-139, 0, 0], radius: 100, orbit: undefined }),
    sphere({ id: 'moving', position: [139, -600, 0], radius: 100,
      orbit: { semiMajorAxis: 600, eccentricity: 0, mu: 1e6, meanAnomalyAtEpoch: Math.PI / 2 } })];
  const collision = createCollisionWorld({ sector: index => index === 0 ? bodies : [] });
  const height = Math.sqrt(140 ** 2 - 139 ** 2), start = [0, height + 1, 0], end = [0, height - 1, 0], h = 1 / 120;
  const result = collision.move(0, start, end, [0, -240, 0], { deltaTime: h });
  assert.equal(result.corrected, true);
  assert.ok(result.position[0] < 0 && result.position[1] > height);
  assert.ok(result.velocity[0] < 0 && result.velocity[1] > 0);
  for (const body of bodies) assert.ok(distance(result.position, evaluateBodyState(body, h).position) >= 140 - 1e-7);
  assert.deepEqual(start, [0, height + 1, 0]); assert.deepEqual(end, [0, height - 1, 0]);
});

test('short same-cell static fast path does not hide moving bodies reached by a long sweep', () => {
  const target = encodeCell({ x: 3, y: 0, z: 0 });
  const body = sphere({ position: [-1000, 0, 0] });
  const collision = createCollisionWorld({ sector: index => index === target ? [body] : [] });
  const result = collision.move(0, [0, 0, 0], [80000, 0, 0], [9600000, 0, 0], { deltaTime: 1 / 120 });
  assert.equal(result.contact.id, body.id); assert.equal(result.contact.sectorIndex, target);
  assert.ok(result.distance < 80000);
});


test('dynamic branch retains both static contact planes when an unrelated orbit is nearby', () => {
  const height = Math.sqrt(140 ** 2 - 139 ** 2), start = [0, height + 1, 0], end = [0, height - 1, 0];
  const bodies = [-139, 139].map((x, i) => sphere({ id: `fixed-${i}`, position: [x, 0, 0], radius: 100, orbit: undefined }));
  bodies.push(sphere({ id: 'unrelated', position: [5000, 5000, 0] }));
  const collision = createCollisionWorld({ sector: index => index === 0 ? bodies : [] });
  const result = collision.move(0, start, end, [0, -240, 0], { deltaTime: 1 / 120 });
  close(result.velocity, [0, 0, 0]);
  close(result.position, [0, height, 0]);
  for (const body of bodies.slice(0, 2)) assert.ok(distance(result.position, body.position) >= 140 - 1e-7);
});

test('three simultaneous sphere contacts stop motion at their common corner', () => {
  const bodies = [0, 1, 2].map(axis => sphere({ id: `corner-${axis}`, radius: 100, orbit: undefined,
    position: [0, 1, 2].map(i => i === axis ? -140 : 0) }));
  bodies.push(sphere({ id: 'unrelated', position: [5000, 5000, 0] }));
  const collision = createCollisionWorld({ sector: index => index === 0 ? bodies : [] });
  const result = collision.move(0, [1, 1, 1], [-1, -1, -1], [-240, -240, -240], { deltaTime: 1 / 120 });
  close(result.velocity, [0, 0, 0]);
  close(result.position, [0, 0, 0]);
  for (const body of bodies.slice(0, 3)) assert.ok(distance(result.position, body.position) >= 140 - 1e-7);
});
