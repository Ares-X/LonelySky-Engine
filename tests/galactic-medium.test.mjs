import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { createGalacticMedium, createGalacticMediumTask, sampleGalacticMedium, sampleGalacticStars, GALACTIC_MEDIUM_STELLAR_VOLUME_RESOLUTION, GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION } from '../src/galactic-medium.js';

const Y = [.2126, .7152, .0722];
const power = (array, offset = 0) => array[offset] * Y[0] + array[offset + 1] * Y[1] + array[offset + 2] * Y[2];
const columnPower = (array, offset = 0) => array[offset] + array[offset + 1];
function volumeChannelSum(medium, channel) {
  const texels = channel === 0 ? medium.stellarVolumeTexels : medium.dustVolumeTexels;
  let sum = 0;
  for (let i = 0; i < texels.length; i++) sum += texels[i];
  return sum;
}
const output = () => ({ emission: [0, 0, 0], extinction: [0, 0, 0] });
const fixture = createGalacticMedium({ seed: 'shared-field', resolution: 64 });

test('stellar contrast does not silently alter the independently authored dust budget or cloud',()=>{
  const options={seed:'independent-populations',resolution:32,dustContrast:.85,dustCloudFraction:.75};
  const smooth=createGalacticMedium({...options,populationContrast:.3});
  const structured=createGalacticMedium({...options,populationContrast:.9});
  assert.equal(smooth.dustIntegral,structured.dustIntegral);
  assert.equal(smooth.dustCloudIntegral,structured.dustCloudIntegral);
  for(let i=3;i<smooth.texels.length;i+=4)assert.equal(smooth.texels[i],structured.texels[i]);
  assert.deepEqual(smooth.stellarVolumeTexels,structured.stellarVolumeTexels);
  assert.deepEqual(smooth.dustVolumeTexels,structured.dustVolumeTexels);
  assert.notDeepEqual(smooth.texels,structured.texels);
  assert.throws(()=>createGalacticMedium({...options,dustContrast:NaN}));
});

test('seed owns stable geometry, finite nonnegative texels, and normalized luminosity budgets', () => {
  const same = createGalacticMedium({ seed: 'shared-field', resolution: 64 });
  assert.deepEqual(same, fixture);
  assert.ok(Object.isFrozen(fixture)); assert.ok(Object.isFrozen(fixture.bulgeAxes));
  const different = createGalacticMedium({ seed: 'other-field', resolution: 64 });
  let difference = 0, integrated = 0, dust = 0;
  for (let i = 0; i < fixture.texels.length; i += 4) {
    for (let axis = 0; axis < 4; axis++) assert.ok(Number.isFinite(fixture.texels[i + axis]) && fixture.texels[i + axis] >= 0);
    const a = columnPower(fixture.texels, i), b = columnPower(different.texels, i);
    integrated += a * fixture.pixelArea; difference += Math.abs(a - b) * fixture.pixelArea; dust += fixture.texels[i + 3];
  }
  assert.ok(difference / integrated > .15, 'different seeds must change spatial structure');
  assert.ok(Math.abs(integrated / fixture.diskLuminosity - 1) < 2e-7);
  assert.equal(integrated, fixture.tableLuminosity);
  assert.ok(dust > 0);
  const bulgeIntegral = volumeChannelSum(fixture, 0) * fixture.bulgePixelVolume * power(fixture.bulgeColor);
  assert.ok(Math.abs((integrated + bulgeIntegral) / fixture.totalLuminosity - 1) < 2e-7);
  for (let i = 0; i < fixture.resolution; i++) for (let axis = 0; axis < 4; axis++) {
    for (const cell of [i, i + (fixture.resolution - 1) * fixture.resolution, i * fixture.resolution, i * fixture.resolution + fixture.resolution - 1]) assert.equal(fixture.texels[cell * 4 + axis], 0);
  }
  for (const morphology of ['barred', 'irregular']) {
    const other = createGalacticMedium({ seed: 'shared-field', resolution: 64, morphology });
    assert.notDeepEqual(other.texels, fixture.texels);
  }
});

test('actual field vanishes outside finite support and meets vertical edges continuously', () => {
  const sampled = output(), point = [0, 0, 0];
  for (let i = 0; i < 1500; i++) {
    const angle = i * 2.399963, y = -1 + 2 * (i + .5) / 1500, planar = Math.sqrt(1 - y * y);
    const radius = fixture.supportRadius + .00001;
    point[0] = Math.cos(angle) * planar * radius; point[1] = y * radius; point[2] = Math.sin(angle) * planar * radius;
    assert.strictEqual(sampleGalacticMedium(fixture, point, sampled), sampled);
    assert.deepEqual(sampled, output());
  }
  const disk = createGalacticMedium({ seed: 'vertical-profile', resolution: 32, bulgeFraction: 0 });
  let peak = -1, peakCell = -1;
  for (let i = 0; i < disk.texels.length; i += 4) if (columnPower(disk.texels, i) > peak) { peak = columnPower(disk.texels, i); peakCell = i / 4; }
  point[0] = (peakCell % 32 + .5) / 16 - 1; point[2] = (Math.floor(peakCell / 32) + .5) / 16 - 1;
  for (const height of [disk.stellarHeight, disk.dustHeight]) for (const sign of [-1, 1]) {
    point[1] = sign * height; sampleGalacticMedium(disk, point, sampled);
    const boundary = height === disk.stellarHeight ? sampled.emission : sampled.extinction;
    assert.deepEqual(boundary, [0, 0, 0]);
    point[1] = sign * height * (1 - 1e-6); sampleGalacticMedium(disk, point, sampled);
    const inside = height === disk.stellarHeight ? sampled.emission : sampled.extinction;
    assert.ok(inside.every(n => Number.isFinite(n) && n >= 0 && n < 1e-6));
  }
  for (const p of [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 2, 0]]) {
    sampleGalacticMedium(fixture, p, sampled); assert.deepEqual(sampled, output());
  }
});

test('independent midpoint volume integrals recover disk and 3D bulge budgets', () => {
  const point = [0, 0, 0], sampled = output();
  const disk = createGalacticMedium({ seed: 'integrate-disk', resolution: 32, bulgeFraction: 0 });
  let diskIntegral = 0;
  const planarSteps = 64, verticalSteps = 128, dx = 2 / planarSteps, dy = 2 * disk.stellarHeight / verticalSteps;
  for (let iz = 0; iz < planarSteps; iz++) for (let ix = 0; ix < planarSteps; ix++) for (let iy = 0; iy < verticalSteps; iy++) {
    point[0] = -1 + (ix + .5) * dx; point[2] = -1 + (iz + .5) * dx; point[1] = -disk.stellarHeight + (iy + .5) * dy;
    sampleGalacticMedium(disk, point, sampled); diskIntegral += power(sampled.emission) * dx * dx * dy;
  }
  assert.ok(Math.abs(diskIntegral / disk.totalLuminosity - 1) < 2e-6, String(diskIntegral));
  const bulge = createGalacticMedium({ seed: 'integrate-bulge', resolution: 32, bulgeFraction: 1, bulgeCenter: [.08, -.04, .06], bulgeAxes: [.37, .17, .26] });
  let bulgeIntegral = 0;
  const steps = 128, volume = 8 * bulge.bulgeAxes[0] * bulge.bulgeAxes[1] * bulge.bulgeAxes[2] / steps ** 3;
  for (let iz = 0; iz < steps; iz++) for (let ix = 0; ix < steps; ix++) for (let iy = 0; iy < steps; iy++) {
    point[0] = bulge.bulgeCenter[0] + ((ix + .5) * 2 / steps - 1) * bulge.bulgeAxes[0];
    point[1] = bulge.bulgeCenter[1] + ((iy + .5) * 2 / steps - 1) * bulge.bulgeAxes[1];
    point[2] = bulge.bulgeCenter[2] + ((iz + .5) * 2 / steps - 1) * bulge.bulgeAxes[2];
    sampleGalacticMedium(bulge, point, sampled); bulgeIntegral += power(sampled.emission) * volume;
  }
  assert.ok(Math.abs(bulgeIntegral / bulge.totalLuminosity - 1) < 2e-5, String(bulgeIntegral));
});

