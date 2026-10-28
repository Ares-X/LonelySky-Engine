import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL_SIZE, decodeCell, encodeCell } from '../../src/coordinates.js';
import { describeCosmicStructures, loadedCosmicStructures, cosmicStructureRelativeCenter, COSMIC_GRID_CELLS } from '../../src/cosmic-structures.js';
import { createCosmos, sampleGalaxy, COSMOS_QUALITY_COUNTS } from '../../src/render/cosmos.js';
import { createGalaxyHaze } from '../../src/render/galaxy-haze.js';

const seed = 'support-visibility-fixture', origin = { x: 0, y: 0, z: 0 };
const options = { seed, structures: true, descriptorProvider: describeCosmicStructures, gridCells: COSMIC_GRID_CELLS };
const parent = loadedCosmicStructures(encodeCell(origin), seed).find(d => d.kind === 'galaxy');
assert.ok(parent, 'the public fixture has a parent');
const center = cosmicStructureRelativeCenter(parent, origin);
const frame = (cell, cameraPosition = [0, 0, 0], quality = 'low') => ({ sectorIndex: encodeCell(cell), cameraPosition, quality, viewportHeight: 800, pixelRatio: 1 });
function physicalFrame(position) {
  const cell = {}, local = [];
  for (let i = 0; i < 3; i++) {
    const shift = Math.floor((position[i] + CELL_SIZE / 2) / CELL_SIZE);
    cell[['x', 'y', 'z'][i]] = ((shift + 16384) % 32768 + 32768) % 32768 - 16384;
    local[i] = position[i] - shift * CELL_SIZE;
  }
  return frame(cell, local);
}
const atSurface = distance => physicalFrame([center[0] + parent.radius + distance, center[1], center[2]]);
const parts = cosmos => ({ points: cosmos.children[0], haze: cosmos.children[1] });
function weights(cosmos) {
  const { points, haze } = parts(cosmos), table = points.material.uniforms.structureWeights.value;
  const result = new Map();
  for (const [i, mesh] of haze.children.entries()) {
    assert.equal(mesh.material.uniforms.structureVisibility.value, table[i], 'haze consumes the same Float32 weight as points');
    assert.equal(mesh.material.uniforms.uVisibility.value, Number(mesh.visible), 'the depth-pass sentinel remains boolean even for tiny optical weights');
    result.set(mesh.name, table[i]);
  }
  return result;
}
function indices(cosmos, quality) {
  const { points, haze } = parts(cosmos), attribute = points.geometry.attributes.descriptorIndex;
  const count = COSMOS_QUALITY_COUNTS[quality];
  assert.equal(attribute.count, haze.children.length * count);
  for (let i = 0; i < attribute.count; i++) assert.equal(attribute.array[i], Math.floor(i / count));
  return attribute;
}

test('canonical support fading retains a far centre and shares 80/90/100M and inside weights', () => {
  const cosmos = createCosmos(options);
  try {
    for (const [surface, expected] of [[70000000, 1], [80000000, 1], [90000000, .5], [100000000, 0], [-parent.radius / 2, 1]]) {
      const f = atSurface(surface);
      cosmos.userData.update(f);
      const actual = weights(cosmos).get(parent.id);
      // At the zero-weight boundary the streaming catalogue may already omit it.
      assert.equal(actual ?? 0, expected);
      if (surface === 70000000) {
        const relative = cosmicStructureRelativeCenter(parent, decodeCell(f.sectorIndex));
        assert.ok(Math.hypot(...relative.map((v, i) => v - f.cameraPosition[i])) > 100000000, 'the core is beyond the old sample cutoff');
      }
    }
  } finally { cosmos.userData.dispose(); }
});

test('child supports have independent optical weights and a tiny weight keeps the JS depth sentinel', () => {
  const cosmos = createCosmos(options);
  try {
    cosmos.userData.update(atSurface(99000000));
    const byId = weights(cosmos), parentWeight = byId.get(parent.id);
    assert.ok(parentWeight > 0 && parentWeight < 1);
    const children = parts(cosmos).haze.children.filter(m => m.name.startsWith(parent.id + ':'));
    assert.ok(children.length > 0);
    assert.ok(children.some(m => m.material.uniforms.structureVisibility.value !== parentWeight), 'children do not borrow the parent fade');
    cosmos.userData.update(atSurface(99900000));
    weights(cosmos);
    const mesh = parts(cosmos).haze.children.find(m => m.name === parent.id);
    assert.ok(mesh.material.uniforms.structureVisibility.value > 0 && mesh.material.uniforms.structureVisibility.value < .001);
    assert.equal(mesh.visible, true);
    assert.equal(mesh.material.uniforms.uVisibility.value, 1);
    cosmos.userData.update({ ...atSurface(99900000), home: true });
    assert.equal(mesh.visible, false);
    assert.equal(mesh.material.uniforms.uVisibility.value, 0);
  } finally { cosmos.userData.dispose(); }
});

