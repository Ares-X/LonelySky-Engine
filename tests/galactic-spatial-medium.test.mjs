import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {Euler, Matrix4} from 'three';
import {createSpatialGalacticMedium, createSpatialGalacticMediumTask, createSpatialGalacticMediumFromVolumes, createSpatialGalacticMediumFromVolumesTask, sampleSpatialGalacticMedium, sampleSpatialGalacticStars,
  GALACTIC_SPATIAL_MEDIUM_REVISION, GALACTIC_SPATIAL_SOURCE_BRICK_RESOLUTION} from '../src/galactic-spatial-medium.js';
import {GALACTIC_SPATIAL_SOURCE_RESOLUTION, GALACTIC_SPATIAL_DUST_RESOLUTION} from '../src/index.js';

const options = () => ({seed: 'generic-spatial-fixture', sourceCenter: [0, .03, 0], sourceAxes: [.85, .5, .85],
  dustCenter: [-.05, 0, .04], dustAxes: [.8, .45, .8], luminosities: [1.2, .6, .3],
  colors: [[1, .8, .6], [.6, .8, 1], [1, .7, .5]], extinctionColor: [.6, 1, 1.4], dustIntegral: .031, resolvedFraction: .2,
  sourceKernels: [
    {component: 0, weight: .7, center: [-.24, -.08, .15], axes: [.24, .11, .15], rotation: [.2, .6, .3]},
    {component: 0, weight: .3, center: [.25, .12, -.15], axes: [.13, .08, .18], rotation: [-.3, .2, .6]},
    {component: 1, weight: 1, center: [.18, .14, .23], axes: [.12, .06, .10], rotation: [.4, -.1, -.5]},
    {component: 2, weight: 1, center: [-.02, .18, -.12], axes: [.16, .09, .11], rotation: [-.2, .4, .3]},
  ], dustKernels: [
    {weight: .6, center: [.12, -.01, .05], axes: [.22, .08, .16], rotation: [.5, .2, .8], contrast: .7},
    {weight: .4, center: [-.2, .14, -.1], axes: [.16, .07, .12], rotation: [-.2, .3, -.4], contrast: .4},
  ]});
const medium = createSpatialGalacticMedium(options());
const brickOptions = () => ({...options(), sourceBrick: {kernelIndex: 0, profile: 'coherent-ribbon-v1', macroSpan: [.036, .020, .036], fineSpan: [.012, .008, .012]}});
const bricked = createSpatialGalacticMedium(brickOptions());
const bytesHash = a => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
const output = () => ({emission: [0, 0, 0], extinction: [0, 0, 0]});
const tableMoments = m => {
  const totals = [0, 0, 0], means = Array.from({length: 3}, () => [0, 0, 0]), seconds = Array.from({length: 3}, () => [0, 0, 0]);
  const n = m.sourceVolumeResolution;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const cell = (z * n + y) * n + x, p = [x, y, z].map((v, i) => m.sourceVolumeCenter[i] + ((v + .5) * 2 / n - 1) * m.sourceVolumeAxes[i]);
    for (let component = 0; component < 3; component++) {
      const w = m.sourceVolumeTexels[cell * 4 + component] * m.sourceVolumePixelVolume; totals[component] += w;
      for (let axis = 0; axis < 3; axis++) {means[component][axis] += p[axis] * w; seconds[component][axis] += p[axis] ** 2 * w;}
    }
  }
  for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) {
    means[c][a] /= totals[c]; seconds[c][a] /= totals[c];
    // Each trilinear hat adds a triangular displacement with variance dx^2/6.
    seconds[c][a] += (2 * m.sourceVolumeAxes[a] / n) ** 2 / 6;
  }
  return {totals, means, seconds};
};

test('constructor validates the real finite-field input boundary without accepting clipped kernels', () => {
  const bad = patch => ({...options(), ...patch});
  assert.throws(() => createSpatialGalacticMediumTask(bad({seed: 1})), /string seed/);
  assert.throws(() => createSpatialGalacticMediumTask(bad({luminosities: [1, -1, 0]})), /nonnegative/);
  assert.throws(() => createSpatialGalacticMediumTask(bad({sourceAxes: [0, 1, 1]})), /positive/);
  assert.throws(() => createSpatialGalacticMediumTask(bad({colors: [[0, 0, 0], [1, 1, 1], [1, 1, 1]]})), /luminance/);
  assert.throws(() => createSpatialGalacticMediumTask(bad({resolvedFraction: 2})), /Resolved/);
  assert.throws(() => createSpatialGalacticMediumTask(bad({sourceKernels: []})), /luminous component/);
  assert.throws(() => createSpatialGalacticMediumTask(bad({dustKernels: []})), /Positive dust/);
  assert.throws(() => createSpatialGalacticMediumTask(bad({sourceKernels: Array.from({length: 33}, () => options().sourceKernels[0])})), /at most/);
  const clipped = options(); clipped.sourceKernels[0].center[0] = .8;
  assert.throws(() => createSpatialGalacticMediumTask(clipped), /padding/);
  const contrast = options(); contrast.dustKernels[0].contrast = NaN;
  assert.throws(() => createSpatialGalacticMediumTask(contrast), /contrast/);
});