test('explicit larger populations preserve the complete original sampling prefix', () => {
  const full=sampleGalacticStars(fixture,'expanded-prefix',16384),previous=sampleGalacticStars(fixture,'expanded-prefix',4096);
  assert.equal(full.rawLuminosities.length,16384);
  for(const key of Object.keys(previous))assert.deepEqual(full[key].subarray(0,previous[key].length),previous[key]);
});

test('star qualities have exact prefixes, unit-luminance colors, actual support and budget-weighted components', () => {
  const full = sampleGalacticStars(fixture, 'proxy-stream', 4096), low = sampleGalacticStars(fixture, 'proxy-stream', 137);
  for (const key of Object.keys(full)) assert.deepEqual(low[key], full[key].slice(0, low[key].length));
  const point = [0, 0, 0], sampled = output();
  let bulges = 0, bright = 0;
  const componentCounts = [0, 0, 0];
  for (let i = 0; i < 4096; i++) {
    for (let axis = 0; axis < 3; axis++) point[axis] = full.positions[i * 3 + axis];
    assert.ok(Math.hypot(...point) <= fixture.supportRadius);
    sampleGalacticMedium(fixture, point, sampled); assert.ok(power(sampled.emission) > 0);
    assert.ok(Math.abs(power(full.colors, i * 3) - 1) < 8e-8);
    assert.ok(full.colors.subarray(i * 3, i * 3 + 3).every(n => Number.isFinite(n) && n >= 0));
    assert.ok(Number.isFinite(full.rawLuminosities[i]) && full.rawLuminosities[i] > 0);
    componentCounts[full.componentIndices[i]]++; bulges += Number(full.componentIndices[i] === 2); bright += full.rawLuminosities[i] > 4;
  }
  assert.ok(Math.abs(bulges / 4096 - fixture.bulgeLuminosity / fixture.totalLuminosity) < .025);
  for (const [component, budget] of [fixture.oldDiskLuminosity, fixture.youngDiskLuminosity, fixture.bulgeLuminosity].entries()) assert.ok(Math.abs(componentCounts[component] / 4096 - budget / fixture.totalLuminosity) < .025);
  assert.ok(bright > 50 && bright < 700);
  assert.equal(sampleGalacticStars(fixture, 'zero', 0).positions.length, 0);
});

test('disk proxies follow bilinear column moments and the compact vertical measure', () => {
  const disk = createGalacticMedium({ seed: 'disk-moments', resolution: 32, bulgeFraction: 0 });
  const stars = sampleGalacticStars(disk, 'disk-moment-stream', 4096);
  let expectedX = 0, expectedX2 = 0, actualX = 0, actualX2 = 0, actualY2 = 0;
  for (let cell = 0; cell < 32 * 32; cell++) {
    const x = (cell % 32 + .5) / 16 - 1, weight = columnPower(disk.texels, cell * 4) * disk.pixelArea / disk.tableLuminosity;
    expectedX += x * weight; expectedX2 += (x * x + (2 / 32) ** 2 / 6) * weight;
  }
  for (let i = 0; i < 4096; i++) {
    actualX += stars.positions[i * 3] / 4096;
    actualX2 += stars.positions[i * 3] ** 2 / 4096;
    actualY2 += stars.positions[i * 3 + 1] ** 2 / 4096;
    assert.ok(stars.componentIndices[i] === 0 || stars.componentIndices[i] === 1);
  }
  assert.ok(Math.abs(actualX - expectedX) < .018);
  assert.ok(Math.abs(actualX2 - expectedX2) < .009);
  const expectedY2 = (disk.oldTableLuminosity * disk.stellarHeight ** 2 + disk.youngTableLuminosity * disk.youngStellarHeight ** 2) / (disk.tableLuminosity * 7);
  assert.ok(Math.abs(actualY2 / expectedY2 - 1) < .08);
});

test('external creation and sampling limits reject unsupported input', () => {
  for (const options of [{ resolution: 1025 }, { resolution: 31 }, { morphology: 'unknown' }, { stellarHeight: .2 }, {youngStellarHeight: 0}, {youngStellarHeight: .04}, { dustHeight: 0 }, { totalLuminosity: NaN }, { arms: 0 }, { bulgeAxes: [1, 1, 1] }, { bulgeAxes: [1e-200, 1e-200, 1e-200] }, { palette: { old: [0, 0, 0], young: [1, 1, 1], dust: [1, 1, 1] } }]) assert.throws(() => createGalacticMedium({ seed: 'limits', ...options }));
  for (const count of [-1, 16385, 1.5, NaN, Infinity]) assert.throws(() => sampleGalacticStars(fixture, 'limits', count));
  const noDust = createGalacticMedium({ seed: 'no-dust', resolution: 32, dustOpticalDepth: 0 });
  for (let i = 3; i < noDust.texels.length; i += 4) assert.equal(noDust.texels[i], 0);
  assert.ok(createGalacticMedium({ seed: 'max-height', resolution: 32, stellarHeight: .1, dustHeight: .1 }).supportRadius <= 1);
});

test('dust is a normalized absorbing column sharing texel-center sampling with emission', () => {
  const disk = createGalacticMedium({ seed: 'column-contract', resolution: 32, bulgeFraction: 0 });
  let cell = 0;
  for (let i = 1; i < 1024; i++) if (disk.texels[i * 4 + 3] > disk.texels[cell * 4 + 3]) cell = i;
  const point = [(cell % 32 + .5) / 16 - 1, 0, (Math.floor(cell / 32) + .5) / 16 - 1], sampled = output();
  sampleGalacticMedium(disk, point, sampled);
  for (let axis = 0; axis < 3; axis++) {
    const expected = (disk.texels[cell * 4] * disk.oldStellarColor[axis] / disk.stellarHeight + disk.texels[cell * 4 + 1] * disk.youngStellarColor[axis] / disk.youngStellarHeight) * 15 / 16;
    assert.ok(Math.abs(sampled.emission[axis] - expected) < 1e-14);
  }
  const column = [0, 0, 0], steps = 128, dy = 2 * disk.dustHeight / steps;
  for (let i = 0; i < steps; i++) {
    point[1] = -disk.dustHeight + (i + .5) * dy;
    sampleGalacticMedium(disk, point, sampled);
    for (let axis = 0; axis < 3; axis++) column[axis] += sampled.extinction[axis] * dy;
  }
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(column[axis] / (disk.texels[cell * 4 + 3] * disk.extinctionColor[axis]) - 1) < 1e-7);
  assert.ok(column[0] < column[1] && column[1] < column[2], 'default dust absorbs blue most strongly');
});

// Independent planar interpolation for the geometry/column contract below.
function interpolatedDust(medium, x, z) {
  const n = medium.resolution, u = (x + 1) * n / 2 - .5, v = (z + 1) * n / 2 - .5;
  const ix = Math.floor(u), iz = Math.floor(v), fx = u - ix, fz = v - iz;
  let column = 0, offset = 0, scale = 0;
  for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
    const cell = Math.max(0, Math.min(n - 1, iz + dz)) * n + Math.max(0, Math.min(n - 1, ix + dx));
    const weight = (dx ? fx : 1 - fx) * (dz ? fz : 1 - fz);
    column += medium.texels[cell * 4 + 3] * weight;
    offset += medium.verticalGeometry[cell * 4] * weight; scale += medium.verticalGeometry[cell * 4 + 1] * weight;
  }
  return {column, offset, height: medium.dustHeight * scale};
}

