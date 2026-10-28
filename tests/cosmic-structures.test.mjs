import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL_SIZE, encodeCell, wrapCell } from '../src/coordinates.js';
import { COSMIC_GRID_CELLS, COSMIC_GRID_SIZE, COSMIC_VIEW_FAR, COSMIC_MAX_RADIUS, COSMIC_MAX_STRUCTURES,
  describeCosmicStructures, loadedCosmicStructures, cosmicStructureRelativeCenter,
  cosmicStructureContext, wrapCosmicDistance, cosmicDrawDistance, cosmicTrueDistance } from '../src/cosmic-structures.js';

const axes = ['x', 'y', 'z'];
const seed = 'structure-fixture';
const catalogue = [];
for (let x = -4; x < 4; x++) for (let y = -4; y < 4; y++) for (let z = -4; z < 4; z++) catalogue.push(...describeCosmicStructures({ x, y, z }, seed));

test('relative centers can reuse caller storage without changing snapshot semantics',()=>{
  const descriptor=catalogue[0],cell={x:11,y:-9,z:7};
  const expected=cosmicStructureRelativeCenter(descriptor,cell),output=new Float64Array(3);
  assert.equal(cosmicStructureRelativeCenter(descriptor,cell,output),output);
  assert.deepEqual([...output],expected);
  output[0]=0;
  assert.deepEqual(cosmicStructureRelativeCenter(descriptor,cell),expected);
  assert.notEqual(cosmicStructureRelativeCenter(descriptor,cell),expected);
});

test('V3 sparse parents own larger scales and fully nested three-dimensional children', () => {
  const parents = catalogue.filter(d => d.kind === 'galaxy');
  assert.ok(parents.length >= 16 && parents.length < 64);
  assert.equal(new Set(parents.map(d => d.theme)).size, 5);
  for (const parent of parents) {
    assert.ok(parent.radius * 2 >= 40000000 && parent.radius * 2 <= 84000000);
    const children = catalogue.filter(d => d.parentId === parent.id);
    assert.equal(children.length, 3);
    assert.ok(Object.isFrozen(parent) && Object.isFrozen(parent.offset));
    for (const child of children) {
      assert.equal(child.theme, parent.theme);
      const offset = child.offset.map((n, i) => n - parent.offset[i]);
      assert.ok(Math.hypot(...offset) + child.radius <= parent.radius);
      assert.ok(Math.abs(offset[1]) > 1000, 'rotated child centres have genuine 3D depth');
      const minimum = child.kind === 'cluster' ? 6000000 : 10000000;
      assert.ok(child.radius * 2 >= minimum && child.radius * 2 <= 26000000);
      assert.ok(child.radius * 2 > 2400000 * 2, 'child scales are visibly larger than the largest ring');
    }
  }
});

test('catalogue is seed deterministic, toroidal, and independent of enumeration order', () => {
  for (let x = -4; x < 4; x++) for (let y = -4; y < 4; y++) for (let z = -4; z < 4; z++) {
    const coordinate = { x, y, z }, descriptors = describeCosmicStructures(coordinate, seed);
    assert.deepEqual(descriptors, describeCosmicStructures({ x: x + 8, y: y - 8, z: z + 16 }, seed));
    assert.deepEqual(descriptors, describeCosmicStructures(coordinate, seed));
  }
  assert.notDeepEqual(describeCosmicStructures({ x: 0, y: 0, z: 0 }, seed + '-other'), describeCosmicStructures({ x: 0, y: 0, z: 0 }, seed));
});

test('semantic context follows the same parent through cell rebases and the world seam', () => {
  for (const parent of catalogue.filter(d => d.kind === 'galaxy')) {
    const absolute = cosmicStructureRelativeCenter(parent, { x: 0, y: 0, z: 0 });
    const cell = Object.fromEntries(axes.map((axis, i) => [axis, wrapCell(Math.round(absolute[i] / CELL_SIZE))]));
    const center = cosmicStructureRelativeCenter(parent, cell);
    const context = cosmicStructureContext({ sectorIndex: encodeCell(cell), cameraPosition: center, seed });
    assert.deepEqual(context, { id: parent.id, family: parent.family, theme: parent.theme });
    for (const axis of axes) {
      const next = { ...cell, [axis]: wrapCell(cell[axis] + 1) };
      const after = cosmicStructureRelativeCenter(parent, next);
      const relativeCamera = center.map((n, i) => n - (axes[i] === axis ? CELL_SIZE : 0));
      assert.deepEqual(cosmicStructureContext({ sectorIndex: encodeCell(next), cameraPosition: relativeCamera, seed }), context);
      after.forEach((n, i) => assert.ok(Math.abs(n - relativeCamera[i]) < 1e-6));
    }
  }
});