test('source families and dust are normalized finite actual fields, with zero texture edges and A', () => {
  assert.equal(medium.revision, GALACTIC_SPATIAL_MEDIUM_REVISION);
  assert.equal(medium.sourceVolumeTexels.length, 64 ** 3 * 4); assert.equal(medium.dustVolumeTexels.length, 128 ** 3);
  assert.ok(Object.isFrozen(medium)); assert.ok(Object.isFrozen(medium.sourceVolumeCenter)); assert.ok(Object.isFrozen(medium.spatialSynthesis));
  const integrals = [0, 0, 0]; let dust = 0;
  for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = ((z * 64 + y) * 64 + x) * 4;
    for (let c = 0; c < 4; c++) {
      const value = medium.sourceVolumeTexels[i + c]; assert.ok(Number.isFinite(value) && value >= 0);
      if (c === 3 || x === 0 || x === 63 || y === 0 || y === 63 || z === 0 || z === 63) assert.equal(value, 0);
      if (c < 3) integrals[c] += value * medium.sourceVolumePixelVolume;
    }
  }
  for (let z = 0; z < 128; z++) for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const value = medium.dustVolumeTexels[(z * 128 + y) * 128 + x]; assert.ok(Number.isFinite(value) && value >= 0);
    if (x === 0 || x === 127 || y === 0 || y === 127 || z === 0 || z === 127) assert.equal(value, 0);
    dust += value * medium.dustCloudPixelVolume;
  }
  assert.deepEqual(integrals, medium.sourceComponentIntegrals); assert.equal(dust, medium.dustCloudIntegral);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(integrals[c] / options().luminosities[c] - 1) < 2e-7);
  assert.ok(Math.abs(dust / medium.dustIntegral - 1) < 2e-7);
  assert.equal('texels' in medium, false); assert.equal('verticalGeometry' in medium, false); assert.equal('stellarVolumeTexels' in medium, false);
});

test('sync/task bytes match, staged work snapshots inputs, and cancellation never publishes WIP', () => {
  const source = options(), task = createSpatialGalacticMediumTask(source);
  assert.equal(task.state, 'pending'); assert.equal(task.result, undefined);
  assert.throws(() => task.advance(0), /positive milliseconds/);
  assert.equal(task.step(), false); assert.equal(task.stage, 'source-allocation');
  source.sourceKernels[0].center[0] = .7; source.colors[0][0] = 9; source.sourceCenter[0] = .4;
  let yields = 0;
  while (!task.advance(.1)) {yields++; assert.equal(task.result, undefined);}
  assert.ok(yields > 4); assert.equal(task.state, 'complete'); assert.equal(task.cancel(), false);
  assert.deepEqual(task.result, medium);
  const sourceBuffer = task.result.sourceVolumeTexels, dustBuffer = task.result.dustVolumeTexels;
  for (let i = 0; i < 10; i++) {assert.equal(task.advance(1), true); assert.equal(task.result.sourceVolumeTexels, sourceBuffer); assert.equal(task.result.dustVolumeTexels, dustBuffer);}
  const cancelled = createSpatialGalacticMediumTask(options());
  for (let i = 0; i < 20; i++) cancelled.step();
  assert.equal(cancelled.cancel(), true); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.result, undefined);
  assert.equal(cancelled.cancel(), false); assert.equal(cancelled.advance(1), true); assert.equal(cancelled.result, undefined);
});

test('nonrepresentable positive components fail explicitly and empty components/dust stay exactly zero', () => {
  const tiny = options(); tiny.sourceKernels[2].axes = [1e-8, 1e-8, 1e-8];
  const task = createSpatialGalacticMediumTask(tiny);
  assert.throws(() => task.advance(Infinity), /unresolved/); assert.equal(task.state, 'failed'); assert.equal(task.result, undefined); assert.ok(task.error instanceof RangeError);
  const missedMixture = options(); missedMixture.sourceKernels.push({component: 0, weight: .2, center: [.1234567, .017864, .067894], axes: [1e-8, 1e-8, 1e-8], rotation: [0, 0, 0]});
  assert.throws(() => createSpatialGalacticMedium(missedMixture), /Source kernel is unresolved/, 'One missed positive kernel must not silently disappear behind another same-family kernel');
  const underflow = options(); underflow.luminosities = [1e-300, .6, .3];
  assert.throws(() => createSpatialGalacticMedium(underflow), /representable Float32/);
  const sparse = options(); sparse.luminosities = [1, 0, 0]; sparse.sourceKernels = [sparse.sourceKernels[0]]; sparse.dustIntegral = 0; sparse.dustKernels = [];
  const m = createSpatialGalacticMedium(sparse);
  assert.equal(m.sourceComponentIntegrals[1], 0); assert.equal(m.sourceComponentIntegrals[2], 0); assert.equal(m.dustCloudIntegral, 0);
  assert.ok(m.dustVolumeTexels.every(v => v === 0));
  const points = sampleSpatialGalacticStars(m, 'only-old', 2000); assert.ok(points.componentIndices.every(v => v === 0));
});

