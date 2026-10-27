import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionWorld, safeRadius } from '../src/collision.js';
import { solidDistance } from '../src/solid-geometry.js';
import { CELL_SIZE, encodeCell } from '../src/coordinates.js';

const part = (extra = {}) => ({ type: 'annular-sector-slab', innerRadius: 100, outerRadius: 200, minY: -10, maxY: 10, gapCenter: 0, gapHalfAngle: 0, ...extra });
const ring = (extra = {}) => ({ id: 'ring', position: [0, 0, 0], boundsRadius: 203, shape: { type: 'compound', parts: [part()] }, ...extra });
const worldFor = (solids, extra = {}) => createCollisionWorld({ sector: () => [], solidProvider: () => solids, ...extra });
const near = (actual, expected, epsilon = 2e-5) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('solid TOI competes with old sphere TOI in the same event loop', () => {
  const solid = { id: 'new', position: [0, 0, 0], boundsRadius: 20, shape: { type: 'sphere', radius: 20 } };
  const old = { id: 'old', position: [200, 0, 0], type: 'planet', radius: 20 };
  const collision = worldFor([solid], { sector: index => index === 0 ? [old] : [] });
  const first = collision.move(0, [-1000, 0, 0], [1000, 0, 0], [2000, 0, 0]);
  assert.equal(first.contact.id, 'new'); near(first.position[0], -28); assert.equal(first.failure, undefined);
  const reverse = collision.move(0, [1000, 0, 0], [-1000, 0, 0], [-2000, 0, 0]);
  assert.equal(reverse.contact.id, 'old'); near(reverse.position[0], 200 + safeRadius('planet', 20));
});

test('solid inclusion is provider driven and does not depend on a rendered neighborhood', () => {
  let queries = 0;
  const solid = ring(), world = { revision: 0, sector: () => [], solidsInBounds(index, bounds) {
    queries++; assert.equal(index, 0); assert.ok(bounds.min[0] <= bounds.max[0]); return [solid];
  } };
  const result = createCollisionWorld({ world }).move(0, [-1000, 0, 0], [1000, 0, 0], [2000, 0, 0]);
  near(result.position[0], -208); assert.ok(queries > 0); assert.equal(result.contact.contactKey, 'ring:0:outer');
});

test('whole narrow lip crossing blocks with neither endpoint overlapping', () => {
  const solid = ring({ shape: { type: 'compound', parts: [part({ innerRadius: 199.9, minY: -0.05, maxY: .05 })] } });
  const start = [-4000, 6, 0], end = [4000, 6, 0], collision = worldFor([solid]);
  assert.ok(solidDistance(solid, start).distance > 8); assert.ok(solidDistance(solid, end).distance > 8);
  const result = collision.move(0, start, end, [960000, 0, 0], { deltaTime: 1 / 120 });
  assert.equal(result.contact.id, 'ring'); assert.equal(result.contact.feature, 'outer-top');
  assert.ok(solidDistance(solid, result.position).distance >= 8 - 1e-6);
});

test('the real middle hole and open gap preserve a fast entire movement', () => {
  const solid = ring({ shape: { type: 'compound', parts: [part({ gapHalfAngle: .4 })] } }), collision = worldFor([solid]);
  for (const [start, end] of [[[0, -4000, 0], [0, 4000, 0]], [[0, 0, 0], [4000, 0, 0]]]) {
    const result = collision.move(0, start, end, end.map((n, i) => n - start[i]));
    assert.deepEqual(result.position, end); assert.equal(result.corrected, false); assert.equal(result.failure, undefined);
  }
});

test('cap tangent and near tangent paths retain free movement and along-wall velocity', () => {
  const solid = ring(), collision = worldFor([solid]);
  for (const y of [18, 18 + 1e-4]) {
    const result = collision.move(0, [-4000, y, 0], [4000, y, 0], [960000, 0, 0]);
    assert.deepEqual(result.position, [4000, y, 0]); assert.equal(result.contact, null);
  }
  const enter = collision.move(0, [150, 30, -20], [150, 0, 20], [0, -30, 40]);
  near(enter.position[1], 18); near(enter.position[2], 20); near(enter.velocity[1], 0); near(enter.velocity[2], 40);
  const slide = collision.move(0, enter.position, [150, enter.position[1], 50], [0, 0, 40]);
  near(slide.position[2], 50); assert.equal(slide.failure, undefined);
});

