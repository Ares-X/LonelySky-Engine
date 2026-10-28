import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describeMacro, sampleGalaxy, COSMOS_QUALITY_COUNTS } from '../../src/render/cosmos.js';

const base = Object.freeze({ seed: 'volume-contract', revision: 3, kind: 'cluster', family: 'open',
  morphology: 'irregular', radius: 6500000, thickness: .8,
  orientation: Object.freeze([.27, 1.1, -.64]), asymmetry: .37, arms: 3, pitch: .31, bar: false });
const appearanceHashes = [
  ['volume-contract', 'f2f3bc72a3ddbc0d40930c669d8d1edea53eed08756d7069cc2912249f02c595'],
  ['volume-contract-1', 'f4b45af5daa383106ca8bc2e8183182129ade00fd1db27b8bf913e969d1e4e00'],
  ['volume-contract-2', '5cd2343552e882b26514821d466b71695ba940267e3139443022c185b30d774a'],
];
const digest = (...arrays) => {
  const hash = createHash('sha256');
  for (const array of arrays) hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest('hex');
};

test('open clusters retain a bounded 3D population without a dense support shell', () => {
  for (const [seed] of appearanceHashes) {
    const descriptor = Object.freeze({ ...base, seed }), before = structuredClone(descriptor);
    const { positions, sizes } = sampleGalaxy(descriptor), count = sizes.length;
    const mean = [0, 0, 0], second = Array.from({ length: 3 }, () => [0, 0, 0]), outerBins = new Map();
    for (let i = 0; i < count; i++) {
      const p = Array.from(positions.subarray(i * 3, i * 3 + 3), n => n / descriptor.radius);
      const r = Math.hypot(...p);
      assert.ok(Number.isFinite(r) && r <= .980001, 'every tracer remains inside the declared support');
      if (r > .85) { const bin = Math.floor(r * 100); outerBins.set(bin, (outerBins.get(bin) ?? 0) + 1); }
      for (let a = 0; a < 3; a++) {
        mean[a] += p[a] / count;
        for (let b = 0; b < 3; b++) second[a][b] += p[a] * p[b] / count;
      }
    }
    assert.ok(Math.max(0, ...outerBins.values()) < count * .04, 'outer particles must not pile onto one radius');
    const c = second.map((row, a) => row.map((n, b) => n - mean[a] * mean[b]));
    const determinant = c[0][0] * (c[1][1] * c[2][2] - c[1][2] * c[2][1])
      - c[0][1] * (c[1][0] * c[2][2] - c[1][2] * c[2][0])
      + c[0][2] * (c[1][0] * c[2][1] - c[1][1] * c[2][0]);
    assert.ok(determinant > 1e-5, 'removing the shell must retain volume rather than collapse to a plane');
    assert.deepEqual(descriptor, before);
  }
});

test('open-cluster quality prefixes and the existing appearance stream remain exact', () => {
  for (const [seed, appearanceHash] of appearanceHashes) {
    const descriptor = { ...base, seed }, full = sampleGalaxy(descriptor);
    // Recorded from the preceding public sampler; no duplicate sampling algorithm.
    assert.equal(digest(full.colors, full.sizes), appearanceHash);
    assert.deepEqual(sampleGalaxy(descriptor), full);
    for (const count of [0, ...Object.values(COSMOS_QUALITY_COUNTS)]) {
      const prefix = sampleGalaxy(descriptor, count);
      assert.deepEqual(prefix.positions, full.positions.slice(0, count * 3));
      assert.deepEqual(prefix.colors, full.colors.slice(0, count * 3));
      assert.deepEqual(prefix.sizes, full.sizes.slice(0, count));
    }
  }
});

test('published legacy morphologies retain their immutable particle bytes', () => {
  const fixtures = [
    ['elliptical', { x: -8, y: -8, z: -8 }, 'e6827811d5845a770b0960e434e6ed12a9e8743d3ac6ac79ad507ecb46519936'],
    ['irregular', { x: -8, y: -8, z: -1 }, '413a2ac87235c2bbd3e5aeea34a1115686737f64e0ba862f579c1c1ca7664f25'],
    ['spiral', { x: -8, y: -5, z: 7 }, '6178989a1885a682337e20cb57d66a170b5eaf1d728d4ea233eb469fd147722e'],
  ];
  for (const [morphology, coordinate, expected] of fixtures) {
    const descriptor = describeMacro(coordinate, 'sampler-legacy-contract');
    assert.equal(descriptor.morphology, morphology);
    const sample = sampleGalaxy(descriptor, 128);
    assert.equal(digest(sample.positions, sample.colors, sample.sizes), expected);
  }
});

test('other revisions and structure families retain their existing samples', () => {
  const fixtures = [
    [{ revision: 2 }, '2930cd67932552395619bc8985c731e1b889704a54132edf6299fb7e8ea35ff6'],
    [{ kind: 'galaxy' }, 'c97f0dd64c622af97354fd0a854e5f062df16a9002ce5ff9b951f16d4648b6bd'],
    [{ family: 'globular' }, 'f8bc2e41a34c0b2fbc0e29c20ad93251d800552e44008d1da73c82fcbca3b77c'],
    [{ morphology: 'elliptical' }, '4affaded5d32827869566a4ed0740f0caee1f7b31bdb928b51fcc6730e1ad061'],
  ];
  for (const [change, expected] of fixtures) {
    const sample = sampleGalaxy({ ...base, ...change }, 128);
    assert.equal(digest(sample.positions, sample.colors, sample.sizes), expected);
  }
});