test('rotated ellipsoid mixture produces its authored component centers and covariance', () => {
  const measured = tableMoments(medium), input = options();
  const expectedOldCenter = [0, 1, 2].map(a => .7 * input.sourceKernels[0].center[a] + .3 * input.sourceKernels[1].center[a]);
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(measured.means[0][a] - expectedOldCenter[a]) < .0004);
  const k = input.sourceKernels[1], isolated = options(); isolated.sourceKernels = [{...k, component: 0}]; isolated.luminosities = [1, 0, 0]; isolated.dustIntegral = 0; isolated.dustKernels = [];
  const m = createSpatialGalacticMedium(isolated), moments = tableMoments(m), matrix = new Matrix4().makeRotationFromEuler(new Euler(...k.rotation)).elements;
  for (let a = 0; a < 3; a++) {
    assert.ok(Math.abs(moments.means[0][a] - k.center[a]) < .0003);
    const analyticVariance = [0, 1, 2].reduce((s, j) => s + matrix[j * 4 + a] ** 2 * k.axes[j] ** 2 / 9, 0);
    const tableVariance = moments.seconds[0][a] - moments.means[0][a] ** 2;
    assert.ok(Math.abs(tableVariance - analyticVariance) < .0003, `${a}: ${tableVariance} vs ${analyticVariance}`);
  }
});

test('stationary CPU sample is the same trilinear fields, updates caller buffers, and vanishes outside support', () => {
  const p = [.12, .01, .04], sampled = output(), emission = sampled.emission, extinction = sampled.extinction;
  const interpolate = (table, n, center, axes, channels, channel) => {
    const t = p.map((v, i) => ((v - center[i]) / axes[i] + 1) * n / 2 - .5), lo = t.map(Math.floor), f = t.map((v, i) => v - lo[i]); let value = 0;
    for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) value += table[(((lo[2] + z) * n + lo[1] + y) * n + lo[0] + x) * channels + channel] * (x ? f[0] : 1 - f[0]) * (y ? f[1] : 1 - f[1]) * (z ? f[2] : 1 - f[2]);
    return value;
  };
  const density = [0, 1, 2].map(c => interpolate(medium.sourceVolumeTexels, 64, medium.sourceVolumeCenter, medium.sourceVolumeAxes, 4, c));
  const expected = [0, 1, 2].map(c => density[0] * medium.oldStellarColor[c] + density[1] * medium.youngStellarColor[c] + density[2] * medium.bulgeColor[c]);
  const dust = interpolate(medium.dustVolumeTexels, 128, medium.dustCloudCenter, medium.dustCloudAxes, 1, 0);
  for (let i = 0; i < 10000; i++) assert.equal(sampleSpatialGalacticMedium(medium, p, sampled), sampled);
  assert.equal(sampled.emission, emission); assert.equal(sampled.extinction, extinction);
  for (let c = 0; c < 3; c++) {assert.ok(Math.abs(sampled.emission[c] - expected[c]) < 1e-12); assert.ok(Math.abs(sampled.extinction[c] - dust * medium.extinctionColor[c]) < 1e-12);}
  for (let i = 0; i < 200; i++) {
    const z = 1 - 2 * (i + .5) / 200, r = Math.sqrt(1 - z * z), angle = i * 2.399963;
    p[0] = (medium.supportRadius + 1e-5) * r * Math.cos(angle); p[1] = (medium.supportRadius + 1e-5) * z; p[2] = (medium.supportRadius + 1e-5) * r * Math.sin(angle);
    sampleSpatialGalacticMedium(medium, p, sampled); assert.deepEqual(sampled, output());
  }
});

