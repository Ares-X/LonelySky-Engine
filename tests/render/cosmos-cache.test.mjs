import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCell } from '../../src/coordinates.js';
import { describeCosmicStructures, COSMIC_GRID_CELLS } from '../../src/cosmic-structures.js';
import { createCosmos, describeMacro, loadedMacros, sampleGalaxy, galaxyRelativeCenter, COSMOS_QUALITY_COUNTS } from '../../src/render/cosmos.js';

const origin = { x: 0, y: 0, z: 0 }, seed = 'cosmos-cache-fixture';
const v3 = { seed, descriptorProvider: describeCosmicStructures, gridCells: COSMIC_GRID_CELLS, structures: true };
const frame = (cell, quality = 'high') => ({ sectorIndex: encodeCell(cell), cameraPosition: [0, 0, 0], quality });
const arrays = cosmos => {
  const a = cosmos.children[0].geometry.attributes;
  return { position: a.position.array.slice(), color: a.color.array.slice(), pointRadius: a.pointRadius.array.slice() };
};
function matchesSamples(cosmos, options, cell, quality) {
  const count = COSMOS_QUALITY_COUNTS[quality], catalogue = loadedMacros(encodeCell(cell), options.seed, options);
  const attributes = cosmos.children[0].geometry.attributes;
  assert.equal(attributes.position.count, catalogue.length * count);
  for (let j = 0; j < catalogue.length; j++) {
    const d = catalogue[j], sample = sampleGalaxy(d, count), center = galaxyRelativeCenter(d, cell, options.gridCells);
    assert.deepEqual(attributes.position.array.slice(j * count * 3, (j + 1) * count * 3), Float32Array.from(sample.positions, (n, i) => n + center[i % 3]));
    assert.deepEqual(attributes.color.array.slice(j * count * 3, (j + 1) * count * 3), sample.colors);
    assert.deepEqual(attributes.pointRadius.array.slice(j * count, (j + 1) * count), sample.sizes);
  }
  return catalogue;
}

test('default catalogue revisits reuse exact samples without changing image attributes or rebase storage', () => {
  const options = { seed }, cosmos = createCosmos(options), away = { x: 96, y: 0, z: 0 };
  try {
    cosmos.userData.update(frame(origin));
    const original = arrays(cosmos), count = loadedMacros(encodeCell(origin), seed).length;
    assert.ok(count > 0);
    const attribute = cosmos.children[0].geometry.attributes.position;
    cosmos.userData.update(frame({ ...origin, x: 1 }));
    assert.equal(cosmos.children[0].geometry.attributes.position, attribute);
    cosmos.userData.update(frame(away));
    const before = cosmos.userData.stats;
    cosmos.userData.update(frame(origin));
    const after = cosmos.userData.stats;
    assert.equal(after.sampleGenerations, before.sampleGenerations);
    assert.equal(after.sampleCacheHits - before.sampleCacheHits, count);
    assert.deepEqual(arrays(cosmos), original);
    matchesSamples(cosmos, options, origin, 'high');
  } finally { cosmos.userData.dispose(); }
});

test('raw V3 provider and exact quality counts preserve byte-for-byte output across two places and tiers', () => {
  const cosmos = createCosmos(v3), away = { x: 8192, y: 0, z: 0 };
  try {
    cosmos.userData.update(frame(origin, 'auto'));
    const original = arrays(cosmos), count = loadedMacros(encodeCell(origin), seed, v3).length;
    cosmos.userData.update(frame(away, 'auto'));
    const before = cosmos.userData.stats;
    cosmos.userData.update(frame(origin, 'auto'));
    assert.equal(cosmos.userData.stats.sampleGenerations, before.sampleGenerations);
    assert.equal(cosmos.userData.stats.sampleCacheHits - before.sampleCacheHits, count);
    assert.deepEqual(arrays(cosmos), original);
    for (const quality of ['high', 'low']) {
      const prior = cosmos.userData.stats.sampleGenerations;
      cosmos.userData.update(frame(origin, quality));
      assert.equal(cosmos.userData.stats.sampleGenerations - prior, count, 'a missing exact tier is generated at the requested count');
      matchesSamples(cosmos, v3, origin, quality);
    }
    const generated = cosmos.userData.stats.sampleGenerations;
    cosmos.userData.update(frame(origin, 'auto'));
    assert.equal(cosmos.userData.stats.sampleGenerations, generated);
    assert.deepEqual(arrays(cosmos), original);
    matchesSamples(cosmos, v3, origin, 'auto');
  } finally { cosmos.userData.dispose(); }
});

test('instance seeds and public mutable sample snapshots cannot corrupt a renderer cache', () => {
  const first = createCosmos({ seed }), second = createCosmos({ seed: seed + '-other' }), away = { x: 96, y: 0, z: 0 };
  try {
    first.userData.update(frame(origin, 'low')); second.userData.update(frame(origin, 'low'));
    const original = arrays(first), other = arrays(second), d = loadedMacros(encodeCell(origin), seed)[0];
    const a = sampleGalaxy(d, COSMOS_QUALITY_COUNTS.low), b = sampleGalaxy(d, COSMOS_QUALITY_COUNTS.low);
    for (const key of ['positions', 'colors', 'sizes']) {
      assert.notEqual(a[key], b[key]); assert.deepEqual(a[key], b[key]); a[key].fill(-123);
    }
    // The public scene's combined attributes are not the retained templates.
    for (const attribute of Object.values(first.children[0].geometry.attributes)) attribute.array.fill(-456);
    first.userData.update(frame(away, 'low')); first.userData.update(frame(origin, 'low'));
    assert.deepEqual(arrays(first), original);
    assert.deepEqual(arrays(second), other);
    assert.notDeepEqual(original.position, other.position);
    first.userData.dispose();
    assert.equal(first.userData.stats.sampleCacheBytes, 0); assert.equal(first.userData.stats.sampleCacheEntries, 0);
    assert.ok(second.userData.stats.sampleCacheBytes > 0);
  } finally { first.userData.dispose(); second.userData.dispose(); }
});