test('quality changes rebuild descriptor index ranges while camera moves reuse the shared table', () => {
  const cosmos = createCosmos(options), f = atSurface(90000000);
  try {
    let table;
    for (const quality of ['low', 'auto', 'high', 'auto']) {
      cosmos.userData.update({ ...f, quality });
      indices(cosmos, quality); weights(cosmos);
      const next = parts(cosmos).points.material.uniforms.structureWeights.value;
      if (table) assert.equal(next, table);
      table = next;
    }
    const attribute = indices(cosmos, 'auto'), moved = [...f.cameraPosition]; moved[0] += 10;
    const before = weights(cosmos).get(parent.id);
    cosmos.userData.update({ ...f, cameraPosition: moved, quality: 'auto' });
    assert.equal(indices(cosmos, 'auto'), attribute);
    assert.notEqual(weights(cosmos).get(parent.id), before, 'same-cell motion refreshes optical weights');
  } finally { cosmos.userData.dispose(); }
});

test('cell, macro and torus rebases preserve physical weights and valid descriptor indices', () => {
  const cosmos = createCosmos(options);
  try {
    for (const boundary of [1, 4096, 16384]) {
      const before = frame({ x: boundary - 1, y: 0, z: 0 }, [CELL_SIZE / 2, 0, 0]);
      const after = frame({ x: boundary === 16384 ? -16384 : boundary, y: 0, z: 0 }, [-CELL_SIZE / 2, 0, 0]);
      cosmos.userData.update(before); const a = weights(cosmos), attribute = indices(cosmos, 'low');
      cosmos.userData.update(after); const b = weights(cosmos), next = indices(cosmos, 'low');
      for (const id of new Set([...a.keys(), ...b.keys()])) assert.equal(a.get(id) ?? 0, b.get(id) ?? 0, 'rebase changes no physical visibility');
      if (boundary === 1) assert.equal(next, attribute, 'ordinary cell rebases retain index storage');
    }
  } finally { cosmos.userData.dispose(); }
});

test('wrapped, wrong-grid and legacy callers retain their unbounded per-sample path', () => {
  const wrapped = (...args) => describeCosmicStructures(...args);
  const instances = [createCosmos({ ...options, descriptorProvider: wrapped }), createCosmos({ ...options, gridCells: 16 }), createCosmos({ seed })];
  const direct = createGalaxyHaze({ seed, structures: true });
  try {
    for (const cosmos of instances) {
      cosmos.userData.update(frame(origin));
      const { points, haze } = parts(cosmos);
      assert.equal(points.geometry.attributes.descriptorIndex, undefined);
      assert.equal(points.material.uniforms.structureWeights, undefined);
      for (const mesh of haze.children) assert.equal(mesh.material.uniforms.structureVisibility, undefined);
    }
    direct.userData.setDescriptors([parent]);
    assert.equal(direct.children[0].material.uniforms.structureVisibility, undefined);
  } finally { for (const cosmos of instances) cosmos.userData.dispose(); direct.userData.dispose(); }
});

test('custom providers above 108 descriptors are not rejected, truncated or assigned canonical indices', () => {
  const descriptors = Array.from({ length: 109 }, (_, i) => ({ ...parent, id: 'custom-' + i, seed: 'custom-' + i, macroCell: { ...origin }, radius: 1000 }));
  const provider = cell => cell.x === 0 && cell.y === 0 && cell.z === 0 ? descriptors : [];
  const cosmos = createCosmos({ ...options, descriptorProvider: provider });
  try {
    cosmos.userData.update(frame(origin));
    const { points, haze } = parts(cosmos);
    assert.equal(haze.children.length, 109);
    assert.equal(points.geometry.attributes.pointRadius.count, 109 * COSMOS_QUALITY_COUNTS.low);
    assert.equal(points.geometry.attributes.descriptorIndex, undefined);
    assert.equal(points.material.uniforms.structureWeights, undefined);
    const sample = sampleGalaxy(descriptors[108], COSMOS_QUALITY_COUNTS.low);
    assert.deepEqual(points.geometry.attributes.pointRadius.array.slice(108 * COSMOS_QUALITY_COUNTS.low), sample.sizes);
  } finally { cosmos.userData.dispose(); }
});

test('dispose releases support visibility storage and ignores late updates without double disposal', () => {
  const cosmos = createCosmos(options);
  cosmos.userData.update(atSurface(90000000));
  const { points } = parts(cosmos); let releases = 0;
  points.geometry.addEventListener('dispose', () => releases++);
  cosmos.userData.dispose();
  assert.equal(releases, 1);
  assert.equal(points.material.uniforms.structureWeights.value, null);
  assert.equal(cosmos.children.length, 0);
  cosmos.userData.update(atSurface(80000000)); cosmos.userData.dispose();
  assert.equal(releases, 1);
  assert.equal(cosmos.userData.stats.visible, false);
});