test('3D component CDF/tent draws match actual field means, second moments and finite support; prefixes are stable', () => {
  const expected = tableMoments(medium), count = 80000, sample = sampleSpatialGalacticStars(medium, 'spatial-stars-test', count), prefix = sampleSpatialGalacticStars(medium, 'spatial-stars-test', 257);
  assert.deepEqual(prefix.positions, sample.positions.slice(0, 257 * 3)); assert.deepEqual(prefix.colors, sample.colors.slice(0, 257 * 3));
  assert.deepEqual(prefix.componentIndices, sample.componentIndices.slice(0, 257)); assert.deepEqual(prefix.rawLuminosities, sample.rawLuminosities.slice(0, 257));
  const counts = [0, 0, 0], sums = Array.from({length: 3}, () => [0, 0, 0]), seconds = Array.from({length: 3}, () => [0, 0, 0]), sampled = output(), p = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const c = sample.componentIndices[i]; counts[c]++;
    for (let a = 0; a < 3; a++) {const x = sample.positions[i * 3 + a]; p[a] = x; sums[c][a] += x; seconds[c][a] += x * x;}
    assert.ok(Math.hypot(...p) <= medium.supportRadius); sampleSpatialGalacticMedium(medium, p, sampled); assert.ok(sampled.emission.some(v => v > 0));
    assert.ok(sample.rawLuminosities[i] > 0 && sample.rawLuminosities[i] <= .2 + .8 * (1 / 65536) ** -.65);
  }
  const total = expected.totals.reduce((s, n) => s + n, 0);
  for (let c = 0; c < 3; c++) {
    const probability = expected.totals[c] / total, sigma = Math.sqrt(count * probability * (1 - probability));
    assert.ok(Math.abs(counts[c] - probability * count) < 6 * sigma);
    for (let a = 0; a < 3; a++) {
      const variance = expected.seconds[c][a] - expected.means[c][a] ** 2, tolerance = 6 * Math.sqrt(variance / counts[c]);
      assert.ok(Math.abs(sums[c][a] / counts[c] - expected.means[c][a]) < tolerance);
      const measuredVariance = seconds[c][a] / counts[c] - (sums[c][a] / counts[c]) ** 2;
      assert.ok(Math.abs(measuredVariance / variance - 1) < .07, `${c}/${a}: sampled ${measuredVariance}, field ${variance}`);
    }
  }
});

test('dust detail seed is independent of source geometry and zero contrast is seed-independent', () => {
  const o = options(); o.seed = 'another-generic-spatial-fixture'; const changed = createSpatialGalacticMedium(o);
  assert.deepEqual(changed.sourceVolumeTexels, medium.sourceVolumeTexels); assert.notDeepEqual(changed.dustVolumeTexels, medium.dustVolumeTexels);
  const flatA = options(), flatB = options(); flatA.dustKernels.forEach(k => {k.contrast = 0;}); flatB.dustKernels.forEach(k => {k.contrast = 0;}); flatB.seed = 'other-flat-seed';
  assert.deepEqual(createSpatialGalacticMedium(flatA).dustVolumeTexels, createSpatialGalacticMedium(flatB).dustVolumeTexels);
});

test('absent brick preserves the original v2 source, dust and point-prefix bytes', () => {
  assert.equal(medium.sourceBrick, null);
  assert.equal(bytesHash(medium.sourceVolumeTexels), '7762dcac592d578cd2493d715ebf21cf4d2927f1911df2d4e635389a4a43858a');
  assert.equal(bytesHash(medium.dustVolumeTexels), '716b0456b4966e0e62976e4f364f2fc49bcf9fe9173c0d4883aede7ce15e3d9d');
  const points = sampleSpatialGalacticStars(medium, 'spatial-stars-test', 257);
  assert.equal(bytesHash(points.positions), '8451b22dae3af28d59c0c87a8f492b285addcf40171324cd260e5804c0b7ed11');
  assert.equal(bytesHash(points.rawLuminosities), '915ae057fa1369ebc0430b41cdf315bf4043389d961c5ff574e54bf6127aa060');
});

test('one source brick validates its boundary and replaces, rather than duplicates, the coarse light share', () => {
  for (const change of [{kernelIndex: -1}, {kernelIndex: 4}, {kernelIndex: .5}, {profile: 'other'}, {macroSpan: [0, 1, 1]}, {fineSpan: [1, NaN, 1]}]) {
    const input = brickOptions(); Object.assign(input.sourceBrick, change); assert.throws(() => createSpatialGalacticMediumTask(input));
  }
  assert.throws(() => createSpatialGalacticMediumTask({...options(), sourceBrick: []}));
  const b = bricked.sourceBrick, meta = bricked.spatialSynthesis.sourceBrick;
  assert.equal(b.resolution, GALACTIC_SPATIAL_SOURCE_BRICK_RESOLUTION); assert.equal(b.texels.length, 32 ** 3);
  assert.ok(Object.isFrozen(b)); assert.ok(Object.isFrozen(b.inverse)); assert.ok(Object.isFrozen(b.rotation));
  assert.equal(meta.assignedLuminosity / bricked.oldDiskLuminosity, meta.coarseIsolatedIntegral / (meta.coarseIsolatedIntegral + meta.remainingRawIntegral));
  const totals = [0, 0, 0]; let brickIntegral = 0;
  for (let i = 0; i < bricked.sourceVolumeTexels.length; i += 4) for (let c = 0; c < 3; c++) totals[c] += bricked.sourceVolumeTexels[i + c] * bricked.sourceVolumePixelVolume;
  for (let i = 0; i < b.texels.length; i++) {assert.ok(Number.isFinite(b.texels[i]) && b.texels[i] >= 0); brickIntegral += b.texels[i] * b.pixelVolume;}
  assert.equal(brickIntegral, b.integral); assert.deepEqual(totals, meta.baseComponentIntegrals); totals[b.component] += brickIntegral;
  assert.deepEqual(totals, bricked.sourceComponentIntegrals);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(totals[c] / options().luminosities[c] - 1) < 2e-7);
  assert.ok(totals[0] - b.integral < .5 * totals[0], 'The selected old kernel must no longer be present in the base');
  assert.deepEqual(bricked.dustVolumeTexels, medium.dustVolumeTexels); assert.equal(bricked.dustCloudIntegral, medium.dustCloudIntegral);
  assert.deepEqual(bricked.sourceVolumeTexels.filter((_, i) => i % 4 !== 0), medium.sourceVolumeTexels.filter((_, i) => i % 4 !== 0));
});