test('150M horizon fits the omitted support bound without enlarging the catalogue', () => {
  const minimumOmittedSupport = (2.5 - .06) * COSMIC_GRID_SIZE - COSMIC_MAX_RADIUS - CELL_SIZE / 2;
  assert.equal(minimumOmittedSupport, 157874800);
  assert.ok(COSMIC_VIEW_FAR < minimumOmittedSupport);
  // Rotation preserves length. For q = childRadius / parentRadius in [3/42,
  // 13/20], the orbit cap r - 1.05c and vertical extent .04r remain nested:
  // hypot(1 - 1.05q, .04) + q <= 1. The squared margin is concave in q,
  // so its minimum on this interval lies at an endpoint.
  for (const q of [3000000 / COSMIC_MAX_RADIUS, 13000000 / 20000000]) {
    assert.ok(.1 * q - .1025 * q * q >= .04 ** 2);
  }
});

test('every torus macro corner retains all visible catalogue supports', () => {
  for (let x = -4; x < 4; x++) for (let y = -4; y < 4; y++) for (let z = -4; z < 4; z++) {
    const cell = { x: x * COSMIC_GRID_CELLS, y: y * COSMIC_GRID_CELLS, z: z * COSMIC_GRID_CELLS };
    const loaded = new Set(loadedCosmicStructures(encodeCell(cell), seed).map(d => d.id));
    for (const dx of [-.5, COSMIC_GRID_CELLS - .5]) for (const dy of [-.5, COSMIC_GRID_CELLS - .5]) for (const dz of [-.5, COSMIC_GRID_CELLS - .5]) {
      const camera = [dx, dy, dz].map(n => n * CELL_SIZE);
      for (const descriptor of catalogue) {
        if (loaded.has(descriptor.id)) continue;
        const center = cosmicStructureRelativeCenter(descriptor, cell);
        // Wrap camera-relative distance too: opposite corners can cross the torus.
        const distance = Math.hypot(...center.map((n, i) => wrapCosmicDistance(n - camera[i]))) - descriptor.radius;
        assert.ok(distance > COSMIC_VIEW_FAR, `${descriptor.id} is unloaded inside the horizon`);
      }
    }
  }
});

test('fixed streaming neighborhood remains bounded and changes beyond the visibility support', () => {
  let changes = 0;
  for (const axis of axes) for (const boundary of [-16384, -8192, -4096, 0, 4096, 8192, 16384]) {
    const before = { x: 37, y: -31, z: 10, [axis]: wrapCell(boundary - 1) }, after = { ...before, [axis]: wrapCell(boundary) };
    const a = new Map(loadedCosmicStructures(encodeCell(before), seed).map(d => [d.id, d]));
    const b = new Map(loadedCosmicStructures(encodeCell(after), seed).map(d => [d.id, d]));
    assert.ok(a.size <= COSMIC_MAX_STRUCTURES && b.size <= COSMIC_MAX_STRUCTURES);
    for (const [id, descriptor] of [...a, ...b]) {
      if (a.has(id) && b.has(id)) continue;
      changes++;
      const cell = a.has(id) ? before : after;
      const center = cosmicStructureRelativeCenter(descriptor, cell);
      const camera = axes.map(name => name === axis ? (a.has(id) ? 1 : -1) * CELL_SIZE / 2 : 0);
      assert.ok(Math.hypot(...center.map((n, i) => n - camera[i])) - descriptor.radius > COSMIC_VIEW_FAR);
    }
  }
  assert.ok(changes > 20);
  assert.equal(COSMIC_GRID_SIZE, COSMIC_GRID_CELLS * CELL_SIZE);
});

test('drawing compression preserves local depth, ordering and invertible million-unit distances', () => {
  let previous = -1;
  for (const distance of [0, 10, 100000, 159999, 160000, 160001, 200000, 1000000, 20000000, 50000000, 100000000, 300000000]) {
    const drawn = cosmicDrawDistance(distance);
    assert.ok(drawn > previous && drawn < 200000);
    previous = drawn;
    assert.ok(Math.abs(cosmicTrueDistance(drawn) - distance) < Math.max(1e-5, distance * 1e-10));
    if (distance <= 160000) assert.equal(drawn, distance);
  }
});