test('warped/thickened dust is stable, spatial, bounded, and leaves stellar populations unchanged', () => {
  const options = {seed: 'dust-geometry', resolution: 64, dustWarp: .024, dustHeightVariation: .65, dustHeight: .025};
  const warped = createGalacticMedium(options), same = createGalacticMedium(options);
  const flat = createGalacticMedium({...options, dustWarp: 0, dustHeightVariation: 0});
  assert.deepEqual(warped.verticalGeometry, same.verticalGeometry);
  assert.deepEqual(warped.texels, flat.texels);
  assert.deepEqual(sampleGalacticStars(warped, 'same-stars', 512), sampleGalacticStars(flat, 'same-stars', 512));
  let minimumOffset = 0, maximumOffset = 0, minimumScale = 1, maximumScale = 1, bound = 0;
  for (let cell = 0; cell < 64 * 64; cell++) {
    const offset = warped.verticalGeometry[cell * 4], scale = warped.verticalGeometry[cell * 4 + 1];
    assert.ok(Number.isFinite(offset) && Math.abs(offset) <= .024 + 1e-8);
    assert.ok(Number.isFinite(scale) && scale >= .35 - 1e-7 && scale <= 1.65 + 1e-7);
    minimumOffset = Math.min(minimumOffset, offset); maximumOffset = Math.max(maximumOffset, offset);
    minimumScale = Math.min(minimumScale, scale); maximumScale = Math.max(maximumScale, scale);
    bound = Math.max(bound, Math.abs(offset) + warped.dustHeight * scale);
    assert.equal(flat.verticalGeometry[cell * 4], 0); assert.equal(flat.verticalGeometry[cell * 4 + 1], 1);
    const row = Math.floor(cell / 64), column = cell % 64;
    if (row === 0 || row === 63 || column === 0 || column === 63) { assert.equal(offset, 0); assert.equal(scale, 1); }
  }
  assert.ok(minimumOffset < 0 && maximumOffset > 0 && minimumScale < 1 && maximumScale > 1);
  assert.equal(warped.dustVerticalBound, bound); assert.ok(warped.supportRadius <= 1);
  const other = createGalacticMedium({...options, seed: 'other-dust-geometry'});
  assert.notDeepEqual(other.verticalGeometry, warped.verticalGeometry);
  for (const invalid of [{dustWarp: -.001}, {dustWarp: .081}, {dustHeightVariation: -.01}, {dustHeightVariation: .81}]) assert.throws(() => createGalacticMedium({...options, ...invalid}));
});

test('interpolated shifted dust columns keep their optical depth and exact half-column measure', () => {
  const medium = createGalacticMedium({seed: 'shifted-columns', resolution: 64, dustWarp: .024, dustHeightVariation: .65, dustHeight: .025});
  let peak = 0;
  for (let cell = 0; cell < 64 * 64; cell++) if (medium.texels[cell * 4 + 3] > medium.texels[peak * 4 + 3]) peak = cell;
  const centerX = (peak % 64 + .5) / 32 - 1, centerZ = (Math.floor(peak / 64) + .5) / 32 - 1;
  const sampled = output(), point = [0, 0, 0];
  for (const [x, z] of [[centerX, centerZ], [centerX + .007, centerZ - .009], [centerX - .011, centerZ + .006]]) {
    const dust = interpolatedDust(medium, x, z), column = [0, 0, 0], halfColumn = [0, 0, 0], steps = 128;
    assert.ok(dust.column > 0); point[0] = x; point[2] = z;
    for (let i = 0; i < steps; i++) {
      point[1] = dust.offset - dust.height + (i + .5) * 2 * dust.height / steps;
      sampleGalacticMedium(medium, point, sampled);
      for (let axis = 0; axis < 3; axis++) column[axis] += sampled.extinction[axis] * 2 * dust.height / steps;
      point[1] = dust.offset + (i + .5) * dust.height / steps;
      sampleGalacticMedium(medium, point, sampled);
      for (let axis = 0; axis < 3; axis++) halfColumn[axis] += sampled.extinction[axis] * dust.height / steps;
    }
    for (let axis = 0; axis < 3; axis++) {
      const expected = dust.column * medium.extinctionColor[axis];
      assert.ok(Math.abs(column[axis] / expected - 1) < 1e-7);
      assert.ok(Math.abs(halfColumn[axis] / expected - .5) < 1e-7);
    }
    for (const sign of [-1, 1]) {
      point[1] = dust.offset + sign * dust.height;
      sampleGalacticMedium(medium, point, sampled); assert.ok(sampled.extinction.every(n => n < 1e-20));
      point[1] = sign * (medium.dustVerticalBound + 1e-8);
      sampleGalacticMedium(medium, point, sampled); assert.deepEqual(sampled.extinction, [0, 0, 0]);
    }
  }
});

test('warped dust vanishes beyond its actual conservative sphere, including extreme allowed geometry', () => {
  const medium = createGalacticMedium({seed: 'dust-support', resolution: 32, dustWarp: .08, dustHeightVariation: .8, dustHeight: .1});
  assert.ok(medium.supportRadius <= 1);
  const point = [0, 0, 0], sampled = output();
  for (let i = 0; i < 768; i++) {
    const y = 2 * (i + .5) / 768 - 1, planar = Math.sqrt(1 - y * y), angle = i * 2.399963, r = medium.supportRadius + 1e-8;
    point[0] = r * planar * Math.cos(angle); point[1] = r * y; point[2] = r * planar * Math.sin(angle);
    sampleGalacticMedium(medium, point, sampled); assert.deepEqual(sampled, output());
  }
});

test('population contrast reallocates a fixed disk budget into multiscale groups and low-density space', () => {
  const options = {seed: 'population-contrast', resolution: 96, morphology: 'barred', bulgeFraction: .22};
  const baseline = createGalacticMedium({...options, populationContrast: 0});
  const contrasted = createGalacticMedium({...options, populationContrast: .85});
  const repeated = createGalacticMedium({...options, populationContrast: .85});
  assert.deepEqual(contrasted, repeated);
  function planeStatistics(medium) {
    const values = [];
    let integrated = 0;
    for (let cell = 0; cell < medium.resolution ** 2; cell++) {
      const value = columnPower(medium.texels, cell * 4);
      integrated += value * medium.pixelArea;
      const x = (cell % medium.resolution + .5) * 2 / medium.resolution - 1;
      const z = (Math.floor(cell / medium.resolution) + .5) * 2 / medium.resolution - 1;
      // Exclude the fixed outer taper and unresolved nucleus from density
      // statistics so they cannot manufacture the required negative space.
      const r = Math.hypot(x, z);
      if (r > .16 && r < .68) values.push(value);
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    values.sort((a, b) => a - b);
    const tenth = values[Math.floor(values.length * .1)], ninetieth = values[Math.floor(values.length * .9)];
    return {integrated, span: ninetieth / tenth, lowAreaFraction: values.filter(value => value < mean * .15).length / values.length, high: ninetieth, mean};
  }
  const low = planeStatistics(baseline), high = planeStatistics(contrasted);
  for (const [medium, stats] of [[baseline, low], [contrasted, high]]) {
    assert.ok(Math.abs(stats.integrated / medium.diskLuminosity - 1) < 2e-7);
    const bulge = volumeChannelSum(medium, 0) * medium.bulgePixelVolume * power(medium.bulgeColor);
    assert.ok(Math.abs((stats.integrated + bulge) / medium.totalLuminosity - 1) < 2e-7);
  }
  assert.deepEqual(baseline.stellarVolumeTexels, contrasted.stellarVolumeTexels);
  assert.ok(high.span > low.span, `contrast must widen plane density quantiles: ${high.span} versus ${low.span}`);
  assert.ok(high.lowAreaFraction > low.lowAreaFraction, `low-density area must grow: ${high.lowAreaFraction} versus ${low.lowAreaFraction}`);
  assert.ok(high.lowAreaFraction < .95 && high.high > high.mean, 'the disk must retain luminous groups');
  const full = sampleGalacticStars(contrasted, 'contrast-prefix', 4096), prefix = sampleGalacticStars(contrasted, 'contrast-prefix', 191);
  for (const key of Object.keys(full)) assert.deepEqual(prefix[key], full[key].slice(0, prefix[key].length));
  for (const populationContrast of [-.01, 1.01, NaN]) assert.throws(() => createGalacticMedium({...options, populationContrast}));
});

function interpolatedStellar(medium, x, z) {
  const n = medium.resolution, u = (x + 1) * n / 2 - .5, v = (z + 1) * n / 2 - .5;
  const ix = Math.floor(u), iz = Math.floor(v), fx = u - ix, fz = v - iz;
  let oldColumn = 0, youngColumn = 0, offset = 0, scale = 0;
  for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
    const index = (Math.max(0, Math.min(n - 1, iz + dz)) * n + Math.max(0, Math.min(n - 1, ix + dx))) * 4;
    const weight = (dx ? fx : 1 - fx) * (dz ? fz : 1 - fz);
    oldColumn += medium.texels[index] * weight; youngColumn += medium.texels[index + 1] * weight;
    offset += medium.verticalGeometry[index + 2] * weight; scale += medium.verticalGeometry[index + 3] * weight;
  }
  const column = medium.oldStellarColor.map((value, c) => value * oldColumn + medium.youngStellarColor[c] * youngColumn);
  return {column, oldColumn, youngColumn, offset, scale, height: medium.stellarHeight * scale, youngHeight: medium.youngStellarHeight * scale};
}
// Four-node numerical quadrature on the profile's finite intervals. This
// integrates both distinct profiles and their first/second moments without
// requiring a very fine uniform grid to resolve the thinner young layer.
function integrateStellarColumn(medium, x, z) {
  const g = interpolatedStellar(medium, x, z), sampled = output(), point = [x, 0, z], column = [0, 0, 0];
  const cuts = [g.offset - g.height, g.offset - g.youngHeight, g.offset + g.youngHeight, g.offset + g.height];
  const nodes = [.06943184420297371, .33000947820757187, .6699905217924281, .9305681557970262], weights = [.17392742256872692, .32607257743127307, .32607257743127307, .17392742256872692];
  let first = 0, second = 0;
  for (let i = 0; i < cuts.length - 1; i++) for (let k = 0; k < 4; k++) {
    point[1] = cuts[i] + nodes[k] * (cuts[i + 1] - cuts[i]); const ds = weights[k] * (cuts[i + 1] - cuts[i]);
    sampleGalacticMedium(medium, point, sampled);
    for (let c = 0; c < 3; c++) column[c] += sampled.emission[c] * ds;
    first += power(sampled.emission) * point[1] * ds; second += power(sampled.emission) * point[1] ** 2 * ds;
  }
  return {column, first, second};
}

