import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOrbit, orbitalPeriod, evaluateBodyState } from '../src/orbits.js';

const TAU = 2 * Math.PI;
const close = (actual, expected, tolerance = 2e-12) => assert.ok(
  Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
  `${actual} should be close to ${expected}`,
);
const vectorClose = (actual, expected, tolerance) => actual.forEach((n, i) => close(n, expected[i], tolerance));
const norm = v => Math.hypot(...v);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test('circle reaches known quarter periods with consistent velocity and acceleration', () => {
  const elements = { semiMajorAxis: 4, mu: 16, eccentricity: 0 };
  const period = orbitalPeriod(elements);
  close(period, 4 * Math.PI);
  for (const [fraction, position, velocity] of [
    [0, [4, 0, 0], [0, 2, 0]], [.25, [0, 4, 0], [-2, 0, 0]],
    [.5, [-4, 0, 0], [0, -2, 0]], [.75, [0, -4, 0], [2, 0, 0]],
  ]) {
    const state = evaluateOrbit(elements, period * fraction);
    vectorClose(state.position, position);
    vectorClose(state.velocity, velocity);
    vectorClose(state.acceleration, position.map(n => -n / 4));
    close(state.radius, 4);
  }
});

test('periapsis and apoapsis obey vis-viva and recur once per Kepler period', () => {
  const elements = { semiMajorAxis: 12, mu: 91, eccentricity: .75 };
  const period = orbitalPeriod(elements), peri = evaluateOrbit(elements, 0);
  const apo = evaluateOrbit(elements, period / 2);
  close(peri.radius, 3); close(apo.radius, 21);
  close(norm(peri.velocity), Math.sqrt(91 * (2 / 3 - 1 / 12)));
  close(norm(apo.velocity), Math.sqrt(91 * (2 / 21 - 1 / 12)));
  vectorClose(evaluateOrbit(elements, period).position, peri.position);
  vectorClose(evaluateOrbit(elements, -period / 2).position, apo.position);
  close(orbitalPeriod({ ...elements, semiMajorAxis: 48 }) / period, 8);
  close(orbitalPeriod({ ...elements, mu: 364 }) / period, .5);
});

test('eccentric orbit conserves energy and angular momentum and uses inverse-square gravity', () => {
  const elements = { semiMajorAxis: 17, mu: 101, eccentricity: .93,
    inclination: .73, ascendingNode: 1.2, argumentOfPeriapsis: -.8 };
  const period = orbitalPeriod(elements), initial = evaluateOrbit(elements, 0);
  const momentum = cross(initial.position, initial.velocity);
  for (let i = -100; i <= 100; i++) {
    const state = evaluateOrbit(elements, period * i / 113);
    const radius = norm(state.position), speed = norm(state.velocity);
    close(state.radius, radius);
    close(speed * speed / 2 - elements.mu / radius, -elements.mu / (2 * elements.semiMajorAxis));
    close(speed * speed, elements.mu * (2 / radius - 1 / elements.semiMajorAxis));
    vectorClose(cross(state.position, state.velocity), momentum);
    close(norm(state.acceleration), elements.mu / (radius * radius));
    assert.ok(norm(state.acceleration) <= state.accelerationBound);
    vectorClose(state.acceleration, state.position.map(n => -elements.mu * n / radius ** 3));
  }
});

test('orientation places the orbit in the requested right-handed three-dimensional frame', () => {
  const elements = { semiMajorAxis: 4, mu: 16, eccentricity: 0, inclination: Math.PI / 2,
    ascendingNode: Math.PI / 2, argumentOfPeriapsis: Math.PI / 2 };
  const start = evaluateOrbit(elements, 0), quarter = evaluateOrbit(elements, orbitalPeriod(elements) / 4);
  vectorClose(start.position, [0, 0, 4]);
  vectorClose(start.velocity, [0, -2, 0]);
  vectorClose(quarter.position, [0, -4, 0]);
  vectorClose(cross(start.position, start.velocity), [8, 0, 0]);
});

test('position and velocity derivatives agree with the returned physical state', () => {
  const elements = { semiMajorAxis: 8, mu: 13, eccentricity: .81,
    inclination: 1.1, ascendingNode: .9, argumentOfPeriapsis: .3 };
  const period = orbitalPeriod(elements), step = period * 1e-6;
  for (const fraction of [.05, .27, .63, .94]) {
    const time = period * fraction, state = evaluateOrbit(elements, time);
    const before = evaluateOrbit(elements, time - step), after = evaluateOrbit(elements, time + step);
    vectorClose(after.position.map((n, i) => (n - before.position[i]) / (2 * step)), state.velocity, 1e-8);
    vectorClose(after.velocity.map((n, i) => (n - before.velocity[i]) / (2 * step)), state.acceleration, 1e-8);
  }
});