function brickWorld(b, x, y, z) {
  const r = b.rotation;
  return [b.center[0] + r[0] * x + r[1] * y + r[2] * z, b.center[1] + r[3] * x + r[4] * y + r[5] * z, b.center[2] + r[6] * x + r[7] * y + r[8] * z];
}
function brickNormalized(b, p) {
  const x = p[0] - b.center[0], y = p[1] - b.center[1], z = p[2] - b.center[2], a = b.inverse;
  return [a[0] * x + a[1] * y + a[2] * z, a[3] * x + a[4] * y + a[5] * z, a[6] * x + a[7] * y + a[8] * z];
}
test('rotated brick interpolation, zero edges and complete tent support agree with the CPU composition', () => {
  const b = bricked.sourceBrick, base = {...bricked, sourceBrick: null}, full = output(), coarse = output(), color = bricked.oldStellarColor;
  let peakIndex = 0; for (let i = 1; i < b.texels.length; i++) if (b.texels[i] > b.texels[peakIndex]) peakIndex = i;
  const ix = peakIndex % 32, iy = Math.floor(peakIndex / 32) % 32, iz = Math.floor(peakIndex / 1024), p = brickWorld(b, ((ix + .5) / 16 - 1) * b.axes[0], ((iy + .5) / 16 - 1) * b.axes[1], ((iz + .5) / 16 - 1) * b.axes[2]);
  const emission = full.emission; for (let i = 0; i < 5000; i++) sampleSpatialGalacticMedium(bricked, p, full);
  sampleSpatialGalacticMedium(base, p, coarse); assert.equal(full.emission, emission);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(full.emission[c] - coarse.emission[c] - b.texels[peakIndex] * color[c]) < 1e-9);
  for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const value = b.texels[(z * 32 + y) * 32 + x];
    if (x === 0 || x === 31 || y === 0 || y === 31 || z === 0 || z === 31) assert.equal(value, 0);
    if (value === 0) continue;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const q = brickWorld(b, ((x + .5 + sx) / 16 - 1) * b.axes[0], ((y + .5 + sy) / 16 - 1) * b.axes[1], ((z + .5 + sz) / 16 - 1) * b.axes[2]);
      assert.ok(Math.hypot(...q) <= bricked.supportRadius); assert.ok(Math.abs(q[1]) <= bricked.stellarVerticalBound);
    }
  }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const q = brickWorld(b, x * b.axes[0], y * b.axes[1], z * b.axes[2]), normalized = brickNormalized(b, q);
    assert.ok(normalized.every((v, i) => Math.abs(v - [x, y, z][i]) < 1e-12));
    sampleSpatialGalacticMedium(bricked, q, full); sampleSpatialGalacticMedium(base, q, coarse); assert.deepEqual(full, coarse);
  }
});

