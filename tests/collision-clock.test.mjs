import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionWorld } from '../src/collision.js';
import { evaluateBodyState } from '../src/orbits.js';
import { CELL_SIZE, encodeCell, decodeCell, wrapCell } from '../src/coordinates.js';

const zero = [0, 0, 0], h = 1 / 120;
const body = () => ({ id: 'clock-moon', type: 'planet', radius: 10, position: [0, 0, 0],
  orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 1e13 } });
const provider = sphere => index => index === 0 ? [sphere] : [];
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
const close = (a, b, tolerance = 1e-6) => assert.ok(distance(a, b) < tolerance, `${a} != ${b}`);
function compare(actual, expected) {
  close(actual.position, expected.position); close(actual.velocity, expected.velocity);
  assert.equal(actual.corrected, expected.corrected); assert.equal(actual.failure?.code, expected.failure?.code);
  assert.ok(Math.abs(actual.distance - expected.distance) < 1e-6);
  assert.equal(actual.contact?.id, expected.contact?.id);
  if (actual.contact) {
    close(actual.contact.position, expected.contact.position);
    close(actual.contact.velocity, expected.contact.velocity);
    close(actual.contact.normal, expected.contact.normal);
  }
}

// This compares the clock mapping to a separately prepared physical two-body
// system: n ∝ sqrt(mu), so mu*s² traces the same phase path in physical time.
function slowedBody(sphere, timeSeconds, scale) {
  return { ...sphere, orbit: { ...sphere.orbit, mu: sphere.orbit.mu * scale * scale,
    epochSeconds: timeSeconds, meanAnomalyAtEpoch: evaluateBodyState(sphere, timeSeconds).meanAnomaly } };
}

test('frozen phase has static surfaces while a moving ship keeps its complete swept displacement', () => {
  const sphere = body(), collision = createCollisionWorld({ sector: provider(sphere) });
  for (const timeSeconds of [0, .017, -.04]) {
    const state = evaluateBodyState(sphere, timeSeconds);
    const fixed = { ...sphere, position: state.position, orbit: undefined };
    const reference = createCollisionWorld({ sector: provider(fixed) });
    const start = state.position.map((n, i) => n + (i === 0 ? -400 : 0));
    const end = state.position.map((n, i) => n + (i === 0 ? 400 : 0));
    const frozen = collision.move(0, start, end, [96000, 0, 0], { timeSeconds, deltaTime: h, timeScale: 0 });
    compare(frozen, reference.move(0, start, end, [96000, 0, 0], { timeSeconds, deltaTime: h }));
    assert.deepEqual(frozen.contact.velocity, zero);
    const recovered = collision.ensureSafe(0, state.position, zero, timeSeconds, 0);
    compare(recovered, reference.ensureSafe(0, state.position, zero, timeSeconds));
    assert.deepEqual(recovered.velocity, zero); assert.deepEqual(recovered.contact.velocity, zero);
    const stationary = state.position.map((n, i) => n + (i === 1 ? 100 : 0));
    const unhit = collision.move(0, stationary, stationary, zero, { timeSeconds, deltaTime: h, timeScale: 0 });
    assert.equal(unhit.corrected, false); assert.deepEqual(unhit.velocity, zero);
  }
});

test('fractional phase rate matches a lower-mu Kepler system including contact surface speed and curvature', () => {
  const sphere = body(), collision = createCollisionWorld({ sector: provider(sphere) });
  for (const timeScale of [.4, 1]) for (const timeSeconds of [0, .017, -.04]) {
    const slower = slowedBody(sphere, timeSeconds, timeScale);
    const reference = createCollisionWorld({ sector: provider(slower) });
    const center = evaluateBodyState(sphere, timeSeconds).position;
    const velocity = evaluateBodyState(sphere, timeSeconds).velocity;
    const speed = Math.hypot(...velocity), start = center.map((n, i) => n + velocity[i] / speed * 100);
    for (const deltaTime of [h / 2, h, h * 2]) {
      const actual = collision.move(0, start, start, zero, { timeSeconds, deltaTime, timeScale });
      const expected = reference.move(0, start, start, zero, { timeSeconds, deltaTime });
      compare(actual, expected); assert.equal(actual.contact.id, sphere.id); assert.equal(actual.failure, undefined);
      const finalPhase = timeSeconds + deltaTime * timeScale;
      assert.ok(distance(actual.position, evaluateBodyState(sphere, finalPhase).position) >= 50 - 1e-6);
    }
  }
});