test('shared RGBA geometry defaults to the old stellar profile and separates cloud geometries', () => {
  const options = {seed: 'shared-vertical-default', resolution: 32, dustWarp: .024, dustHeightVariation: .65};
  const defaults = createGalacticMedium(options), explicit = createGalacticMedium({...options, stellarWarp: 0, stellarHeightVariation: 0});
  assert.deepEqual(defaults, explicit);
  assert.equal('dustGeometry' in defaults, false);
  assert.equal(defaults.verticalGeometry.length, defaults.resolution ** 2 * 4);
  for (let i = 0; i < defaults.verticalGeometry.length; i += 4) {
    assert.equal(defaults.verticalGeometry[i + 2], 0); assert.equal(defaults.verticalGeometry[i + 3], 1);
  }
  assert.equal(defaults.stellarVerticalBound, defaults.stellarHeight);
  const options3d = {...options, stellarWarp: .06, stellarHeightVariation: .7};
  const varied = createGalacticMedium(options3d), same = createGalacticMedium(options3d);
  assert.deepEqual(varied, same); assert.deepEqual(varied.texels, defaults.texels);
  let bound = 0, differentGeometry = false;
  for (let cell = 0; cell < varied.resolution ** 2; cell++) {
    const i = cell * 4, geometry = varied.verticalGeometry;
    assert.ok(Number.isFinite(geometry[i + 2]) && Math.abs(geometry[i + 2]) <= .06 + 1e-8);
    assert.ok(Number.isFinite(geometry[i + 3]) && geometry[i + 3] >= .3 - 1e-7 && geometry[i + 3] <= 1.7 + 1e-7);
    bound = Math.max(bound, Math.abs(geometry[i + 2]) + varied.stellarHeight * geometry[i + 3]);
    differentGeometry ||= Math.abs(geometry[i] - geometry[i + 2]) > .001;
    const row = Math.floor(cell / varied.resolution), column = cell % varied.resolution;
    if (row === 0 || row === varied.resolution - 1 || column === 0 || column === varied.resolution - 1) assert.deepEqual(Array.from(geometry.subarray(i, i + 4)), [0, 1, 0, 1]);
  }
  assert.equal(varied.stellarVerticalBound, bound); assert.ok(differentGeometry);
  for (const invalid of [{stellarWarp: -.001}, {stellarWarp: .081}, {stellarHeightVariation: -.01}, {stellarHeightVariation: .81}]) assert.throws(() => createGalacticMedium({...options, ...invalid}));
});

test('two spatial stellar profiles preserve their RGB columns, moments and full disk luminosity', () => {
  const medium = createGalacticMedium({seed: 'stellar-column-integrals', resolution: 32, stellarWarp: .06, stellarHeightVariation: .7, bulgeFraction: 0});
  let integrated = 0;
  const planarSteps = 64, dx = 2 / planarSteps;
  for (let iz = 0; iz < planarSteps; iz++) for (let ix = 0; ix < planarSteps; ix++) integrated += power(integrateStellarColumn(medium, -1 + (ix + .5) * dx, -1 + (iz + .5) * dx).column) * dx * dx;
  assert.ok(Math.abs(integrated / medium.diskLuminosity - 1) < 2e-7);
  for (const [x, z] of [[.123, -.217], [-.31, .163], [.417, .109]]) {
    const g = interpolatedStellar(medium, x, z), integral = integrateStellarColumn(medium, x, z);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(integral.column[c] / g.column[c] - 1) < 1e-7);
    const mean = integral.first / power(integral.column), variance = integral.second / power(integral.column) - mean * mean;
    const expectedVariance = (g.oldColumn * g.height ** 2 + g.youngColumn * g.youngHeight ** 2) / (7 * (g.oldColumn + g.youngColumn));
    assert.ok(Math.abs(mean - g.offset) < 1e-8); assert.ok(Math.abs(variance / expectedVariance - 1) < 1e-6);
  }
});

test('stellar proxies sample the conditional geometry at their final planar positions', () => {
  const options = {seed: 'stellar-conditional', resolution: 32, stellarHeight: .045, bulgeFraction: 0};
  const flat = createGalacticMedium(options), varied = createGalacticMedium({...options, stellarWarp: .08, stellarHeightVariation: .8});
  const flatStars = sampleGalacticStars(flat, 'same-conditional-draws', 4096), stars = sampleGalacticStars(varied, 'same-conditional-draws', 4096);
  const prefix = sampleGalacticStars(varied, 'same-conditional-draws', 193);
  for (const key of Object.keys(stars)) assert.deepEqual(prefix[key], stars[key].slice(0, prefix[key].length));
  for (const key of ['colors', 'rawLuminosities', 'componentIndices']) assert.deepEqual(stars[key], flatStars[key]);
  let residualMean = 0, residualSecond = 0, changed = 0;
  const point = [0, 0, 0], sampled = output();
  for (let i = 0; i < 4096; i++) {
    const offset = i * 3;
    assert.equal(stars.positions[offset], flatStars.positions[offset]); assert.equal(stars.positions[offset + 2], flatStars.positions[offset + 2]);
    const x = stars.positions[offset], z = stars.positions[offset + 2], geometry = interpolatedStellar(varied, x, z);
    // Coupling the two populations by their unchanged random stream tests
    // the conditional transform without duplicating its inverse-CDF code.
    const componentHeight = stars.componentIndices[i] === 1 ? geometry.youngHeight : geometry.height;
    const flatHeight = stars.componentIndices[i] === 1 ? flat.youngStellarHeight : flat.stellarHeight;
    const quantileFromFlat = flatStars.positions[offset + 1] / flatHeight;
    const expectedY = geometry.offset + componentHeight * quantileFromFlat;
    assert.ok(Math.abs(stars.positions[offset + 1] - expectedY) < 3e-8);
    const residual = (stars.positions[offset + 1] - geometry.offset) / componentHeight;
    assert.ok(Math.abs(residual) < 1); residualMean += residual / 4096; residualSecond += residual * residual / 4096;
    changed += Math.abs(stars.positions[offset + 1] - flatStars.positions[offset + 1]) > .001;
    point[0] = x; point[1] = stars.positions[offset + 1]; point[2] = z;
    assert.ok(Math.hypot(...point) <= varied.supportRadius);
    sampleGalacticMedium(varied, point, sampled); assert.ok(power(sampled.emission) > 0);
  }
  assert.ok(Math.abs(residualMean) < .02); assert.ok(Math.abs(residualSecond / (1 / 7) - 1) < .08);
  assert.ok(changed > 2048);
});