test('virtual base/brick CDF follows actual composite moments and keeps fixed-seed prefixes without extra RNG draws', () => {
  const b = bricked.sourceBrick, expected = tableMoments(bricked), mean = [0, 0, 0], second = [0, 0, 0], n = b.resolution;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const mass = b.texels[(z * n + y) * n + x] * b.pixelVolume;
    if (mass === 0) continue;
    const p = brickWorld(b, ((x + .5) * 2 / n - 1) * b.axes[0], ((y + .5) * 2 / n - 1) * b.axes[1], ((z + .5) * 2 / n - 1) * b.axes[2]);
    for (let a = 0; a < 3; a++) {
      mean[a] += p[a] * mass;
      let tentVariance = 0; for (let j = 0; j < 3; j++) tentVariance += b.rotation[a * 3 + j] ** 2 * (2 * b.axes[j] / n) ** 2 / 6;
      second[a] += (p[a] ** 2 + tentVariance) * mass;
    }
  }
  const c = b.component, mass = expected.totals[c] + b.integral;
  for (let a = 0; a < 3; a++) {expected.means[c][a] = (expected.means[c][a] * expected.totals[c] + mean[a]) / mass; expected.seconds[c][a] = (expected.seconds[c][a] * expected.totals[c] + second[a]) / mass;}
  expected.totals[c] = mass;
  const count = 80000, sample = sampleSpatialGalacticStars(bricked, 'brick-prefix', count), prefix = sampleSpatialGalacticStars(bricked, 'brick-prefix', 151), old = sampleSpatialGalacticStars(medium, 'brick-prefix', 151);
  assert.deepEqual(prefix.positions, sample.positions.slice(0, 151 * 3)); assert.deepEqual(prefix.componentIndices, sample.componentIndices.slice(0, 151));
  assert.deepEqual(prefix.rawLuminosities, old.rawLuminosities, 'Every star must retain the same random-stream consumption, including its power draw');
  const counts = [0, 0, 0], sums = Array.from({length: 3}, () => [0, 0, 0]); let brickCount = 0;
  for (let i = 0; i < count; i++) {
    const c = sample.componentIndices[i], p = Array.from(sample.positions.subarray(i * 3, i * 3 + 3)); counts[c]++;
    assert.ok(Math.hypot(...p) <= bricked.supportRadius);
    for (let a = 0; a < 3; a++) sums[c][a] += p[a];
    if (c === b.component && brickNormalized(b, p).every(v => Math.abs(v) < 1)) brickCount++;
  }
  for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) {
    const variance = expected.seconds[c][a] - expected.means[c][a] ** 2;
    assert.ok(Math.abs(sums[c][a] / counts[c] - expected.means[c][a]) < 6 * Math.sqrt(variance / counts[c]));
  }
  const probability = b.integral / bricked.sourceComponentIntegrals[b.component], sigma = Math.sqrt(counts[b.component] * probability * (1 - probability));
  assert.ok(Math.abs(brickCount - counts[b.component] * probability) < 6 * sigma);
});

test('brick tasks snapshot inputs, match sync output, cancel their own WIP, and use an independent seeded shape', () => {
  const input = brickOptions(), task = createSpatialGalacticMediumTask(input); task.step(); input.sourceBrick.fineSpan[0] = .5; input.sourceKernels[0].center[0] = .5;
  const stages = new Set(); while (!task.advance(.1)) stages.add(task.stage);
  assert.ok(stages.has('source-brick-density-row')); assert.deepEqual(task.result, bricked);
  const cancel = createSpatialGalacticMediumTask(brickOptions()); while (cancel.stage !== 'source-brick-density-row') cancel.step();
  assert.equal(cancel.cancel(), true); assert.equal(cancel.result, undefined); assert.equal(cancel.advance(1), true);
  const changed = createSpatialGalacticMedium({...brickOptions(), seed: 'different-ribbon-stream'});
  assert.notDeepEqual(changed.sourceBrick.texels, bricked.sourceBrick.texels); assert.deepEqual(changed.sourceVolumeTexels, bricked.sourceVolumeTexels);
});

test('a lone selected source transfers its full family budget; a zero-light selected family stays zero', () => {
  const only = brickOptions(); only.sourceBrick.kernelIndex = 2; const m = createSpatialGalacticMedium(only), b = m.sourceBrick;
  for (let i = 1; i < m.sourceVolumeTexels.length; i += 4) assert.equal(m.sourceVolumeTexels[i], 0);
  assert.ok(Math.abs(b.integral / m.youngDiskLuminosity - 1) < 2e-7); assert.equal(m.spatialSynthesis.sourceBrick.assignedLuminosity, m.youngDiskLuminosity);
  const points = sampleSpatialGalacticStars(m, 'all-young-in-brick', 6000); let young = 0;
  for (let i = 0; i < points.componentIndices.length; i++) if (points.componentIndices[i] === 1) {young++; assert.ok(brickNormalized(b, points.positions.subarray(i * 3, i * 3 + 3)).every(v => Math.abs(v) < 1));}
  assert.ok(young > 1000);
  const zero = {...only, luminosities: [1, 0, .3]}, z = createSpatialGalacticMedium(zero), noBrick = createSpatialGalacticMedium({...zero, sourceBrick: null});
  assert.equal(z.sourceBrick.integral, 0); assert.ok(z.sourceBrick.texels.every(v => v === 0)); assert.equal(z.sourceComponentIntegrals[1], 0);
  const zs = sampleSpatialGalacticStars(z, 'zero-selected-light', 4000), ns = sampleSpatialGalacticStars(noBrick, 'zero-selected-light', 4000);
  assert.ok(zs.componentIndices.every(v => v !== 1)); assert.deepEqual(zs, ns);
});

