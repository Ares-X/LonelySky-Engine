import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCell } from '../../src/coordinates.js';
import { createCosmos, loadedMacros, sampleGalaxy, galaxyRelativeCenter, COSMOS_QUALITY_COUNTS } from '../../src/render/cosmos.js';

test('cell rebases retain GPU storage and the exact catalogue population', () => {
  const seed = 'stream-fixture', cosmos = createCosmos({ seed }), geometry = cosmos.children[0].geometry;
  const update = (cell, quality = 'high') => cosmos.userData.update({ sectorIndex: encodeCell(cell), cameraPosition: [0, 0, 0], quality });
  let releases = 0;
  geometry.addEventListener('dispose', () => releases++);
  try {
    const origin = { x: 0, y: 0, z: 0 };
    update(origin);
    const attributes = { ...geometry.attributes }, beforeRebase = releases;
    update({ ...origin, x: 1 });
    assert.equal(releases, beforeRebase, 'changing the floating origin must not delete retained GPU buffers');
    for (const name of ['position', 'color', 'pointRadius']) assert.equal(geometry.attributes[name], attributes[name]);

    for (const cell of [origin, { x: 15, y: 0, z: 0 }, { x: 16, y: 0, z: 0 },
      { x: -16384, y: 16383, z: 0 }, { x: 16383, y: 16383, z: 0 }, origin]) {
      for (const quality of ['high', 'low', 'auto', 'high']) {
        update(cell, quality);
        const descriptors = loadedMacros(encodeCell(cell), seed), count = COSMOS_QUALITY_COUNTS[quality];
        assert.equal(geometry.attributes.position.count, descriptors.length * count);
        descriptors.forEach((descriptor, j) => {
          const sample = sampleGalaxy(descriptor, count), center = galaxyRelativeCenter(descriptor, cell);
          const expected = Float32Array.from(sample.positions, (value, i) => value + center[i % 3]);
          assert.deepEqual(geometry.attributes.position.array.slice(j * count * 3, (j + 1) * count * 3), expected);
          assert.deepEqual(geometry.attributes.color.array.slice(j * count * 3, (j + 1) * count * 3), sample.colors);
          assert.deepEqual(geometry.attributes.pointRadius.array.slice(j * count, (j + 1) * count), sample.sizes);
        });
      }
    }
  } finally { cosmos.userData.dispose(); }
});