test('stellar support includes dust-free emitting cells and extreme allowed vertical geometry', () => {
  const medium = createGalacticMedium({seed: 'stellar-support', resolution: 32, stellarWarp: .08, stellarHeightVariation: .8, stellarHeight: .1, dustOpticalDepth: 0, bulgeFraction: 0});
  assert.ok(medium.supportRadius <= 1);
  const point = [0, 0, 0], sampled = output();
  for (let i = 0; i < 768; i++) {
    const y = 2 * (i + .5) / 768 - 1, planar = Math.sqrt(1 - y * y), angle = i * 2.399963, radius = medium.supportRadius + 1e-8;
    point[0] = radius * planar * Math.cos(angle); point[1] = radius * y; point[2] = radius * planar * Math.sin(angle);
    sampleGalacticMedium(medium, point, sampled); assert.deepEqual(sampled, output());
  }
  for (const sign of [-1, 1]) {
    sampleGalacticMedium(medium, [.2, sign * (medium.stellarVerticalBound + 1e-8), -.1], sampled); assert.deepEqual(sampled, output());
  }
});

test('the finite 3D bulge has deterministic seed structure, bounded contrast and conserved luminosity', () => {
  const options = {seed: 'bulge-complexes', resolution: 32, bulgeContrast: .85, bulgeCenter: [.03, -.02, .04]};
  const medium = createGalacticMedium(options), same = createGalacticMedium(options);
  const smooth = createGalacticMedium({...options, bulgeContrast: 0}), other = createGalacticMedium({...options, seed: 'other-bulge-complexes'});
  assert.deepEqual(medium.stellarVolumeTexels, same.stellarVolumeTexels);
  assert.deepEqual(medium.texels, smooth.texels); assert.deepEqual(medium.verticalGeometry, smooth.verticalGeometry);
  assert.equal('bulgeDensity' in medium, false);
  assert.equal(medium.stellarVolumeResolution, 64); assert.equal(medium.stellarVolumeTexels.length, 64 ** 3);
  const size = medium.stellarVolumeResolution, values = [], baselineValues = [];
  let integrated = 0, shapeDifference = 0;
  for (let cell = 0; cell < medium.stellarVolumeTexels.length; cell++) {
    const density = medium.stellarVolumeTexels[cell];
    assert.ok(Number.isFinite(density) && density >= 0);
    integrated += density * medium.bulgePixelVolume;
    shapeDifference += Math.abs(density - other.stellarVolumeTexels[cell]) * medium.bulgePixelVolume;
    const x = cell % size, y = Math.floor(cell / size) % size, z = Math.floor(cell / (size * size));
    if (x === 0 || y === 0 || z === 0 || x === size - 1 || y === size - 1 || z === size - 1) assert.equal(density, 0);
    const r = Math.hypot((x + .5) * 2 / size - 1, (y + .5) * 2 / size - 1, (z + .5) * 2 / size - 1);
    if (r > .2 && r < .7) { values.push(density); baselineValues.push(smooth.stellarVolumeTexels[cell]); }
  }
  assert.equal(integrated, medium.bulgeTableLuminosity);
  assert.ok(Math.abs(integrated / medium.bulgeLuminosity - 1) < 2e-7);
  assert.ok(shapeDifference / medium.bulgeLuminosity > .05);
  values.sort((a, b) => a - b); baselineValues.sort((a, b) => a - b);
  const span = array => array[Math.floor(array.length * .9)] / array[Math.floor(array.length * .1)];
  assert.ok(span(values) > span(baselineValues));
  for (const bulgeContrast of [-.01, 1.01, NaN]) assert.throws(() => createGalacticMedium({...options, bulgeContrast}));
});

test('3D bulge proxies follow the trilinear measure including tent variance and stable prefixes', () => {
  const medium = createGalacticMedium({seed: 'bulge-trilinear-moments', resolution: 32, bulgeFraction: 1, dustOpticalDepth: 0, bulgeContrast: .85, bulgeCenter: [.08, -.04, .06], bulgeAxes: [.37, .17, .26]});
  const stars = sampleGalacticStars(medium, 'bulge-tent-stream', 4096), prefix = sampleGalacticStars(medium, 'bulge-tent-stream', 211);
  for (const key of Object.keys(stars)) assert.deepEqual(prefix[key], stars[key].slice(0, prefix[key].length));
  const expectedMean = [0, 0, 0], expectedSecond = [0, 0, 0], actualMean = [0, 0, 0], actualSecond = [0, 0, 0];
  const size = medium.stellarVolumeResolution, step = 2 / size;
  let expectedCross = 0, actualCross = 0;
  for (let cell = 0; cell < medium.stellarVolumeTexels.length; cell++) {
    const weight = medium.stellarVolumeTexels[cell] * medium.bulgePixelVolume / medium.bulgeTableLuminosity;
    const coordinates = [cell % size, Math.floor(cell / size) % size, Math.floor(cell / (size * size))].map(i => (i + .5) * step - 1);
    for (let axis = 0; axis < 3; axis++) {
      expectedMean[axis] += coordinates[axis] * weight;
      expectedSecond[axis] += (coordinates[axis] ** 2 + step * step / 6) * weight;
    }
    expectedCross += coordinates[0] * coordinates[1] * weight;
  }
  const sampled = output(), point = [0, 0, 0];
  for (let i = 0; i < 4096; i++) {
    assert.equal(stars.componentIndices[i], 2);
    const q = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      point[axis] = stars.positions[i * 3 + axis]; q[axis] = (point[axis] - medium.bulgeCenter[axis]) / medium.bulgeAxes[axis];
      actualMean[axis] += q[axis] / 4096; actualSecond[axis] += q[axis] ** 2 / 4096;
    }
    actualCross += q[0] * q[1] / 4096;
    assert.ok(Math.hypot(...point) <= medium.supportRadius); assert.ok(Math.hypot(...q) < 1);
    sampleGalacticMedium(medium, point, sampled); assert.ok(power(sampled.emission) > 0);
    assert.ok(Math.abs(power(stars.colors, i * 3) - 1) < 8e-8);
  }
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(actualMean[axis] - expectedMean[axis]) < .02);
    assert.ok(Math.abs(actualSecond[axis] - expectedSecond[axis]) < .01);
  }
  assert.ok(Math.abs(actualCross - expectedCross) < .01);
});

test('the trilinear bulge is continuous and truly finite without the old analytic profile', () => {
  const medium = createGalacticMedium({seed: 'bulge-boundary', resolution: 32, bulgeFraction: 1, dustOpticalDepth: 0, bulgeCenter: [.08, -.04, .06]});
  const point = [0, 0, 0], sampled = output(), left = output(), right = output();
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) for (const scale of [1, 1 - 1e-8, 1 + 1e-8]) {
    point.splice(0, 3, ...medium.bulgeCenter); point[axis] += sign * scale * medium.bulgeAxes[axis];
    sampleGalacticMedium(medium, point, sampled); assert.deepEqual(sampled, output());
  }
  let peak = 0;
  for (let i = 1; i < medium.stellarVolumeTexels.length; i++) if (medium.stellarVolumeTexels[i] > medium.stellarVolumeTexels[peak]) peak = i;
  const size = medium.stellarVolumeResolution, grid = [peak % size, Math.floor(peak / size) % size, Math.floor(peak / (size * size))];
  for (let axis = 0; axis < 3; axis++) point[axis] = medium.bulgeCenter[axis] + ((grid[axis] + .5) * 2 / size - 1) * medium.bulgeAxes[axis];
  const center = [...point];
  for (let axis = 0; axis < 3; axis++) {
    point[axis] = center[axis] - medium.bulgeAxes[axis] * 1e-7; sampleGalacticMedium(medium, point, left);
    point[axis] = center[axis] + medium.bulgeAxes[axis] * 1e-7; sampleGalacticMedium(medium, point, right);
    assert.ok(Math.abs(power(left.emission) - power(right.emission)) / medium.stellarVolumeTexels[peak] < 1e-4);
    point[axis] = center[axis];
  }
});