test('completed and cancelled creation buffers are collectible without global CDF retention', {skip: typeof global.gc !== 'function'}, async () => {
  await setImmediate(); global.gc(); const before = process.memoryUsage().arrayBuffers;
  const refs = [];
  for (let i = 0; i < 3; i++) {
    let m = createSpatialGalacticMedium(brickOptions()); refs.push(new WeakRef(m)); m = null;
    const task = createSpatialGalacticMediumTask(brickOptions()); while (task.stage !== 'source-brick-density-row') task.step(); task.cancel();
  }
  for (let i = 0; i < 4; i++) {await setImmediate(); global.gc();}
  assert.ok(refs.every(ref => ref.deref() === undefined), 'WeakMap CDFs must not keep completed media alive');
  assert.ok(process.memoryUsage().arrayBuffers <= before + 1024 * 1024, 'cancelled/collected media must release their owned source/dust/CDF buffers');
});


const volumeOptions = () => {
  const sourceVolumeTexels = new Float32Array(GALACTIC_SPATIAL_SOURCE_RESOLUTION ** 3 * 4), dustVolumeTexels = new Float32Array(GALACTIC_SPATIAL_DUST_RESOLUTION ** 3);
  sourceVolumeTexels[((18 * 64 + 24) * 64 + 12) * 4] = 2;
  sourceVolumeTexels[((44 * 64 + 40) * 64 + 48) * 4 + 1] = 6;
  dustVolumeTexels[(70 * 128 + 63) * 128 + 55] = .25;
  return {seed: 'compiled-volume-fixture', sourceCenter: [.125, -.0625, .25], sourceAxes: [1, .5, .75],
    dustCenter: [0, 0, 0], dustAxes: [.75, .5, .75], colors: [[1, .8, .6], [.6, .8, 1], [1, .7, .5]],
    extinctionColor: [.5, 1, 1.5], resolvedFraction: .2, sourceVolumeTexels, dustVolumeTexels};
};

test('compiled volumes retain caller densities and derive actual luminosity, dust and star CDF from that field', () => {
  const input = volumeOptions(), m = createSpatialGalacticMediumFromVolumes(input), pixelVolume = 3 / 64 ** 3;
  assert.deepEqual(m.sourceVolumeTexels, input.sourceVolumeTexels); assert.deepEqual(m.dustVolumeTexels, input.dustVolumeTexels);
  assert.notEqual(m.sourceVolumeTexels.buffer, input.sourceVolumeTexels.buffer); assert.notEqual(m.dustVolumeTexels.buffer, input.dustVolumeTexels.buffer);
  assert.equal(m.sourceBrick, null); assert.equal(m.spatialSynthesis.kind, 'compiled-spatial-volumes');
  assert.deepEqual(m.sourceComponentIntegrals, [2 * pixelVolume, 6 * pixelVolume, 0]);
  assert.equal(m.oldDiskLuminosity, 2 * pixelVolume); assert.equal(m.youngDiskLuminosity, 6 * pixelVolume); assert.equal(m.bulgeLuminosity, 0);
  assert.equal(m.totalLuminosity, 8 * pixelVolume); assert.equal(m.diskLuminosity, m.totalLuminosity);
  assert.equal(m.dustIntegral, .25 * 2.25 / 128 ** 3); assert.equal(m.dustCloudIntegral, m.dustIntegral);
  const centers = [[12, 24, 18], [48, 40, 44]].map(cell => cell.map((v, a) => m.sourceVolumeCenter[a] + ((v + .5) / 32 - 1) * m.sourceVolumeAxes[a]));
  const out = output(); sampleSpatialGalacticMedium(m, centers[0], out);
  assert.deepEqual(out.emission, m.oldStellarColor.map(v => 2 * v));
  sampleSpatialGalacticMedium(m, [((55.5 / 64) - 1) * .75, (63.5 / 64 - 1) * .5, (70.5 / 64 - 1) * .75], out);
  assert.deepEqual(out.extinction, [.125, .25, .375]);
  const sample = sampleSpatialGalacticStars(m, 'compiled-cdf', 20000), prefix = sampleSpatialGalacticStars(m, 'compiled-cdf', 151), counts = [0, 0, 0];
  assert.deepEqual(prefix.positions, sample.positions.slice(0, 151 * 3));
  for (let i = 0; i < sample.componentIndices.length; i++) {
    const c = sample.componentIndices[i]; counts[c]++; assert.ok(c < 2);
    const p = sample.positions.subarray(i * 3, i * 3 + 3); assert.ok(Math.hypot(...p) <= m.supportRadius); assert.ok(Math.abs(p[1]) <= m.stellarVerticalBound);
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(p[a] - centers[c][a]) <= 2 * m.sourceVolumeAxes[a] / 64 + 1e-7);
    sampleSpatialGalacticMedium(m, p, out); assert.ok(out.emission.some(v => v > 0), 'CDF points must inhabit their source tent');
  }
  assert.ok(Math.abs(counts[0] / 20000 - .25) < .015); assert.equal(counts[2], 0);
  const zeroDust = volumeOptions(); zeroDust.dustVolumeTexels.fill(0);
  const clear = createSpatialGalacticMediumFromVolumes(zeroDust); assert.equal(clear.dustIntegral, 0); assert.equal(clear.dustVerticalBound, 0);
});