test('custom and wrapped providers stay uncached when the same ID changes shape', () => {
  let radius = 100;
  const custom = coordinate => coordinate.x || coordinate.y || coordinate.z ? null : {
    id: 'mutable-shape', seed: 'custom-shape', revision: 1, macroCell: origin, offset: [0, 0, 0], orientation: [0, 0, 0],
    morphology: 'elliptical', radius, thickness: .6, arms: 2, pitch: .3, bar: false, asymmetry: .2,
  };
  const customOptions = { seed, descriptorProvider: custom }, cosmos = createCosmos(customOptions);
  const wrappedOptions = { seed, descriptorProvider: (...args) => describeMacro(...args) }, wrapped = createCosmos(wrappedOptions);
  try {
    cosmos.userData.update(frame(origin, 'low')); const original = arrays(cosmos);
    radius = 700; cosmos.userData.update(frame({ x: 16, y: 0, z: 0 }, 'low'));
    matchesSamples(cosmos, customOptions, { x: 16, y: 0, z: 0 }, 'low');
    cosmos.userData.update(frame(origin, 'low'));
    assert.notDeepEqual(arrays(cosmos), original);
    matchesSamples(cosmos, customOptions, origin, 'low');
    for (const cell of [origin, { x: 96, y: 0, z: 0 }, origin]) wrapped.userData.update(frame(cell, 'low'));
    for (const object of [cosmos, wrapped]) {
      assert.equal(object.userData.stats.sampleCacheLimit, 0);
      assert.equal(object.userData.stats.sampleCacheEntries, 0);
      assert.equal(object.userData.stats.sampleCacheHits, 0);
      assert.equal(object.userData.stats.sampleCacheBytes, 0);
      assert.ok(object.userData.stats.sampleGenerations > 0);
    }
  } finally { cosmos.userData.dispose(); wrapped.userData.dispose(); }
});

test('byte-budget eviction preserves every surviving hit needed later in the same batch', () => {
  const a = { x: -16384, y: 0, z: 0 }, b = { x: -16384, y: -12288, z: -8192 }, cosmos = createCosmos(v3);
  const A = loadedMacros(encodeCell(a), seed, v3), B = loadedMacros(encodeCell(b), seed, v3);
  const overlap = A.filter(d => B.some(other => other.id === d.id)).length;
  try {
    cosmos.userData.update(frame(a)); cosmos.userData.update(frame(b));
    const before = cosmos.userData.stats;
    const bytesPerEntry = COSMOS_QUALITY_COUNTS.high * 7 * Float32Array.BYTES_PER_ELEMENT;
    assert.ok(before.sampleCacheEntries < new Set([...A, ...B].map(d => d.id)).size, 'fixture exceeds the cache budget');
    assert.equal(before.sampleCacheBytes, before.sampleCacheEntries * bytesPerEntry);
    assert.ok(before.sampleCacheBytes <= before.sampleCacheLimit);
    // All B keys are present; the other retained keys came only from A. Every
    // one of these available hits must survive the incoming batch's misses.
    const availableHits = before.sampleCacheEntries - B.length + overlap;
    cosmos.userData.update(frame(a)); const after = cosmos.userData.stats;
    assert.equal(after.sampleCacheHits - before.sampleCacheHits, availableHits);
    assert.equal(after.sampleGenerations - before.sampleGenerations, A.length - availableHits);
    assert.ok(after.sampleCacheBytes <= after.sampleCacheLimit);
    matchesSamples(cosmos, v3, a, 'high');
    cosmos.userData.dispose(); cosmos.userData.dispose();
    const disposed = cosmos.userData.stats;
    assert.equal(disposed.sampleCacheBytes, 0); assert.equal(disposed.sampleCacheEntries, 0);
    cosmos.userData.update(frame(b)); assert.deepEqual(cosmos.userData.stats, disposed);
  } finally { cosmos.userData.dispose(); }
});

test('a catalogue batch larger than the byte budget renders uncached without partial-LRU churn', () => {
  const options = { ...v3, seed: 'cache-byte-fixture-5' }, cell = { x: -4096, y: -12288, z: 12288 }, cosmos = createCosmos(options);
  const count = loadedMacros(encodeCell(cell), options.seed, options).length;
  try {
    cosmos.userData.update(frame(cell, 'auto')); const before = cosmos.userData.stats, original = arrays(cosmos);
    assert.ok(count * COSMOS_QUALITY_COUNTS.high * 7 * 4 > before.sampleCacheLimit);
    cosmos.userData.update(frame(cell, 'high')); const after = cosmos.userData.stats;
    assert.equal(after.sampleGenerations - before.sampleGenerations, count);
    assert.equal(after.sampleCacheEntries, before.sampleCacheEntries);
    assert.equal(after.sampleCacheBytes, before.sampleCacheBytes);
    assert.equal(after.sampleCacheHits, before.sampleCacheHits);
    matchesSamples(cosmos, options, cell, 'high');
    cosmos.userData.update(frame(cell, 'auto'));
    assert.equal(cosmos.userData.stats.sampleGenerations, after.sampleGenerations);
    assert.equal(cosmos.userData.stats.sampleCacheHits - after.sampleCacheHits, count);
    assert.deepEqual(arrays(cosmos), original);
  } finally { cosmos.userData.dispose(); }
});
