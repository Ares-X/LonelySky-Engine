import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL_SIZE, encodeCell, bodyGravity, createGravityField, GRAVITY_CACHE_LIMIT, MAX_GRAVITY,
  createCollisionWorld, COLLISION_CACHE_LIMIT, safeRadius, bodyCollisionRadius } from '../src/index.js';

const sphere = (id = 'sphere', position = [0, 0, 0], radius = 100) => ({ id, position, radius, type: 'planet' });
const provider = (bodies = [sphere()]) => index => index === 0 ? bodies : [];
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
const outside = (collision, index, position) => {
  for (const body of collision.bodies(index)) assert.ok(distance(position, body.position) >= body.clearance - 1e-7);
};

test('gravity uses supplied bodies only, softens and tapers at finite influence', () => {
  assert.deepEqual(createGravityField({ sector: provider([]) }).sample(0, [0, 0, 0]), {
    acceleration: [0, 0, 0], magnitude: 0, source: null,
  });
  for (const type of ['planet', 'star', 'black-hole']) {
    const body = { ...sphere(), type, influence: 10000 };
    const near = bodyGravity(body, [1000, 0, 0]), far = bodyGravity(body, [2000, 0, 0]);
    assert.ok(near[0] < 0 && Math.hypot(...near) > Math.hypot(...far) * 2);
    assert.deepEqual(bodyGravity(body, [0, 0, 0]), [0, 0, 0]);
    assert.deepEqual(bodyGravity(body, [10000, 0, 0]), [0, 0, 0]);
    assert.ok(Math.hypot(...bodyGravity(body, [9999.9999, 0, 0])) < 1e-8);
  }
  const field = createGravityField({ sector: provider([sphere('source', [1000, 0, 0], 600)]) });
  assert.equal(field.sample(0, [0, 0, 0]).source.id, 'source');
  assert.ok(field.sample(0, [0, 0, 0]).acceleration[0] > 0);
  const dense = createGravityField({ sector: provider(Array.from({ length: 100 }, () => sphere('dense', [100, 0, 0], 1000))) });
  assert.ok(dense.sample(0, [0, 0, 0]).magnitude <= MAX_GRAVITY + 1e-10);
});

test('unknown body types, including inherited object keys, use finite planet gravity', () => {
  const position = [1000, 200, -300], planet = sphere();
  const expected = bodyGravity(planet, position);
  assert.ok(expected.every(Number.isFinite));
  assert.ok(Math.hypot(...expected) > 0);
  for (const type of ['constructor', 'toString', '__proto__', 'valueOf', 'unknown', undefined]) {
    const body = { ...planet, type };
    assert.deepEqual(bodyGravity(body, position), expected);
    const sample = createGravityField({ sector: provider([body]) }).sample(0, position);
    assert.deepEqual(sample.acceleration, expected);
    assert.ok(Number.isFinite(sample.magnitude));
    assert.equal(sample.source.id, planet.id);
  }
});

test('gravity and collisions agree across ordinary and toroidal cell seams', () => {
  for (const x of [0, 16383]) {
    const before = encodeCell({ x, y: 0, z: 0 });
    const after = encodeCell({ x: x === 16383 ? -16384 : x + 1, y: 0, z: 0 });
    const sector = index => index === after ? [sphere('edge', [-9800, 0, 0])] : [];
    const field = createGravityField({ sector });
    const a = field.sample(before, [CELL_SIZE / 2 - .0001, 0, 0]);
    const b = field.sample(after, [-CELL_SIZE / 2 + .0001, 0, 0]);
    assert.ok(distance(a.acceleration, b.acceleration) < .00001);
    const collision = createCollisionWorld({ sector });
    const first = collision.move(before, [9900, 0, 0], [10500, 0, 0], [6000, 0, 0]);
    const second = collision.move(after, [-10100, 0, 0], [-9500, 0, 0], [6000, 0, 0]);
    assert.equal(first.contact.id, 'edge'); assert.equal(first.contact.sectorIndex, after);
    assert.ok(distance(first.position, second.position.map((n, i) => n + (i === 0 ? CELL_SIZE : 0))) < 1e-6);
    assert.deepEqual(first.velocity, second.velocity);
  }
});