test('high-eccentricity states remain finite and resolve periapsis at very small mean anomaly', () => {
  for (const eccentricity of [.999, .999999999999, 1 - Number.EPSILON / 2]) {
    for (const meanAnomalyAtEpoch of [0, 1e-30, -1e-30, 1e-24, -1e-24, 1e-12, -1e-12, .001, -Math.PI]) {
      const state = evaluateOrbit({ semiMajorAxis: 1, mu: 1, eccentricity, meanAnomalyAtEpoch }, 0);
      assert.ok([state.radius, state.eccentricAnomaly, ...state.position, ...state.velocity,
        ...state.acceleration].every(Number.isFinite));
      assert.ok(state.radius > 0);
      close(norm(state.position) / state.radius, 1);
      if (meanAnomalyAtEpoch === 0) close(state.radius / (1 - eccentricity), 1);
      if (Math.abs(meanAnomalyAtEpoch) === 1e-30) {
        // At this scale the linear term dominates even for the nearest float below e = 1.
        close(state.eccentricAnomaly * (1 - eccentricity) / meanAnomalyAtEpoch, 1, 1e-6);
      }
    }
  }
});

test('states are independent of call order, support negative time and a rebased epoch', () => {
  const elements = Object.freeze({ semiMajorAxis: 6, mu: 5, eccentricity: .72,
    meanAnomalyAtEpoch: .42, epochSeconds: 7 });
  const times = [0, -3000, 1e6, 13, -10], expected = times.map(t => evaluateOrbit(elements, t));
  for (let i = times.length - 1; i >= 0; i--) assert.deepEqual(evaluateOrbit(elements, times[i]), expected[i]);
  const atEpoch = evaluateOrbit(elements, 200);
  const rebased = { ...elements, epochSeconds: 200, meanAnomalyAtEpoch: atEpoch.meanAnomaly };
  for (const time of times) vectorClose(evaluateOrbit(rebased, time).position, evaluateOrbit(elements, time).position);
  const reverse = evaluateOrbit({ ...elements, meanAnomalyAtEpoch: 0, epochSeconds: 0 }, -3);
  const forward = evaluateOrbit({ ...elements, meanAnomalyAtEpoch: 0, epochSeconds: 0 }, 3);
  vectorClose(reverse.position, [forward.position[0], -forward.position[1], 0]);
});

test('large finite time and phase avoid multiplication or time-subtraction overflow', () => {
  const elements = { semiMajorAxis: 1, mu: 1e200, eccentricity: .6,
    meanAnomalyAtEpoch: Number.MAX_VALUE, epochSeconds: -Number.MAX_VALUE };
  const state = evaluateOrbit(elements, Number.MAX_VALUE);
  assert.ok([...state.position, ...state.velocity, ...state.acceleration].every(Number.isFinite));
  assert.ok(Math.abs(state.meanAnomaly) <= Math.PI);
  const ordinary = { semiMajorAxis: 4, mu: 16, eccentricity: .5 };
  const time = 2 ** 40, period = orbitalPeriod(ordinary);
  vectorClose(evaluateOrbit(ordinary, time).position, evaluateOrbit(ordinary, time % period).position);
  // These scales would overflow a naive a³ calculation.
  assert.ok(Number.isFinite(orbitalPeriod({ semiMajorAxis: 1e150, mu: 1e150 })));
});

test('invalid inputs and nonrepresentable states fail explicitly without clamping', () => {
  const elements = { semiMajorAxis: 2, mu: 3, eccentricity: .4 };
  for (const field of ['semiMajorAxis', 'mu']) {
    for (const value of [0, -1, NaN, Infinity, '2']) {
      assert.throws(() => orbitalPeriod({ ...elements, [field]: value }), /positive|finite/);
    }
  }
  for (const eccentricity of [-.01, 1, 1.1, NaN, Infinity, undefined]) {
    assert.throws(() => evaluateOrbit({ ...elements, eccentricity }, 0), /eccentricity/);
  }
  for (const field of ['inclination', 'ascendingNode', 'argumentOfPeriapsis', 'meanAnomalyAtEpoch', 'epochSeconds']) {
    assert.throws(() => evaluateOrbit({ ...elements, [field]: Infinity }, 0), /finite/);
  }
  assert.throws(() => evaluateOrbit(elements, NaN), /timeSeconds/);
  assert.throws(() => evaluateOrbit(elements, undefined), /timeSeconds/);
  assert.throws(() => orbitalPeriod({ semiMajorAxis: Number.MAX_VALUE, mu: Number.MIN_VALUE }), /numeric range/);
  assert.throws(() => evaluateOrbit({ semiMajorAxis: 1e-150, mu: 1e150, eccentricity: .999 }, 0), /numeric range/);
});