test('central 3D dust redistributes the existing optical mass without changing light or proxies', () => {
  const options = {seed: 'redistributed-dust', resolution: 32, dustOpticalDepth: .18, dustWarp: .024, dustHeightVariation: .65, dustHeight: .025};
  const original = createGalacticMedium(options), split = createGalacticMedium({...options, dustCloudFraction: .37}), clouds = createGalacticMedium({...options, dustCloudFraction: 1});
  assert.equal('bulgeTexels' in original, false); assert.equal('bulgeResolution' in original, false);
  assert.equal('volumeTexels' in original, false); assert.equal('volumeResolution' in original, false);
  const population = sampleGalacticStars(original, 'dust-does-not-change-stars', 4096);
  for (const medium of [original, split, clouds]) {
    assert.equal(medium.dustIntegral, original.dustIntegral);
    assert.deepEqual(sampleGalacticStars(medium, 'dust-does-not-change-stars', 4096), population);
    assert.equal(medium.stellarVolumeResolution, 64); assert.equal(medium.stellarVolumeTexels.length, 64 ** 3);
    let diskMass = 0;
    for (let cell = 0; cell < medium.resolution ** 2; cell++) {
      for (let c = 0; c < 3; c++) assert.equal(medium.texels[cell * 4 + c], original.texels[cell * 4 + c]);
      diskMass += medium.texels[cell * 4 + 3] * medium.pixelArea;
    }
    const cloudMass = volumeChannelSum(medium, 1) * medium.dustCloudPixelVolume;
    assert.ok(Math.abs((diskMass + cloudMass) / original.dustIntegral - 1) < 1e-6);
    assert.ok(Math.abs(diskMass / original.dustIntegral - (1 - medium.dustCloudFraction)) < 1e-6);
    assert.ok(Math.abs(cloudMass / original.dustIntegral - medium.dustCloudFraction) < 1e-6);
    assert.ok(Math.abs(cloudMass - medium.dustCloudIntegral) < original.dustIntegral * 1e-12);
    assert.deepEqual(medium.stellarVolumeTexels, original.stellarVolumeTexels);
    assert.ok(Object.isFrozen(medium.dustCloudCenter) && Object.isFrozen(medium.dustCloudAxes));
    assert.ok(medium.dustCloudAxes.every(n => Number.isFinite(n) && n > 0));
  }
  assert.equal(original.dustCloudIntegral, 0); assert.equal(volumeChannelSum(original, 1), 0);
  assert.ok(split.dustVerticalBound >= Math.abs(split.dustCloudCenter[1]) + split.dustCloudAxes[1]);
  for (const dustCloudFraction of [-.01, 1.01, NaN]) assert.throws(() => createGalacticMedium({...options, dustCloudFraction}));
});

test('seeded fractured sheets remain sparse, finite and above and below the disk rather than a screen curtain', () => {
  const options = {seed: 'dust-spur-shape', resolution: 32, dustCloudFraction: .6};
  const medium = createGalacticMedium(options), same = createGalacticMedium({...options, cameraPosition: [20, -10, 3]});
  const other = createGalacticMedium({...options, seed: 'different-dust-spur-shape'});
  assert.deepEqual(medium.dustVolumeTexels, same.dustVolumeTexels); assert.deepEqual(medium.dustCloudCenter, same.dustCloudCenter);
  assert.notDeepEqual(medium.dustVolumeTexels, other.dustVolumeTexels); assert.notDeepEqual(medium.dustCloudCenter, other.dustCloudCenter);
  assert.ok(medium.dustSheetRailLength >= .5 && medium.dustSheetRailLength <= .8);
  assert.ok(medium.dustSheetTriangleCount >= 24 && medium.dustSheetTriangleCount <= 40);
  let active = 0, positiveHeightMass = 0, negativeHeightMass = 0;
  const size = medium.dustVolumeResolution;
  for (let cell = 0; cell < size ** 3; cell++) {
    const value = medium.dustVolumeTexels[cell], x = cell % size, y = Math.floor(cell / size) % size, z = Math.floor(cell / (size * size));
    assert.ok(Number.isFinite(value) && value >= 0); if (value > 0) active++;
    if (x === 0 || y === 0 || z === 0 || x === size - 1 || y === size - 1 || z === size - 1) assert.equal(value, 0);
    const physicalY = medium.dustCloudCenter[1] + ((y + .5) * 2 / size - 1) * medium.dustCloudAxes[1];
    if (physicalY > .04) positiveHeightMass += value * medium.dustCloudPixelVolume;
    if (physicalY < -.04) negativeHeightMass += value * medium.dustCloudPixelVolume;
  }
  assert.ok(active / size ** 3 > .002 && active / size ** 3 < .08);
  assert.ok(positiveHeightMass / medium.dustCloudIntegral > .05 && negativeHeightMass / medium.dustCloudIntegral > .05);
  assert.ok(medium.supportRadius <= 1);
});

test('trilinear cloud extinction integrates to the allocated optical mass and has continuous finite boundaries', () => {
  const medium = createGalacticMedium({seed: 'cloud-volume-integral', resolution: 32, dustCloudFraction: 1, dustOpticalDepth: .18});
  const sampled = output(), point = [0, 0, 0], size = medium.dustVolumeResolution, steps = size - 1;
  const voxelVolume = 8 * medium.dustCloudAxes[0] * medium.dustCloudAxes[1] * medium.dustCloudAxes[2] / size ** 3;
  let mass = 0;
  for (let iz = 0; iz < steps; iz++) for (let iy = 0; iy < steps; iy++) for (let ix = 0; ix < steps; ix++) {
    point[0] = medium.dustCloudCenter[0] + ((ix + 1) * 2 / size - 1) * medium.dustCloudAxes[0];
    point[1] = medium.dustCloudCenter[1] + ((iy + 1) * 2 / size - 1) * medium.dustCloudAxes[1];
    point[2] = medium.dustCloudCenter[2] + ((iz + 1) * 2 / size - 1) * medium.dustCloudAxes[2];
    sampleGalacticMedium(medium, point, sampled); mass += sampled.extinction[1] / medium.extinctionColor[1] * voxelVolume;
  }
  assert.ok(Math.abs(mass / medium.dustCloudIntegral - 1) < 1e-6);
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    for (let a = 0; a < 3; a++) point[a] = medium.dustCloudCenter[a];
    point[axis] += sign * medium.dustCloudAxes[axis] * (1 - 1e-8);
    sampleGalacticMedium(medium, point, sampled); assert.deepEqual(sampled.extinction, [0, 0, 0]);
    point[axis] += sign * medium.dustCloudAxes[axis] * 2e-8;
    sampleGalacticMedium(medium, point, sampled); assert.deepEqual(sampled.extinction, [0, 0, 0]);
  }
  for (let i = 0; i < 512; i++) {
    const y = 2 * (i + .5) / 512 - 1, planar = Math.sqrt(1 - y * y), angle = i * 2.399963, r = medium.supportRadius + 1e-8;
    point[0] = r * planar * Math.cos(angle); point[1] = r * y; point[2] = r * planar * Math.sin(angle);
    sampleGalacticMedium(medium, point, sampled); assert.deepEqual(sampled, output());
  }
});

test('revision 2 preserves original dust A, vertical geometry and both 3D tables byte for byte', () => {
  const options = {seed: 'stellar-preservation-v1', resolution: 32, totalLuminosity: .022, bulgeFraction: .22, bulgeContrast: .2, dustCloudFraction: .75, populationContrast: .6, dustContrast: .85};
  const medium = createGalacticMedium(options);
  const hash = array => createHash('sha256').update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
  assert.equal(hash(medium.dustVolumeTexels), '955130a4f3de66f2c7efb4000fd220d21e1e18f3ed61848b82f6cb4d11878022');
  assert.equal(hash(medium.stellarVolumeTexels), 'eb4cbe9dafcfb5f2af60112cb9090d5ecdcdb8c323d99eab17b89702539d3ae0');
  assert.equal(hash(medium.verticalGeometry), 'b07ecf190ff88d8e8763cdba9209556146b8f36512dee425f13baaddfce4e63d');
  const dustA = new Float32Array(medium.resolution ** 2), rgb = [0, 0, 0];
  for (let cell = 0; cell < dustA.length; cell++) {
    const i = cell * 4; dustA[cell] = medium.texels[i + 3]; assert.equal(medium.texels[i + 2], 0);
    for (let c = 0; c < 3; c++) rgb[c] += (medium.texels[i] * medium.oldStellarColor[c] + medium.texels[i + 1] * medium.youngStellarColor[c]) * medium.pixelArea;
  }
  assert.equal(hash(dustA), '19419be0b59a9288441e36fa7c3d300f63f9ed6d0be4f0103ea8bce563c827a1');
  // Integrated RGB from the preceding revision, before the representation
  // change. Spatial filtering must not change either population's spectrum.
  const originalRGB = [.01956658169062933, .01679257258571054, .013713252255501032];
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(rgb[c] / originalRGB[c] - 1) < 2e-7);
  assert.equal(medium.revision, 2); assert.equal(medium.dustIntegral, .23742154977409974);
  assert.equal(medium.youngStellarHeight, medium.stellarHeight / 4);
  assert.ok(Math.abs(medium.oldTableLuminosity / medium.oldDiskLuminosity - 1) < 2e-7);
  assert.ok(Math.abs(medium.youngTableLuminosity / medium.youngDiskLuminosity - 1) < 2e-7);
  assert.equal(medium.stellarVolumeResolution, GALACTIC_MEDIUM_STELLAR_VOLUME_RESOLUTION);
  assert.equal(medium.dustVolumeResolution, GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION);
  assert.equal(medium.dustVolumeTexels.length, medium.dustVolumeResolution ** 3);
});