test('continuous collision blocks high-speed whole-sphere and multi-cell leaps', () => {
  const collision = createCollisionWorld({ sector: provider() });
  const direct = collision.move(0, [-1000, 0, 0], [1000, 0, 0], [200000, 0, 0]);
  assert.deepEqual(direct.position, [-140, 0, 0]); assert.deepEqual(direct.velocity, [0, 0, 0]);
  assert.equal(direct.contact.id, 'sphere'); assert.equal(direct.distance, 860);
  const target = encodeCell({ x: 3, y: 0, z: 0 });
  const far = createCollisionWorld({ sector: index => index === target ? [sphere()] : [] });
  const leap = far.move(0, [0, 0, 0], [100000, 0, 0], [100000, 0, 0]);
  assert.ok(Math.abs(leap.position[0] - 59860) < 1e-6);
  assert.equal(leap.contact.sectorIndex, target);
  const empty = createCollisionWorld({ sector: provider([]) });
  const bounded = empty.move(0, [0, 0, 0], [1e9, 0, 0], [1e9, 0, 0]);
  assert.equal(bounded.distance, CELL_SIZE / 4 * 64); assert.equal(bounded.corrected, true);
});

test('tangency traverses freely while oblique contact preserves tangent velocity', () => {
  const collision = createCollisionWorld({ sector: provider() });
  const tangent = collision.move(0, [-300, 140, 0], [300, 140, 0], [600, 0, 0]);
  assert.equal(tangent.contact, null); assert.deepEqual(tangent.position, [300, 140, 0]);
  const slide = collision.move(0, [-300, 50, 20], [300, 50, 20], [600, 0, 0]);
  assert.ok(slide.position[1] > 50 && slide.position[2] > 20);
  assert.ok(Math.hypot(...slide.velocity) > 0 && Math.hypot(...slide.velocity) < 600);
  assert.ok(slide.velocity.reduce((sum, n, i) => sum + n * slide.contact.normal[i], 0) >= -1e-7);
  outside(collision, 0, slide.position);
});

test('safe recovery escapes overlapping spheres deterministically without flight distance', () => {
  const collision = createCollisionWorld({ sector: provider([sphere('a'), sphere('b', [0, 180, 0])]) });
  for (const velocity of [[0, 0, 0], [10, 20, 30]]) {
    const result = collision.ensureSafe(0, [0, 0, 0], velocity);
    assert.deepEqual(result, collision.ensureSafe(0, [0, 0, 0], velocity));
    assert.ok(result.position.every(Number.isFinite)); assert.ok(result.velocity.every(Number.isFinite));
    assert.equal(result.distance, 0); assert.equal(result.corrected, true);
    outside(collision, 0, result.position);
  }
  assert.ok(collision.ensureSafe(0, [0, 0, 0], [0, 0, 0]).position[1] > 320);
});

test('recovery follows connected overlaps through newly reached cells and toroidal seams', () => {
  for (const y of [0, 16383]) {
    const origin = encodeCell({ x: 0, y, z: 0 });
    const bodies = Array.from({ length: 3 }, (_, i) => {
      const cellY = y + i > 16383 ? y + i - 32768 : y + i;
      return { index: encodeCell({ x: 0, y: cellY, z: 0 }),
        body: sphere(`chain-${i}`, [0, -2000 * i, 0], 9000) };
    });
    const collision = createCollisionWorld({ sector: index => bodies.filter(item => item.index === index).map(item => item.body) });
    const start = [0, 0, 0], velocity = [0, 0, 0];
    const result = collision.ensureSafe(origin, start, velocity);
    assert.ok(result.position[1] > 45225 && result.position[1] < 45226);
    assert.equal(result.contact.id, 'chain-2');
    assert.equal(result.contact.sectorIndex, bodies[2].index);
    assert.deepEqual(result.contact.position, [0, 36000, 0]);
    assert.equal(result.corrected, true); assert.equal(result.distance, 0);
    for (let i = 0; i < bodies.length; i++) {
      assert.ok(distance(result.position, [0, i * 18000, 0]) >= safeRadius('planet', 9000));
    }
    assert.deepEqual(collision.ensureSafe(origin, start, velocity), result);
    assert.deepEqual(collision.ensureSafe(origin, result.position, result.velocity).position, result.position);
    assert.deepEqual(start, [0, 0, 0]); assert.deepEqual(velocity, [0, 0, 0]);
  }
});

