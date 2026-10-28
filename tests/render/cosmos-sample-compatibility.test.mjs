import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sampleGalaxy} from '../../src/render/cosmos.js';

// Frozen before hoisting descriptor rotation/color and writing directly into
// the output buffers. Protect legacy RNG, sRGB conversion and Float32 rounding.
test('legacy sample buffers retain exact bytes across morphology, revision and luminous structure kind', () => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  const hashes = {positions: [], colors: [], sizes: []};
  for (const revision of [2, 3]) for (const morphology of ['spiral', 'elliptical', 'irregular'])
    for (const kind of ['galaxy', 'cluster', 'nebula']) {
      const descriptor = {revision, morphology, kind, family: kind === 'cluster' ? 'open' : 'fixture',
        seed: `cold-sampler-${revision}-${morphology}-${kind}`, orientation: [.81, 1.21, -.37],
        radius: 710000, thickness: .07, arms: 3, pitch: .29, bar: true, asymmetry: .63};
      const sample = sampleGalaxy(descriptor, 4096);
      for (const key of Object.keys(hashes)) hashes[key].push(sha(Buffer.from(sample[key].buffer)));
    }
  assert.deepEqual(Object.fromEntries(Object.entries(hashes).map(([key, values]) => [key, sha(values.join(''))])), {
    positions: 'b06ba52f17d9ab7105229fd874a630f40beef283c88b794710e17db37c5f994c',
    colors: 'f71a3384715a9403e6888e4e9957dbd09de5ffe8cff42d728676f1d3a194994e',
    sizes: 'd0cdc890a2c4183d5f674b3aa20f6826581cf6676d82eb29b1b390317a2aac18',
  });
});
