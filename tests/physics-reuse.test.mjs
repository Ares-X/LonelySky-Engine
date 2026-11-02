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

test('same-time orbital samples isolate caller translations, time scaling and metadata edits', () => {
  const body = moving(), otherBody = moving();
  otherBody.position[0] += 500; otherBody.orbit.meanAnomalyAtEpoch = .7;
  const sample = createBodyStateSampler(body), otherSample = createBodyStateSampler(otherBody);
  const time = orbitalPeriod(body.orbit) * .37, expected = evaluateBodyState(body, time);
  const out = state(), vectors = [out.position, out.velocity, out.acceleration];
  assert.equal(sample(time, out), out);
  for (let axis = 0; axis < 3; axis++) {
    out.position[axis] += 20_000;
    out.velocity[axis] *= .25;
    out.acceleration[axis] *= .25 ** 2;
  }
  for (const key of Object.keys(out)) if (!Array.isArray(out[key])) out[key] = -999;
  const snapshot = sample(time), anotherOut = state();
  assert.deepEqual(snapshot, expected);
  assert.equal(sample(time, anotherOut), anotherOut);
  assert.deepEqual(anotherOut, expected);
  snapshot.position.fill(999); snapshot.velocity.fill(999); snapshot.acceleration.fill(999);
  anotherOut.radius = 999;
  const otherSnapshot = otherSample(time);
  assert.deepEqual(otherSnapshot, evaluateBodyState(otherBody, time));
  assert.equal(sample(time, out), out);
  assert.deepEqual(out, expected);
  assert.equal(out.position, vectors[0]); assert.equal(out.velocity, vectors[1]); assert.equal(out.acceleration, vectors[2]);
  assert.notEqual(out.position, anotherOut.position);
  assert.notEqual(out.velocity, snapshot.velocity);
  assert.deepEqual(otherSample(time), otherSnapshot);
  for (const invalid of [NaN, Infinity, undefined]) assert.throws(() => sample(invalid, out), /timeSeconds/);
  assert.deepEqual(sample(time), expected);
});

test('failed orbital evaluation cannot expose its partial writes at a previously sampled time', () => {
  // Periapsis is representable, while the much weaker apoapsis acceleration
  // underflows to zero after sampleOrbit has already written its vectors.
  const body = { position: [0, 0, 0], orbit: { semiMajorAxis: 1e100, mu: 5e-124, eccentricity: .9 } };
  const sample = createBodyStateSampler(body), expected = sample(0), out = state();
  const failingTime = orbitalPeriod(body.orbit) / 2;
  assert.throws(() => sample(failingTime, out), /orbital state is outside the representable numeric range/);
  assert.deepEqual(sample(0, out), expected);
  assert.deepEqual(sample(-0), evaluateBodyState(body, -0));
  assert.throws(() => sample(failingTime), /orbital state is outside the representable numeric range/);
  assert.deepEqual(sample(0), expected);
});

test('orbital sampler outputs retain Float32 rounding and reject output-storage overflow', () => {
  const sample = createBodyStateSampler(moving());
  const out = {position: new Float32Array(3), velocity: new Float32Array(3), acceleration: new Float32Array(3)};
  sample(.37, out);
  assert.deepEqual(Array.from(out.position), [231.8397216796875, 329.2031555175781, -279.0693359375]);
  assert.deepEqual(Array.from(out.acceleration), [-82.24836730957031, -80.6035385131836, -13.05762767791748]);
  const expected = structuredClone(out);
  out.position.fill(0); out.acceleration.fill(0);
  assert.deepEqual(sample(.37, out), expected);
  const fast = createBodyStateSampler({position: [0, 0, 0], orbit: {semiMajorAxis: 1, eccentricity: 0, mu: 1e80}});
  const mixed = {position: new Float64Array(3), velocity: new Float32Array(3), acceleration: new Float64Array(3)};
  assert.throws(() => fast(0, mixed), /orbital state is outside the representable numeric range/);
  assert.ok(Number.isFinite(fast(0).velocity[1]), 'A caller conversion failure must not corrupt the valid private state');
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
