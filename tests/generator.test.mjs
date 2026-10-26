import test from 'node:test';
import assert from 'node:assert/strict';
import { createUniverse, sectorBodies, GENERATOR_VERSION } from '../src/generator.js';
import { CELL_SIZE, MAX_SECTOR } from '../src/coordinates.js';
import { bodyCollisionRadius, createCollisionWorld } from '../src/collision.js';
import { createGravityField } from '../src/gravity.js';

const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));

test('sector streams are deterministic, order independent and seed dependent', () => {
  const a = createUniverse({ seed: 'sample' }), b = createUniverse({ seed: 'sample' });
  const indices = [0, 1, 2, 105, MAX_SECTOR];
  const expected = indices.map(i => a.getSector(i));
  for (const i of [...indices].reverse()) assert.deepEqual(b.getSector(i), expected[indices.indexOf(i)]);
  assert.notDeepEqual(a.getSector(0), createUniverse({ seed: 'other' }).getSector(0));
  assert.equal(a.getSector(0).generatorVersion, GENERATOR_VERSION);
});

test('descriptors and sphere projections are isolated JSON data; rules stay fixed', () => {
  const palette = { colorA: 0, colorB: 0xffffff, starColor: 0xabcdef };
  const universe = createUniverse({ palette });
  const first = universe.getSector(0), expected = structuredClone(first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  first.planets[0].position[0] = 999;
  first.cell.x = 34;
  first.nebula.colorA = 17;
  palette.colorA = 8;
  assert.deepEqual(universe.getSector(0), expected);
  const bodies = sectorBodies(expected);
  bodies[0].position[0] = 56;
  assert.notEqual(expected.planets[0].position[0], 56);
  assert.equal(bodies[0].id, expected.planets[0].id);
  assert.equal(bodies[0].collisionClearance, expected.planets[0].radius * 2.26);
  assert.equal(universe.seed, 'lonelysky');
  assert.equal(universe.density, .65);
  assert.equal(universe.revision, 0);
  assert.throws(() => { universe.seed = 'changed'; }, TypeError);
  assert.throws(() => { universe.density = 0; }, TypeError);
  assert.equal(createUniverse({ density: .3 }).density, .3);
});

test('density zero includes an empty sector zero; positive density has a lit front-facing ringed planet', () => {
  const empty = createUniverse({ density: 0 });
  for (const i of [0, 3, 101, MAX_SECTOR]) {
    const data = empty.getSector(i);
    assert.deepEqual(empty.sector(i), []);
    assert.equal(data.nebula.density, 0);
    assert.equal(data.composition, 'empty');
  }
  for (const density of [.00001, .65, 1]) {
    const data = createUniverse({ density }).getSector(0);
    assert.equal(data.planets.length, 1);
    assert.equal(data.planets[0].rings, true);
    assert.ok(data.planets[0].position[2] < 0);
    assert.equal(data.stars.length, 1);
    assert.equal(data.stars[0].type, 'star');
  }
  const sparse = createUniverse({ density: .1 }), dense = createUniverse({ density: 1 });
  const count = universe => Array.from({ length: 300 }, (_, i) => universe.sector(i + 1).length).reduce((a, b) => a + b, 0);
  assert.ok(count(dense) > count(sparse) * 3);
});

test('public configuration and index boundaries reject invalid values', () => {
  for (const options of [null, [], true, 4, 'seed']) assert.throws(() => createUniverse(options), TypeError);
  for (const seed of [null, 9, {}, []]) assert.throws(() => createUniverse({ seed }), TypeError);
  for (const density of [-.1, 1.01, NaN, Infinity, '0.5', null]) assert.throws(() => createUniverse({ density }), RangeError);
  for (const palette of [null, [], {}, { colorA: -1, colorB: 0, starColor: 0 },
    { colorA: 0, colorB: 0x1000000, starColor: 0 }, { colorA: 0, colorB: 0, starColor: .5 }]) {
    assert.throws(() => createUniverse({ palette }), TypeError);
  }
  const world = createUniverse();
  for (const index of [-1, .5, MAX_SECTOR + 1, NaN, Infinity, null, '0', 0n]) {
    assert.throws(() => world.getSector(index), RangeError);
    assert.throws(() => world.sector(index), RangeError);
  }
});

test('generated envelopes are bounded, separated and leave arrival space clear', () => {
  const compositions = new Set(), kinds = new Set(), morphologies = new Set();
  for (const seed of ['sample', 'alternate', '']) {
    const universe = createUniverse({ seed, density: 1 });
    for (let i = 0; i < 400; i += 1) {
      const descriptor = universe.getSector(i), bodies = universe.sector(i);
      compositions.add(descriptor.composition);
      morphologies.add(descriptor.region.morphology);
      for (const body of descriptor.planets) {
        kinds.add(body.kind);
        assert.equal(body.proceduralSurface, true);
        assert.ok(Number.isInteger(body.seed) && body.seed >= 0 && body.seed <= 0xffffffff);
      }
      for (const [j, body] of bodies.entries()) {
        const clearance = bodyCollisionRadius(body, body.type);
        assert.ok(clearance < CELL_SIZE / 2);
        assert.ok(body.position.every(n => Math.abs(n) + clearance < CELL_SIZE / 2));
        assert.ok(distance(body.position, [0, 0, 0]) > clearance + 1600);
        for (const other of bodies.slice(j + 1)) {
          assert.ok(distance(body.position, other.position) > clearance + bodyCollisionRadius(other, other.type));
        }
      }
    }
  }
  for (const kind of ['gas', 'ocean', 'ice', 'rock', 'lava']) assert.ok(kinds.has(kind));
  for (const kind of ['rings', 'planets', 'star', 'binary', 'nebula', 'black-hole']) assert.ok(compositions.has(kind));
  assert.deepEqual([...morphologies].sort(), ['columns', 'halo', 'knots', 'rift', 'shell', 'stream', 'wisps'].sort());
});

test('universe plugs directly into gravity and swept collision factories', () => {
  const world = createUniverse(), gravity = createGravityField({ world }), collisions = createCollisionWorld({ world });
  const sample = gravity.sample(0, [0, 0, 0]);
  assert.ok(sample.acceleration.every(Number.isFinite));
  assert.ok(sample.magnitude > 0);
  assert.equal(collisions.ensureSafe(0, [0, 0, 0], [0, 0, 0]).corrected, false);
  const planet = world.sector(0)[0];
  const move = collisions.move(0, [0, 0, 0], planet.position, planet.position);
  assert.equal(move.corrected, true);
  assert.equal(move.contact.id, planet.id);
  assert.ok(distance(move.position, planet.position) >= bodyCollisionRadius(planet) - 1e-6);
});
