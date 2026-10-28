import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeStarFlux, starLinearColor } from '../src/star-photometry.js';
import { stellarPixelEnergy, stellarPsfSupportPixels } from '../src/render/stellar-psf.js';

test('magnitudes preserve logarithmic received flux and reject invalid inputs', () => {
  assert.equal(relativeStarFlux(6), 1);
  for (const magnitude of [-25, -5, 0, 6, 15, 50]) {
    assert.ok(Math.abs(relativeStarFlux(magnitude + 5) / relativeStarFlux(magnitude) - .01) < 1e-15);
    assert.ok(relativeStarFlux(magnitude + 1) < relativeStarFlux(magnitude));
    assert.ok(Number.isFinite(relativeStarFlux(magnitude)));
  }
  for (const invalid of [NaN, Infinity, -Infinity, '5', null]) {
    assert.throws(() => relativeStarFlux(invalid), RangeError);
    assert.throws(() => relativeStarFlux(6, invalid), RangeError);
  }
  assert.equal(relativeStarFlux(10000), 0);
  assert.throws(() => relativeStarFlux(-10000), RangeError);
});

test('broad Planck bands give continuous warm/cool colors with a reusable Y=1 output', () => {
  const output = new Float64Array(3);
  assert.equal(starLinearColor(6500, output), output);
  for (const channel of output) assert.ok(Math.abs(channel - 1) < 1e-14);
  const warm = starLinearColor(2500), cool = starLinearColor(20000);
  assert.ok(warm[0] > warm[1] && warm[1] > warm[2]);
  assert.ok(cool[2] > cool[1] && cool[1] > cool[0]);
  for (const temperature of [Number.MIN_VALUE, 1e-250, 1, 500, 2500, 6499, 6500, 6501, 20000, 1e100, Number.MAX_VALUE]) {
    const color = starLinearColor(temperature);
    assert.ok(color.every(channel => Number.isFinite(channel) && channel >= 0));
    assert.ok(Math.abs(.2126 * color[0] + .7152 * color[1] + .0722 * color[2] - 1) < 1e-14);
  }
  for (let temperature = 1000; temperature <= 40000; temperature += 113) {
    const a = starLinearColor(temperature), b = starLinearColor(temperature + .001);
    assert.ok(a.every((channel, i) => Math.abs(channel - b[i]) < 1e-5));
  }
  for (const invalid of [0, -1, NaN, Infinity, '6500']) assert.throws(() => starLinearColor(invalid), RangeError);
});

// Independent reference: composite Simpson integration of the Gaussian density,
// not an erf/CDF approximation. Two resolutions establish reference convergence.
function integrateAxis(center, sigma, steps) {
  const low = center - .5, h = 1 / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const x = low + h * i;
    const weight = i === 0 || i === steps ? 1 : i % 2 === 0 ? 2 : 4;
    sum += weight * Math.exp(-.5 * (x / sigma) ** 2) / (Math.sqrt(2 * Math.PI) * sigma);
  }
  return sum * h / 3;
}

function referencePixel(x, y, ratio, steps) {
  return .97 * integrateAxis(x, .65 * ratio, steps) * integrateAxis(y, .65 * ratio, steps)
    + .03 * integrateAxis(x, 2.2 * ratio, steps) * integrateAxis(y, 2.2 * ratio, steps);
}

test('pixel-integrated PSF conserves flux and centroid across phases and DPR against converged quadrature', () => {
  for (const ratio of [1, 2]) for (const [phaseX, phaseY] of [[0, 0], [.125, .375], [.499, -.499]]) {
    const half = stellarPsfSupportPixels(ratio) / 2;
    let sum = 0, refSum = 0, centroidX = 0, centroidY = 0, refCentroidX = 0, refCentroidY = 0;
    for (let iy = 0; iy < half * 2; iy++) for (let ix = 0; ix < half * 2; ix++) {
      const x = ix - half + .5 - phaseX, y = iy - half + .5 - phaseY;
      const actual = stellarPixelEnergy(x, y, ratio);
      const reference = referencePixel(x, y, ratio, 256);
      const coarse = referencePixel(x, y, ratio, 128);
      assert.ok(Math.abs(reference - coarse) < 2e-10, 'quadrature must converge');
      assert.ok(actual >= 0 && Number.isFinite(actual));
      assert.ok(Math.abs(actual - reference) < 2e-7, `pixel mismatch at ${x}, ${y}, DPR ${ratio}`);
      sum += actual; refSum += reference;
      centroidX += x * actual; centroidY += y * actual;
      refCentroidX += x * reference; refCentroidY += y * reference;
    }
    assert.ok(Math.abs(sum - 1) < 9e-6, `flux ${sum}`);
    assert.ok(Math.abs(sum - refSum) < 1e-7);
    assert.ok(Math.abs(centroidX / sum - refCentroidX / refSum) < 2e-7);
    assert.ok(Math.abs(centroidY / sum - refCentroidY / refSum) < 2e-7);
    // Pixel-center quantization has a small phase bias even for the exact PSF.
    assert.ok(Math.abs(centroidX / sum) < .0002);
    assert.ok(Math.abs(centroidY / sum) < .0002);
  }
});

test('PSF tails retain finite positive energy and reflection symmetry', () => {
  for (const ratio of [1, 2]) for (const x of [0, .5, 3, 8, 12, 20]) {
    const energy = stellarPixelEnergy(x, x / 3, ratio);
    assert.ok(Number.isFinite(energy) && energy > 0);
    assert.equal(energy, stellarPixelEnergy(-x, -x / 3, ratio));
  }
});