test('compiled tasks detach inputs before yielding, retain completed buffers and never publish cancelled work', () => {
  const input = volumeOptions(), expected = createSpatialGalacticMediumFromVolumes(input), task = createSpatialGalacticMediumFromVolumesTask(input);
  input.sourceVolumeTexels.fill(99); input.dustVolumeTexels.fill(99); input.sourceCenter[0] = 9; input.colors[0][0] = 9;
  assert.equal(task.result, undefined); assert.equal(task.step(), false); assert.equal(task.stage, 'source-cdf-allocation');
  while (!task.advance(.1)) assert.equal(task.result, undefined);
  assert.deepEqual(task.result, expected); const stable = task.result.sourceVolumeTexels;
  assert.equal(task.advance(1), true); assert.equal(task.result.sourceVolumeTexels, stable); assert.equal(task.cancel(), false);
  const cancelled = createSpatialGalacticMediumFromVolumesTask(volumeOptions());
  while (cancelled.stage !== 'dust-normalize-row') cancelled.step();
  assert.equal(cancelled.cancel(), true); assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.result, undefined);
  assert.equal(cancelled.advance(Infinity), true); assert.equal(cancelled.result, undefined);
});

test('compiled volume boundary fails explicitly for wrong layouts, nonfinite densities, nonzero padding or alpha and zero source measure', () => {
  const input = volumeOptions();
  assert.throws(() => createSpatialGalacticMediumFromVolumesTask({...input, sourceVolumeTexels: new Float64Array(64 ** 3 * 4)}), /Float32Array/);
  assert.throws(() => createSpatialGalacticMediumFromVolumesTask({...input, dustVolumeTexels: new Float32Array(3)}), /128³/);
  assert.throws(() => createSpatialGalacticMediumFromVolumesTask({...input, sourceAxes: [1, 0, 1]}), /positive/);
  assert.throws(() => createSpatialGalacticMediumFromVolumesTask({...input, resolvedFraction: NaN}), /Resolved/);
  assert.throws(() => createSpatialGalacticMediumFromVolumesTask({...input, colors: [[0, 0, 0], [1, 1, 1], [1, 1, 1]]}), /luminance/);
  for (const [target, index, value, message] of [
    ['sourceVolumeTexels', 4 * ((18 * 64 + 24) * 64 + 12), NaN, /Float32 density/],
    ['sourceVolumeTexels', 4 * ((18 * 64 + 24) * 64 + 12), -1, /Float32 density/],
    ['sourceVolumeTexels', 0, 1, /outer voxel/], ['sourceVolumeTexels', 3, 1, /alpha/],
    ['dustVolumeTexels', (70 * 128 + 63) * 128 + 55, Infinity, /Float32 density/],
    ['dustVolumeTexels', 128 ** 3 - 1, 1, /outer voxel/],
  ]) {
    const o = volumeOptions(); o[target][index] = value; const task = createSpatialGalacticMediumFromVolumesTask(o);
    assert.throws(() => task.advance(Infinity), message); assert.equal(task.state, 'failed'); assert.ok(task.error instanceof RangeError);
    assert.equal(task.result, undefined); assert.equal(task.cancel(), false);
  }
  const empty = volumeOptions(); empty.sourceVolumeTexels.fill(0);
  assert.throws(() => createSpatialGalacticMediumFromVolumes(empty), /source integral/);
});

test('compiled completed, failed and cancelled tasks release detached snapshots and private CDFs', {skip: typeof global.gc !== 'function'}, async () => {
  await setImmediate(); global.gc(); const before = process.memoryUsage().arrayBuffers, refs = [], tasks = [];
  function failedTask() {
    const invalid = volumeOptions(); invalid.dustVolumeTexels[128 ** 3 - 1] = -1;
    const task = createSpatialGalacticMediumFromVolumesTask(invalid); assert.throws(() => task.advance(Infinity)); return task;
  }
  for (let i = 0; i < 3; i++) {
    let m = createSpatialGalacticMediumFromVolumes(volumeOptions()); refs.push(new WeakRef(m)); m = null;
    const cancelled = createSpatialGalacticMediumFromVolumesTask(volumeOptions()); cancelled.step(); cancelled.step(); cancelled.cancel(); tasks.push(cancelled);
    tasks.push(failedTask());
    const unstarted = createSpatialGalacticMediumFromVolumesTask(volumeOptions()); unstarted.cancel(); tasks.push(unstarted);
  }
  for (let i = 0; i < 4; i++) {await setImmediate(); global.gc();}
  assert.ok(refs.every(ref => ref.deref() === undefined)); assert.ok(tasks.every(task => task.result === undefined));
  assert.ok(process.memoryUsage().arrayBuffers <= before + 1024 * 1024, 'retained cancelled/failed tasks must not retain their detached work');
});