test('folded sheets retain connected patches, substantial real openings and continuous fine boundaries', () => {
  const medium = createGalacticMedium({seed: 'dust-spur-shape', resolution: 32, dustCloudFraction: 1});
  const data = medium.dustVolumeTexels, n = medium.dustVolumeResolution, remaining = new Set();
  let total = 0, peak = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > 0) { remaining.add(i); total += data[i]; if (data[i] > data[peak]) peak = i; }
  const masses = [];
  // Actual occupied-volume connectivity; no assertions about noise literals or
  // the segment construction. Tiny isolated fragments cannot satisfy the test.
  while (remaining.size) {
    const first = remaining.values().next().value, queue = [first]; remaining.delete(first);
    let mass = 0;
    for (let i = 0; i < queue.length; i++) {
      const cell = queue[i], x = cell % n, y = Math.floor(cell / n) % n, z = Math.floor(cell / (n * n)); mass += data[cell];
      for (const next of [x > 0 ? cell - 1 : -1, x < n - 1 ? cell + 1 : -1, y > 0 ? cell - n : -1, y < n - 1 ? cell + n : -1, z > 0 ? cell - n * n : -1, z < n - 1 ? cell + n * n : -1]) if (remaining.delete(next)) queue.push(next);
    }
    masses.push(mass / total);
  }
  assert.ok(Math.max(...masses) > .4, 'a connected main patch must survive spatial naturalization');
  assert.ok(masses.filter(mass => mass > .05).length >= 3, 'real separated complexes must carry meaningful optical mass');
  const grid = [peak % n, Math.floor(peak / n) % n, Math.floor(peak / (n * n))];
  const center = grid.map((value, axis) => medium.dustCloudCenter[axis] + ((value + .5) * 2 / n - 1) * medium.dustCloudAxes[axis]);
  // A local occupied-volume covariance tests the primitive itself: two
  // broad in-plane directions and a much thinner third direction. A noisy
  // circular tube can pass connectivity tests but cannot satisfy this shape.
  const radius = .025, sums = [0, 0, 0], moments = [0, 0, 0, 0, 0, 0];
  let localMass = 0;
  for (let cell = 0; cell < data.length; cell++) if (data[cell] > 0) {
    const grid = [cell % n, Math.floor(cell / n) % n, Math.floor(cell / (n * n))];
    const d = grid.map((value, axis) => medium.dustCloudCenter[axis] + ((value + .5) * 2 / n - 1) * medium.dustCloudAxes[axis] - center[axis]);
    if (Math.hypot(...d) > radius) continue;
    const w = data[cell]; localMass += w;
    for (let axis = 0; axis < 3; axis++) sums[axis] += w * d[axis];
    for (const [i, x, y] of [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 0, 1], [4, 0, 2], [5, 1, 2]]) moments[i] += w * d[x] * d[y];
  }
  const mean = sums.map(value => value / localMass);
  for (const [i, x, y] of [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 0, 1], [4, 0, 2], [5, 1, 2]]) moments[i] = moments[i] / localMass - mean[x] * mean[y];
  const [a, d, f, b, c, e] = moments, q = (a + d + f) / 3;
  const scale = Math.sqrt(((a - q) ** 2 + (d - q) ** 2 + (f - q) ** 2 + 2 * (b * b + c * c + e * e)) / 6);
  const aa = (a - q) / scale, dd = (d - q) / scale, ff = (f - q) / scale, bb = b / scale, cc = c / scale, ee = e / scale;
  const determinant = aa * dd * ff + 2 * bb * cc * ee - aa * ee * ee - dd * cc * cc - ff * bb * bb;
  const angle = Math.acos(Math.max(-1, Math.min(1, determinant / 2))) / 3;
  const largest = q + 2 * scale * Math.cos(angle), smallest = q + 2 * scale * Math.cos(angle + 2 * Math.PI / 3), middle = 3 * q - largest - smallest;
  assert.ok(smallest / middle < .2, 'the local normal thickness must be small compared with the sheet plane');
  assert.ok(middle / largest > .5, 'the local support must span a plane rather than a line');
  const point = [...center], left = output(), right = output();
  for (let axis = 0; axis < 3; axis++) {
    point[axis] = center[axis] - medium.dustCloudAxes[axis] * 1e-7; sampleGalacticMedium(medium, point, left);
    point[axis] = center[axis] + medium.dustCloudAxes[axis] * 1e-7; sampleGalacticMedium(medium, point, right);
    assert.ok(Math.abs(left.extinction[1] - right.extinction[1]) / (data[peak] * medium.extinctionColor[1]) < 1e-4);
    point[axis] = center[axis];
  }
});


test('cloud vertical scale is a column-preserving world affine transform including warped detail', () => {
  const options = {seed: 'cloud-affine-scale', resolution: 32, dustCloudFraction: 1};
  const original = createGalacticMedium(options), scale = .3;
  const scaled = createGalacticMedium({...options, dustCloudVerticalScale: scale});
  for (const key of ['texels', 'verticalGeometry', 'stellarVolumeTexels']) assert.deepEqual(scaled[key], original[key]);
  assert.equal(scaled.dustCloudCenter[1], original.dustCloudCenter[1] * scale);
  assert.equal(scaled.dustCloudAxes[1], original.dustCloudAxes[1] * scale);
  assert.equal(scaled.dustCloudPixelVolume, original.dustCloudPixelVolume * scale);
  assert.ok(Math.abs(scaled.dustCloudIntegral / original.dustCloudIntegral - 1) < 1e-7);
  assert.ok(scaled.supportRadius <= original.supportRadius);
  let mass = 0, samples = 0;
  const n = original.dustVolumeResolution, point = [0, 0, 0], transformed = [0, 0, 0], a = output(), b = output();
  for (let i = 0; i < original.dustVolumeTexels.length; i++) {
    mass += scaled.dustVolumeTexels[i] * scaled.dustCloudPixelVolume;
    if (original.dustVolumeTexels[i] <= 0 || i % 97 !== 0) continue;
    // Off-center samples exercise trilinear interpolation, not just texel equality.
    const grid = [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))];
    for (let axis = 0; axis < 3; axis++) point[axis] = original.dustCloudCenter[axis] + ((grid[axis] + .73) * 2 / n - 1) * original.dustCloudAxes[axis];
    transformed[0] = point[0]; transformed[1] = point[1] * scale; transformed[2] = point[2];
    sampleGalacticMedium(original, point, a); sampleGalacticMedium(scaled, transformed, b);
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(b.extinction[axis] * scale - a.extinction[axis]) < 2e-7 * Math.max(1, a.extinction[axis]));
    samples++;
  }
  assert.ok(samples > 100);
  assert.ok(Math.abs(mass / original.dustIntegral - 1) < 1e-7);
  for (let i = 0; i < 128; i++) {
    const y = 2 * (i + .5) / 128 - 1, radius = scaled.supportRadius + 1e-7, planar = Math.sqrt(1 - y * y), angle = i * 2.399963;
    point[0] = radius * planar * Math.cos(angle); point[1] = radius * y; point[2] = radius * planar * Math.sin(angle);
    sampleGalacticMedium(scaled, point, b); assert.deepEqual(b, output());
  }
  const stars = sampleGalacticStars(original, 'affine-stars', 4096), transformedStars = sampleGalacticStars(scaled, 'affine-stars', 4096);
  assert.deepEqual(transformedStars, stars);
  for (const value of [0, .099, 2.001, NaN, Infinity]) assert.throws(() => createGalacticMedium({...options, dustCloudVerticalScale: value}), RangeError);
});