test('compound recovery verifies all parts and overlapping legacy envelopes', () => {
  const solid = ring({ shape: { type: 'compound', parts: [part(), part({ minY: 5, maxY: 30 })] } });
  const sphere = { id: 'legacy', position: [150, 25, 0], radius: 10, type: 'planet' };
  const collision = worldFor([solid], { sector: index => index === 0 ? [sphere] : [] });
  const start = [150, 7, 0], velocity = [0, -3, 0], before = structuredClone({ start, velocity, solid, sphere });
  const first = collision.ensureSafe(0, start, velocity), second = collision.ensureSafe(0, start, velocity);
  assert.deepEqual(first, second); assert.equal(first.distance, 0); assert.equal(first.corrected, true);
  assert.ok(solidDistance(solid, first.position).distance >= 8 - 1e-6);
  assert.ok(Math.hypot(...first.position.map((n, i) => n - sphere.position[i])) >= safeRadius('planet', 10) - 1e-6);
  assert.deepEqual({ start, velocity, solid, sphere }, before);
});

test('initial solid recovery uses an actual nearby surface instead of its bounding sphere', () => {
  const solid = ring(), result = worldFor([solid]).ensureSafe(0, [150, 0, 0], [0, -1, 0]);
  near(result.position[0], 150); near(result.position[1], 18); assert.ok(Math.hypot(...result.position) < solid.boundsRadius);
  assert.equal(result.contact.feature, 'top');
});

test('solid queries and contacts agree at ordinary and toroidal floating-origin seams', () => {
  for (const x of [0, 16383]) {
    const first = encodeCell({ x, y: 0, z: 0 }), second = encodeCell({ x: x === 16383 ? -16384 : x + 1, y: 0, z: 0 });
    const provider = index => [ring({ position: [index === first ? CELL_SIZE / 2 : -CELL_SIZE / 2, 0, 0] })];
    const collision = createCollisionWorld({ sector: () => [], solidProvider: provider });
    const a = collision.move(first, [9000, 0, 0], [11000, 0, 0], [2000, 0, 0]);
    const b = collision.move(second, [-11000, 0, 0], [-9000, 0, 0], [2000, 0, 0]);
    near(a.position[0], b.position[0] + CELL_SIZE); assert.deepEqual(a.velocity, b.velocity); assert.equal(a.contact.contactKey, b.contact.contactKey);
  }
});

test('a dynamic sphere neighborhood uses the same solid contact manifold', () => {
  const solid = ring(), moving = { id: 'far', type: 'planet', radius: 1, position: [0, 5000, 0], orbit: { semiMajorAxis: 500, eccentricity: 0, mu: 1e6 } };
  const collision = worldFor([solid], { sector: index => index === 0 ? [moving] : [] });
  const result = collision.move(0, [-1000, 15, 0], [1000, 15, 0], [240000, 0, 0], { deltaTime: 1 / 120 });
  assert.equal(result.contact.id, 'ring'); assert.equal(result.contact.feature, 'outer-top'); assert.equal(result.failure, undefined);
  assert.ok(solidDistance(solid, result.position).distance >= 8 - 1e-6);
});

test('solid root budget failure retains a verified safe pose and leaves input untouched', () => {
  const solid = ring(), start = [-1000, 15, 0], end = [1000, 15, 0], velocity = [10000, 0, 0];
  const before = structuredClone({ solid, start, end, velocity }), result = worldFor([solid], { solidSweepBudget: 1 }).move(0, start, end, velocity);
  assert.equal(result.failure.code, 'solid-root-budget'); assert.equal(result.failure.safeAtStart, true); assert.deepEqual(result.position, start);
  assert.ok(solidDistance(solid, result.position).distance >= 8); assert.deepEqual({ solid, start, end, velocity }, before);
});