test('same phase and duration can switch clock rates without reusing stale samples or chords', () => {
  const sphere = body(), sector = provider(sphere), collision = createCollisionWorld({ sector });
  const position = [1000, 100, 0];
  for (const timeScale of [1, 0, .4, 1, .4, 0, 1]) {
    const options = { timeSeconds: 0, deltaTime: h, timeScale };
    assert.deepEqual(collision.move(0, position, position, zero, options),
      createCollisionWorld({ sector }).move(0, position, position, zero, options));
    const snapshot = collision.bodies(0, 0, timeScale)[0], physical = evaluateBodyState(sphere, 0);
    close(snapshot.velocity, physical.velocity.map(n => n * timeScale));
    assert.deepEqual(collision.bodies(0, 0, timeScale), createCollisionWorld({ sector }).bodies(0, 0, timeScale));
  }
  assert.deepEqual(collision.move(0, position, position, zero, { deltaTime: h }),
    collision.move(0, position, position, zero, { deltaTime: h, timeScale: 1 }));
});

test('frozen macro moons remain static across ordinary and toroidal floating-origin seams', () => {
  for (const baseX of [0, 16383]) {
    const west = encodeCell({ x: baseX, y: 0, z: 0 });
    const east = encodeCell({ x: wrapCell(baseX + 1), y: 0, z: 0 });
    const sphere = { ...body(), radius: 5000, position: [-990000, 0, 0],
      orbit: { semiMajorAxis: 1000000, eccentricity: 0, mu: 1e16 } };
    const world = { sector: () => [], bodiesInBounds(index) {
      return [{ ...sphere, position: sphere.position.map((n, i) => n + (i === 0 ? wrapCell(baseX - decodeCell(index).x) * CELL_SIZE : 0)) }];
    } };
    const collision = createCollisionWorld({ world });
    for (const timeScale of [0, .4, 1]) {
      const start = [10000, 5500, 0], rebased = [-10000, 5500, 0];
      const options = { timeSeconds: 0, deltaTime: h, timeScale };
      const a = collision.move(west, start, start, zero, options);
      const b = collision.move(east, rebased, rebased, zero, options);
      close(a.position, b.position.map((n, i) => n + (i === 0 ? CELL_SIZE : 0)));
      close(a.velocity, b.velocity); assert.equal(a.contact?.id, b.contact?.id);
      if (timeScale === 0) assert.equal(a.contact, null);
    }
  }
});

test('clock rate keeps dynamic work bounded while frozen bodies allow long physical intervals', () => {
  const sphere = body(), collision = createCollisionWorld({ sector: provider(sphere) });
  const start = [1000, 100, 0];
  for (const timeScale of [.4, 1]) {
    assert.throws(() => collision.move(0, start, start, zero, { deltaTime: 1, timeScale }), /subdivide/);
  }
  const frozen = collision.move(0, start, [1000, 200, 0], [0, 100, 0], { deltaTime: 100, timeScale: 0 });
  assert.deepEqual(frozen.position, [1000, 200, 0]); assert.equal(frozen.failure, undefined);
  for (const timeScale of [-1, 1.1, NaN, Infinity, '.4']) {
    assert.throws(() => collision.move(0, start, start, zero, { deltaTime: h, timeScale }), /timeScale/);
    assert.throws(() => collision.ensureSafe(0, start, zero, 0, timeScale), /timeScale/);
    assert.throws(() => collision.bodies(0, 0, timeScale), /timeScale/);
  }
});

test('failure timestamps report orbit phase rather than physical elapsed time', () => {
  const timeSeconds = .123, timeScale = .4;
  const bodies = [-1, 1].map(sign => ({ id: `closing-${sign}`, type: 'planet', radius: 10,
    position: [sign * 60, -sign * 1000, 0],
    orbit: { semiMajorAxis: 1000, eccentricity: 0, mu: 4e9 / timeScale ** 2,
      meanAnomalyAtEpoch: sign * Math.PI / 2, epochSeconds: timeSeconds } }));
  const collision = createCollisionWorld({ sector: index => index === 0 ? bodies : [] });
  const result = collision.move(0, zero, [0, 0, .1], [0, 0, 12], { timeSeconds, deltaTime: h, timeScale });
  assert.equal(result.failure.code, 'infeasible-moving-contact');
  assert.equal(result.failure.timeSeconds, timeSeconds);
  assert.ok(result.failure.failedTimeSeconds > timeSeconds);
  assert.ok(result.failure.failedTimeSeconds < timeSeconds + h * timeScale);
  assert.equal(result.failure.safeAtStart, true); assert.deepEqual(result.position, zero);
});