test('resumable creation shares every table and sampling CDF with synchronous creation under arbitrary budgets', () => {
  const options = {seed: 'task-equivalence', resolution: 32, dustCloudFraction: .75, dustWarp: .024, stellarHeightVariation: .65};
  for (const dustCloudVerticalScale of [1, .3]) {
    const descriptor = {...options, dustCloudVerticalScale}, synchronous = createGalacticMedium(descriptor), task = createGalacticMediumTask(descriptor);
    assert.equal(task.result, undefined); assert.equal(task.state, 'pending');
    let advances = 0;
    while (task.state === 'pending') { assert.equal(task.result, undefined); task.advance([.01, .07, .3, 2][advances++ % 4]); }
    assert.ok(advances > 10); assert.equal(task.state, 'complete'); assert.ok(Object.isFrozen(task.result));
    assert.deepEqual(task.result, synchronous);
    // Private CDFs are exercised by component choice, tent positions and all powers.
    assert.deepEqual(sampleGalacticStars(task.result, 'task-proxies', 4096), sampleGalacticStars(synchronous, 'task-proxies', 4096));
    assert.equal(task.cancel(), false); assert.equal(task.advance(2), true);
  }
});

test('creation task snapshots inputs, publishes only completion and has terminal cancellation and failure', () => {
  const options = {seed: 'task-lifecycle', resolution: 32, dustCloudFraction: .75, bulgeAxes: [.3, .15, .23], palette: {old: [1, .76, .48], young: [.65, .8, 1], dust: [.72, 1, 1.45]}};
  const task = createGalacticMediumTask(options), expected = createGalacticMedium(options);
  options.bulgeAxes[0] = .1; options.palette.old[0] = 4;
  task.advance(Infinity); assert.deepEqual(task.result, expected);
  const cancelled = createGalacticMediumTask({seed: 'cancel-after-source', resolution: 32, dustCloudFraction: .75});
  while (cancelled.stage !== 'dust-resample') assert.equal(cancelled.step(), false);
  assert.equal(cancelled.result, undefined); assert.equal(cancelled.cancel(), true); assert.equal(cancelled.cancel(), false);
  const chunks = cancelled.metrics.chunks;
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.advance(Infinity), true); assert.equal(cancelled.result, undefined); assert.equal(cancelled.metrics.chunks, chunks);
  const bad = createGalacticMediumTask({seed: 'bad-input', resolution: 31});
  for (const budget of [0, -1, NaN, -Infinity]) assert.throws(() => bad.advance(budget), RangeError);
  let cause; try { bad.advance(Infinity); } catch (error) { cause = error; }
  assert.ok(cause instanceof RangeError); assert.equal(bad.error, cause); assert.equal(bad.state, 'failed'); assert.equal(bad.result, undefined); assert.equal(bad.cancel(), false);
});


test('mature low-pass keeps both populations and spectra budgets while widening compact features at fixed thickness', () => {
  const options = {seed: 'old-population-lowpass', resolution: 128, bulgeFraction: 0};
  // At this resolution .003 has a zero-radius discrete 3-sigma kernel;
  // it supplies the unfiltered O column without a production bypass switch.
  const raw = createGalacticMedium({...options, stellarHeight: .003});
  const filtered = createGalacticMedium({...options, stellarHeight: .035});
  assert.equal(raw.oldDiskLuminosity, filtered.oldDiskLuminosity);
  assert.equal(raw.youngDiskLuminosity, filtered.youngDiskLuminosity);
  assert.deepEqual(raw.verticalGeometry, filtered.verticalGeometry);
  assert.deepEqual(raw.stellarVolumeTexels, filtered.stellarVolumeTexels);
  for (let i = 0; i < raw.texels.length; i += 4) {
    assert.equal(raw.texels[i + 1], filtered.texels[i + 1]); assert.equal(raw.texels[i + 3], filtered.texels[i + 3]);
    assert.equal(filtered.texels[i + 2], 0);
  }
  function shape(medium) {
    const n = medium.resolution, step = 2 / n; let energy = 0, gradient = 0, peak = 0;
    for (let z = 1; z < n - 1; z++) for (let x = 1; x < n - 1; x++) {
      const i = (z * n + x) * 4, value = medium.texels[i]; energy += value * value;
      gradient += (value - medium.texels[i + 4]) ** 2 + (value - medium.texels[i + 4 * n]) ** 2;
      if (value > medium.texels[peak]) peak = i;
    }
    const value = medium.texels[peak], laplacian = (medium.texels[peak - 4] + medium.texels[peak + 4] + medium.texels[peak - 4 * n] + medium.texels[peak + 4 * n] - 4 * value) / step ** 2;
    return {highFrequency: gradient / energy, peakLateralSigma: Math.sqrt(-2 * value / laplacian)};
  }
  const a = shape(raw), b = shape(filtered);
  assert.ok(b.highFrequency < a.highFrequency * .2);
  assert.ok(b.peakLateralSigma > a.peakLateralSigma * 2);
  // Compare the two column shapes at the SAME mature thickness. This is an
  // aspect diagnostic, not a claim that the .003 medium has that thickness.
  const verticalSigma = filtered.stellarHeight / Math.sqrt(7);
  assert.ok(verticalSigma / b.peakLateralSigma < .5);
  assert.ok(verticalSigma / b.peakLateralSigma < (verticalSigma / a.peakLateralSigma) * .5);
  for (const medium of [raw, filtered]) {
    assert.ok(Math.abs(medium.oldTableLuminosity / medium.oldDiskLuminosity - 1) < 2e-7);
    assert.ok(Math.abs(medium.youngTableLuminosity / medium.youngDiskLuminosity - 1) < 2e-7);
    assert.ok(Math.abs(power(medium.oldStellarColor) - 1) < 1e-14); assert.ok(Math.abs(power(medium.youngStellarColor) - 1) < 1e-14);
  }
});

test('proxy population posterior and separate vertical measures match the two-column field', () => {
  const medium = createGalacticMedium({seed: 'population-posterior', resolution: 96, bulgeFraction: 0, stellarWarp: .06, stellarHeightVariation: .7});
  const stars = sampleGalacticStars(medium, 'population-posterior-stream', 4096), prefix = sampleGalacticStars(medium, 'population-posterior-stream', 257);
  for (const key of Object.keys(stars)) assert.deepEqual(prefix[key], stars[key].slice(0, prefix[key].length));
  const bins = Array.from({length: 5}, () => ({n: 0, observed: 0, expected: 0, variance: 0}));
  const counts = [0, 0], mean = [0, 0], second = [0, 0]; let actualYoungX = 0, expectedYoungX = 0;
  for (let cell = 0; cell < medium.resolution ** 2; cell++) expectedYoungX += ((cell % medium.resolution + .5) * 2 / medium.resolution - 1) * medium.texels[cell * 4 + 1] * medium.pixelArea / medium.tableLuminosity;
  for (let i = 0; i < 4096; i++) {
    const component = stars.componentIndices[i], offset = i * 3, g = interpolatedStellar(medium, stars.positions[offset], stars.positions[offset + 2]);
    assert.ok(component === 0 || component === 1);
    const probability = g.youngColumn / (g.oldColumn + g.youngColumn), bin = bins[Math.min(4, Math.floor(probability * 5))];
    bin.n++; bin.observed += component; bin.expected += probability; bin.variance += probability * (1 - probability);
    const height = component === 1 ? g.youngHeight : g.height, t = (stars.positions[offset + 1] - g.offset) / height;
    assert.ok(Math.abs(t) <= 1); counts[component]++; mean[component] += t; second[component] += t * t;
    const color = component === 1 ? medium.youngStellarColor : medium.oldStellarColor;
    for (let c = 0; c < 3; c++) assert.equal(stars.colors[offset + c], Math.fround(color[c]));
    if (component === 1) actualYoungX += stars.positions[offset] / 4096;
  }
  for (const bin of bins) if (bin.n > 32) assert.ok(Math.abs(bin.observed - bin.expected) < 5 * Math.sqrt(bin.variance) + 1);
  assert.ok(Math.abs(counts[1] / 4096 - medium.youngTableLuminosity / medium.tableLuminosity) < .025);
  assert.ok(Math.abs(actualYoungX - expectedYoungX) < .018);
  for (let c = 0; c < 2; c++) { assert.ok(counts[c] > 200); assert.ok(Math.abs(mean[c] / counts[c]) < .04); assert.ok(Math.abs(second[c] / counts[c] / (1 / 7) - 1) < .15); }
});
