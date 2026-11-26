import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sampleGalaxy} from '../../src/render/cosmos.js';

// Frozen before hoisting descriptor rotation/color and writing directly into
// the output buffers. Protect legacy RNG, sRGB conversion and Float32 rounding.
test('legacy sample buffers retain exact bytes across morphology, revision and luminous structure kind', () => {
  const sha = value => createHash('sha256').update(value).digest('hex');
  const hashes = {positions: [], colors: [], sizes: []};
  // Only this V3 generated-open representation changed. Keep its original leaf
  // in the historical aggregate so the other 17 fixtures retain the old proof.
  const oldOpen={positions:'ac6140e16c7b32569ced4a3189b21eee4437d52a806bb59ac03fc2ab1f836275',colors:'3a84e25b2d5510effd276d177856b27a0263a080116d2fbf5eaa13fb1d9f5aff',sizes:'42986e3cf144568f5f0f953ef20c6c079bdaa642c6cf89653a7869dfbab1c1b8'};
  const newOpen={positions:'e46db401fa787a4dd892e2fe7835fde0b4b3ae0a912c9a7a50d677bcc57a17e8',colors:'3229f624f89944e0dbf08032df184e2d1abb0a0e02720410dc3c605e5097c9b3',sizes:'0380e9eca5e873c115a46a862824738b13ab7379a552e68fba2177b79273e57a'};
  for (const revision of [2, 3]) for (const morphology of ['spiral', 'elliptical', 'irregular'])
    for (const kind of ['galaxy', 'cluster', 'nebula']) {
      const descriptor = {revision, morphology, kind, family: kind === 'cluster' ? 'open' : 'fixture',
        seed: `cold-sampler-${revision}-${morphology}-${kind}`, orientation: [.81, 1.21, -.37],
        radius: 710000, thickness: .07, arms: 3, pitch: .29, bar: true, asymmetry: .63};
      const sample = sampleGalaxy(descriptor, 4096);
      const actual=Object.fromEntries(Object.keys(hashes).map(key=>[key,sha(Buffer.from(sample[key].buffer))]));
      const changed=revision===3&&morphology==='irregular'&&kind==='cluster';
      if(changed)assert.deepEqual(actual,newOpen);
      for(const key of Object.keys(hashes))hashes[key].push(changed?oldOpen[key]:actual[key]);
    }
  assert.deepEqual(Object.fromEntries(Object.entries(hashes).map(([key, values]) => [key, sha(values.join(''))])), {
    positions: 'b06ba52f17d9ab7105229fd874a630f40beef283c88b794710e17db37c5f994c',
    colors: 'f71a3384715a9403e6888e4e9957dbd09de5ffe8cff42d728676f1d3a194994e',
    sizes: 'd0cdc890a2c4183d5f674b3aa20f6826581cf6676d82eb29b1b390317a2aac18',
  });
});
