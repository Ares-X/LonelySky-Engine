import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Euler, Matrix4} from 'three';
import {createSpatialGalacticMedium, createSpatialGalacticMediumTask, sampleSpatialGalacticMedium, sampleSpatialGalacticStars,
  GALACTIC_SPATIAL_MEDIUM_REVISION} from '../src/galactic-spatial-medium.js';

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

test('completed and cancelled creation buffers are collectible without global CDF retention', {skip: typeof global.gc !== 'function'}, async () => {
  await setImmediate(); global.gc(); const before = process.memoryUsage().arrayBuffers;
  const refs = [];
  for (let i = 0; i < 3; i++) {
    let m = createSpatialGalacticMedium(options()); refs.push(new WeakRef(m)); m = null;
    const task = createSpatialGalacticMediumTask(options()); for (let j = 0; j < 30; j++) task.step(); task.cancel();
  }
  for (let i = 0; i < 4; i++) {await setImmediate(); global.gc();}
  assert.ok(refs.every(ref => ref.deref() === undefined), 'WeakMap CDFs must not keep completed media alive');
  assert.ok(process.memoryUsage().arrayBuffers <= before + 1024 * 1024, 'cancelled/collected media must release their owned source/dust/CDF buffers');
});