test('recovery from the center of a giant solid is bounded without small-cell scan limits', () => {
  const solid = { id: 'giant', position: [0, 0, 0], boundsRadius: 600000, shape: { type: 'sphere', radius: 600000 } };
  const result = worldFor([solid]).ensureSafe(0, [0, 0, 0], [0, 0, 0]);
  near(result.position[1], 600008); assert.equal(result.distance, 0); assert.equal(result.corrected, true);
  assert.ok(solidDistance(solid, result.position).distance >= 8);
});

test('V3-scale concave wall contact keeps moving at 120Hz without penetration or budget failure', () => {
  const innerRadius = 900000;
  const solid = { id: 'large-ring', position: [0, 0, 0], boundsRadius: Math.hypot(990000, 2000), shape: { type: 'compound', parts: [part({ innerRadius, outerRadius: 990000, minY: -2000, maxY: 2000, gapCenter: Math.PI, gapHalfAngle: .1 })] } };
  for (const shipRadius of [8, 12]) {
    const collision = worldFor([solid], { shipRadius });
    let position = [innerRadius - shipRadius, 0, 0], velocity = [0, 0, 2025];
    for (let step = 0; step < 1200; step++) {
      const end = position.map((n, axis) => n + velocity[axis] / 120);
      const result = collision.move(0, position, end, velocity, { deltaTime: 1 / 120 });
      assert.equal(result.failure, undefined, `step ${step}`);
      assert.ok(solidDistance(solid, result.position).distance >= shipRadius - 1e-6, `step ${step}`);
      position = result.position; velocity = result.velocity;
    }
    assert.ok(position[2] > 20200); assert.ok(Math.hypot(...velocity) > 2024);
  }
});

test('returned solid contact vectors cannot alter the provider or subsequent collision results', () => {
  const solid = ring(), collision = worldFor([solid]);
  const args = [0, [-1000, 0, 0], [1000, 0, 0], [2000, 0, 0]];
  const first = collision.move(...args), expected = structuredClone(first);
  first.contact.position.fill(123); first.contact.normal.fill(123); first.contact.velocity.fill(123);
  assert.equal(first.contact.shape, undefined); assert.equal(first.contact.frame, undefined);
  assert.deepEqual(collision.move(...args), expected); assert.deepEqual(solid.position, [0, 0, 0]);
});

test('changing radius on one collision instance updates solid sphere/ring TOI and preserves legacy clearance/cache', () => {
  const sphere = { id: 'solid-sphere', position: [0, 0, 0], boundsRadius: 20, shape: { type: 'sphere', radius: 20 } };
  const annulus = ring({ position: [0, 1000, 0] });
  const legacy = { id: 'legacy', position: [0, 2000, 0], radius: 20, type: 'planet' };
  let descriptorQueries = 0, queryBounds;
  const collision = createCollisionWorld({
    sector: index => { descriptorQueries++; return index === 0 ? [legacy] : []; },
    solidProvider(index, bounds) {
      if (queryBounds) assert.equal(bounds, queryBounds);
      queryBounds = bounds;
      return [sphere, annulus];
    },
  });
  const sweepAt = y => collision.move(0, [-1000, y, 0], [1000, y, 0], [2000, 0, 0]);
  sweepAt(0);
  const cacheSize = collision.cacheSize, initialQueries = descriptorQueries;
  for (const radius of [7, 9, 11.5, 6, 9.5, .5, 0]) {
    collision.setShipRadius(radius);
    const ball = sweepAt(0), wall = sweepAt(1000), old = sweepAt(2000);
    assert.equal(ball.contact.id, 'solid-sphere'); near(ball.position[0], -20 - radius);
    assert.equal(wall.contact.id, 'ring'); near(wall.position[0], -200 - radius);
    assert.equal(old.contact.id, 'legacy'); near(old.position[0], -safeRadius('planet', 20));
    assert.equal(collision.cacheSize, cacheSize); assert.equal(descriptorQueries, initialQueries);
  }
  for (const invalid of [-1, NaN, Infinity, '7', null]) assert.throws(() => collision.setShipRadius(invalid), RangeError);
  near(sweepAt(0).position[0], -20);
});
