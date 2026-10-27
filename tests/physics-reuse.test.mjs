import test from 'node:test';
import assert from 'node:assert/strict';
import { createBodyStateSampler, evaluateBodyState, orbitalPeriod } from '../src/orbits.js';
import { createGravityField } from '../src/gravity.js';
import { createCollisionWorld } from '../src/collision.js';

const state = () => ({ position: [0, 0, 0], velocity: [0, 0, 0], acceleration: [0, 0, 0] });
const moving = () => ({ id: 'moving', type: 'planet', radius: 10, position: [100, 200, -300],
  orbit: { semiMajorAxis: 600, eccentricity: .7, mu: 4e6, inclination: .3, ascendingNode: .4 } });
const norm = v => Math.hypot(...v);
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('prepared body samples keep independent outputs and invariant orbital energy', () => {
  const body = moving(), original = structuredClone(body), sample = createBodyStateSampler(body);
  const out = state(), position = out.position, velocity = out.velocity, acceleration = out.acceleration;
  const other = state(), at = orbitalPeriod(body.orbit) * .27;
  sample(at, out);
  const snapshot = sample(at);
  assert.deepEqual(out, evaluateBodyState(body, at));
  body.position[0] = 999; body.orbit.mu = 1;
  for (const time of [0, at, -at, at * 4, at]) {
    assert.equal(sample(time, out), out);
    assert.equal(out.position, position); assert.equal(out.velocity, velocity); assert.equal(out.acceleration, acceleration);
    const radius = Math.hypot(...out.position.map((n, i) => n - original.position[i]));
    near(norm(out.velocity) ** 2 / 2 - original.orbit.mu / radius, -original.orbit.mu / (2 * original.orbit.semiMajorAxis));
    near(norm(out.acceleration), original.orbit.mu / radius ** 2);
    sample(-time, other);
    assert.notEqual(out.position, other.position);
  }
  assert.deepEqual(snapshot, evaluateBodyState(original, at));
  out.position.fill(0); sample(at, out);
  assert.deepEqual(out, snapshot);
  assert.throws(() => sample(NaN, out), /timeSeconds/);
  assert.throws(() => createBodyStateSampler({ position: [0, NaN, 0] }), /body.position/);
  assert.throws(() => createBodyStateSampler({ position: [0, 0, 0], orbit: {} }), /semiMajorAxis/);
});

test('gravity workspaces isolate simultaneous consumers and replace sources after revisions', () => {
  const body = moving();
  const world = { revision: 0, sector: index => index === 0 ? [body] : [] };
  const field = createGravityField({ world }), a = field.createSample(), b = field.createSample();
  const start = [0, 0, 0], acceleration = a.acceleration;
  field.sampleInto(0, start, 1, a);
  const source = a.source, sourcePosition = source.position, snapshot = structuredClone(a);
  field.sampleInto(0, [1000, -500, 200], 2, b);
  assert.deepEqual(a, snapshot); assert.notEqual(a.source, b.source);
  assert.deepEqual(field.sample(0, start, 1), snapshot);
  field.sampleInto(0, [1e6, 1e6, 1e6], 2, a);
  assert.equal(a.source, null); assert.equal(a.acceleration, acceleration);
  assert.deepEqual(a.acceleration, [0, 0, 0]);
  field.sampleInto(0, start, 1, a);
  assert.equal(a.source, source); assert.equal(a.source.position, sourcePosition);
  assert.deepEqual(a, snapshot);
  body.position[0] += 300;
  field.sampleInto(0, start, 1, a); assert.deepEqual(a, snapshot);
  world.revision++;
  field.sampleInto(0, start, 1, a);
  near(a.source.position[0] - snapshot.source.position[0], 300);
  assert.deepEqual(a, createGravityField({ world }).sample(0, start, 1));
  assert.throws(() => field.sampleInto(0, start, 1, {}), /createSample/);
});

test('closing moving spheres report infeasible constraints without advancing or fabricating a safe endpoint', () => {
  const bodies = [-1, 1].map(sign => ({ id: `closing-${sign}`, type: 'planet', radius: 10,
    position: [sign * 60, -sign * 1000, 0],
    orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 4e9, meanAnomalyAtEpoch: sign * Math.PI / 2 } }));
  const collision = createCollisionWorld({ sector: index => index === 0 ? bodies : [] });
  const start = [0, 0, 0], end = [0, 0, .1], velocity = [0, 0, 12];
  const result = collision.move(0, start, end, velocity, { deltaTime: 1 / 120 });
  assert.equal(result.failure.code, 'infeasible-moving-contact');
  assert.equal(result.failure.timeSeconds, 0);
  assert.ok(result.failure.failedTimeSeconds > 0 && result.failure.failedTimeSeconds < 1 / 120);
  assert.match(result.failure.cause.message, /no feasible/);
  assert.equal(result.failure.contacts.length, 2);
  assert.equal(result.distance, 0); assert.equal(result.corrected, true);
  assert.deepEqual(result.position, start); assert.deepEqual(result.velocity, velocity);
  assert.deepEqual(start, [0, 0, 0]); assert.deepEqual(end, [0, 0, .1]);
  for (const body of bodies) {
    assert.ok(norm(evaluateBodyState(body, 0).position) > 50);
    assert.ok(norm(evaluateBodyState(body, 1 / 120).position) < 50);
  }
  // Diagnostics are detached; editing a retained failure cannot poison retries.
  result.failure.contacts[0].normal.fill(9999); result.position.fill(9999);
  const again = collision.move(0, start, end, velocity, { deltaTime: 1 / 120 });
  assert.deepEqual(again.position, start);
  assert.ok(again.failure.contacts.every(contact => norm(contact.normal) < 1.000001));
});