test('unbounded overlap recovery fails explicitly without changing the caller pose', () => {
  // Every cell has two sub-half-cell envelopes whose union covers the +Y ray.
  const sector = () => [sphere('lower', [0, -5000, 0], 9000), sphere('upper', [0, 5000, 0], 9000)];
  const collision = createCollisionWorld({ sector });
  const start = [0, 0, 0], velocity = [0, 0, 0];
  assert.throws(() => collision.ensureSafe(0, start, velocity), {
    name: 'RangeError', message: 'No clear collision recovery pose within the scan limit',
  });
  const motion = collision.move(0, start, [100, 0, 0], velocity);
  assert.equal(motion.failure.code, 'recovery-scan-limit');
  assert.equal(motion.failure.safeAtStart, false);
  assert.equal(motion.distance, 0); assert.equal(motion.corrected, false);
  assert.deepEqual(motion.position, start); assert.deepEqual(motion.velocity, velocity);
  assert.ok(motion.failure.cause instanceof RangeError);
  assert.deepEqual(start, [0, 0, 0]); assert.deepEqual(velocity, [0, 0, 0]);
  assert.ok(collision.cacheSize <= COLLISION_CACHE_LIMIT);
});

test('physics caches stay bounded and world revision invalidates same-cell snapshots', () => {
  let generated = 0, bodies = [];
  const world = { revision: 0, sector(index) { generated++; return index === 0 ? bodies : []; } };
  const field = createGravityField({ world }), collision = createCollisionWorld({ world });
  for (let i = 0; i < 10; i++) {
    assert.equal(field.sample(0, [1000, 0, 0]).source, null);
    assert.deepEqual(collision.bodies(0), []);
  }
  assert.equal(generated, 54);
  bodies = [sphere('added')];
  assert.equal(field.sample(0, [1000, 0, 0]).source, null);
  assert.deepEqual(collision.bodies(0), []);
  world.revision++;
  assert.equal(field.sample(0, [1000, 0, 0]).source.id, 'added');
  assert.equal(collision.move(0, [-300, 0, 0], [300, 0, 0], [600, 0, 0]).contact.id, 'added');
  assert.equal(generated, 108);
  for (let x = 1; x < 100; x++) {
    const index = encodeCell({ x, y: 0, z: 0 });
    field.sample(index, [0, 0, 0]); collision.bodies(index);
  }
  assert.ok(field.cacheSize <= GRAVITY_CACHE_LIMIT);
  assert.ok(collision.cacheSize <= COLLISION_CACHE_LIMIT);
});

test('clearance overrides only widen envelopes and returned collision data is isolated', () => {
  assert.equal(safeRadius('planet', 100), 140);
  assert.equal(safeRadius('star', 100), 240);
  assert.equal(safeRadius('black-hole', 100), 400);
  for (const collisionClearance of [undefined, NaN, Infinity, -1, 0, '900', 120]) {
    assert.equal(bodyCollisionRadius({ radius: 100, collisionClearance }), 140);
  }
  assert.equal(bodyCollisionRadius({ radius: 100, collisionClearance: 900 }), 900);
  const bodies = [sphere()], snapshot = JSON.stringify(bodies);
  const collision = createCollisionWorld({ sector: provider(bodies) });
  const start = [-300, 0, 0], end = [300, 0, 0], velocity = [600, 0, 0];
  const result = collision.move(0, start, end, velocity);
  result.contact.position[0] = 10000; result.contact.normal[0] = 5;
  collision.bodies(0)[0].position[0] = 10000;
  assert.equal(JSON.stringify(bodies), snapshot);
  assert.deepEqual(start, [-300, 0, 0]); assert.deepEqual(end, [300, 0, 0]); assert.deepEqual(velocity, [600, 0, 0]);
  assert.deepEqual(collision.move(0, start, end, velocity).position, [-140, 0, 0]);
  assert.throws(() => collision.move(0, start, [Infinity, 0, 0], velocity), TypeError);
  assert.throws(() => collision.ensureSafe(0, [0, 0], velocity), TypeError);
  assert.throws(() => createGravityField(), TypeError);
  assert.throws(() => createCollisionWorld(), TypeError);
});
