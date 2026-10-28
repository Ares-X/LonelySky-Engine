import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCell, CELL_SIZE } from '../src/coordinates.js';
import { describeCosmicBody, cosmicBodyCenter, cosmicSolidsInBounds } from '../src/cosmic-bodies.js';
import { cosmicSystemBodiesInBounds, cosmicGravitySourcesInBounds, cosmicSystemOccupancyInBounds } from '../src/cosmic-systems.js';

const seed = 'body-fixture';
const queries = [cosmicSolidsInBounds, cosmicSystemBodiesInBounds, cosmicGravitySourcesInBounds, cosmicSystemOccupancyInBounds];

test('reusing caller bounds across sectors preserves retained query results and fresh positions', () => {
  const body = describeCosmicBody({ x: -32, y: -32, z: -16 }, seed);
  const firstSector = encodeCell({ x: -16384, y: -16384, z: -8192 });
  const nextSector = encodeCell({ x: 16383, y: -16384, z: -8192 });
  const center = cosmicBodyCenter(body, firstSector), range = body.boundsRadius + 10;
  const bounds = { min: center.map(n => n - range), max: center.map(n => n + range) };
  const options = { sectorIndex: firstSector, bounds, seed };
  const first = cosmicSolidsInBounds(options), snapshot = structuredClone(first);
  assert.ok(first.some(value => value.id === body.id));
  const second = cosmicSolidsInBounds(options);
  assert.deepEqual(second, first); assert.notEqual(second, first);
  for (let i = 0; i < first.length; i++) {
    assert.notEqual(second[i], first[i]); assert.notEqual(second[i].position, first[i].position);
  }
  options.sectorIndex = nextSector;
  bounds.min[0] += CELL_SIZE; bounds.max[0] += CELL_SIZE;
  const relocated = cosmicSolidsInBounds(options);
  const shifted = relocated.find(value => value.id === body.id);
  assert.deepEqual(shifted.position, cosmicBodyCenter(body, nextSector));
  assert.equal(shifted.position[0] - first.find(value => value.id === body.id).position[0], CELL_SIZE);
  assert.deepEqual(first, snapshot);
  shifted.position.fill(123); shifted.radius = 1;
  const repeat = cosmicSolidsInBounds(options).find(value => value.id === body.id);
  assert.deepEqual(repeat.position, cosmicBodyCenter(body, nextSector));
  assert.equal(repeat.radius, body.radius);
});

test('query validation preserves sparse arrays, error order and invalid-address failures', () => {
  const sparse = { min: [, 0, 0], max: [0, 0, 0] };
  for (const query of queries) {
    assert.deepEqual(query({ sectorIndex: 0, bounds: sparse, seed }), []);
    assert.throws(() => query({ sectorIndex: -1, bounds: { min: [NaN, 0, 0], max: [0, 0, 0] } }), TypeError);
    assert.throws(() => query({ sectorIndex: 0, bounds: { min: [1, 0, 0], max: [0, 0, 0] } }), RangeError);
    assert.throws(() => query({ sectorIndex: 0, bounds: { min: [-1e308, 0, 0], max: [1e308, 0, 0] } }), /one world period/);
    assert.throws(() => query({ sectorIndex: 0, bounds: { min: [1e308, 1e308, 1e308], max: [1e308, 1e308, 1e308] } }), /Invalid cosmic body address/);
  }
  // Public validation must reject the seed before reading an invalid address.
  const unreadable = new Proxy({}, { get() { throw new Error('address read'); } });
  assert.throws(() => describeCosmicBody(unreadable, 42), /Invalid cosmic body address/);
});

test('descriptor cache keeps wrapped identity and the existing 4096-entry eviction bound', () => {
  const coordinate = { x: -32, y: -32, z: -16 }, body = describeCosmicBody(coordinate, seed);
  assert.ok(body && Object.isFrozen(body));
  coordinate.x += 64; coordinate.y -= 64; coordinate.z += 128;
  assert.equal(describeCosmicBody(coordinate, seed), body);
  for (let i = 0; i < 4096; i++) {
    describeCosmicBody({ x: i % 64, y: Math.floor(i / 64), z: 0 }, 'query-reuse-eviction');
  }
  const regenerated = describeCosmicBody(coordinate, seed);
  assert.notEqual(regenerated, body); assert.deepEqual(regenerated, body);
  assert.ok(Object.isFrozen(regenerated));
});