test('static body state is detached and stationary at any finite time', () => {
  const body = Object.freeze({ position: Object.freeze([10, -20, 30]) });
  const state = evaluateBodyState(body, -1e12);
  assert.deepEqual(state, { position: [10, -20, 30], velocity: [0, 0, 0], acceleration: [0, 0, 0], accelerationBound: 0 });
  assert.notEqual(state.position, body.position);
  state.position[0] = 500;
  state.velocity[0] = 500;
  assert.deepEqual(evaluateBodyState(body, 1e12).position, [10, -20, 30]);
  assert.deepEqual(evaluateBodyState(body, 1e12).velocity, [0, 0, 0]);
  assert.deepEqual(evaluateBodyState({ ...body, orbit: null }, 0).position, body.position);
});

test('orbiting body state translates only position by its immutable fixed focus', () => {
  const orbit = Object.freeze({ semiMajorAxis: 8, mu: 13, eccentricity: .81,
    inclination: 1.1, ascendingNode: .9, argumentOfPeriapsis: .3 });
  const body = Object.freeze({ position: Object.freeze([200, -70, 35]), orbit });
  for (const time of [-100, 0, 10, 300]) {
    const relative = evaluateOrbit(orbit, time), state = evaluateBodyState(body, time);
    assert.deepEqual(state, { ...relative, position: relative.position.map((n, i) => n + body.position[i]) });
    close(norm(state.position.map((n, i) => n - body.position[i])), state.radius);
    assert.notEqual(state.position, body.position);
    state.position[0] = 1000;
    state.velocity[0] = 1000;
    assert.deepEqual(evaluateBodyState(body, time).velocity, relative.velocity);
  }
  assert.deepEqual(body.position, [200, -70, 35]);
});

test('body sampling validates static and orbiting inputs and rejects translation overflow', () => {
  const orbit = { semiMajorAxis: 2, mu: 3, eccentricity: .4 };
  for (const descriptor of [{}, { orbit }]) {
    for (const position of [undefined, null, [0, 0], [0, 0, 0, 0], Array(3), [0, NaN, 0], [0, Infinity, 0], [0, '1', 0]]) {
      assert.throws(() => evaluateBodyState({ ...descriptor, position }, 0), /body.position/);
    }
    for (const time of [undefined, NaN, Infinity, '0']) {
      assert.throws(() => evaluateBodyState({ ...descriptor, position: [0, 0, 0] }, time), /timeSeconds/);
    }
  }
  assert.throws(() => evaluateBodyState(null, 0), /body.position/);
  assert.throws(() => evaluateBodyState({ position: [0, 0, 0], orbit: {} }, 0), /semiMajorAxis/);
  assert.throws(() => evaluateBodyState({ position: [Number.MAX_VALUE, 0, 0],
    orbit: { semiMajorAxis: 1e307, mu: 1e308, eccentricity: 0 } }, 0), /translated orbital position/);
});

test('acceleration bound is the periapsis maximum and rejects unrepresentable maxima even at apoapsis', () => {
  const elements = { semiMajorAxis: 19, mu: 241, eccentricity: .97,
    inclination: .5, ascendingNode: 1.7, argumentOfPeriapsis: -.8 };
  const periapsis = evaluateOrbit(elements, 0);
  const maximum = elements.mu / (elements.semiMajorAxis * (1 - elements.eccentricity)) ** 2;
  close(periapsis.accelerationBound, maximum);
  close(norm(periapsis.acceleration), periapsis.accelerationBound);
  for (let i = 0; i <= 300; i++) {
    const state = evaluateOrbit(elements, orbitalPeriod(elements) * i / 300);
    assert.equal(state.accelerationBound, periapsis.accelerationBound);
    assert.ok(norm(state.acceleration) <= state.accelerationBound);
  }
  // The instantaneous apoapsis state would fit; the maximum at periapsis does not.
  assert.throws(() => evaluateOrbit({ semiMajorAxis: 1e-100, mu: 1e100,
    eccentricity: .999999, meanAnomalyAtEpoch: Math.PI }, 0), /acceleration bound/);
});
