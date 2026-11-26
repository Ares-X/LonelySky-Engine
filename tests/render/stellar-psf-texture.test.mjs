import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {stellarPixelEnergy, stellarPsfSupportPixels} from '../../src/render/stellar-psf.js';
import {createStellarPsfTexture, STELLAR_PSF_AXIS_SAMPLES} from '../../src/render/stellar-psf-texture.js';

// CPU emulation of table fetch and highp float interpolation. The reference
// remains the original erfc pixel-box formula, independently of this lookup.
const f32 = Math.fround;
function lookupAxis(psf, x, channel) {
  const data = psf.texture.image.data;
  const coordinate = Math.min(f32(Math.abs(f32(x)) * f32(psf.uniforms.stellarPsfAxisScale.value)), STELLAR_PSF_AXIS_SAMPLES - 1);
  const lower = Math.min(Math.trunc(coordinate), STELLAR_PSF_AXIS_SAMPLES - 2), weight = f32(coordinate - lower);
  return f32(f32(data[lower * 2 + channel] * f32(1 - weight)) + f32(data[(lower + 1) * 2 + channel] * weight));
}
function lookupEnergy(psf, x, y) {
  const core = f32(f32(f32(.97) * lookupAxis(psf, x, 0)) * lookupAxis(psf, y, 0));
  const halo = f32(f32(f32(.03) * lookupAxis(psf, x, 1)) * lookupAxis(psf, y, 1));
  return f32(core + halo);
}

test('lookup preserves the original pixel-box PSF and single-star flux across DPR and subpixel phases', t => {
  const psf = createStellarPsfTexture(), results = [];
  try {
    for (const ratio of [.5, .75, 1, 1.25, 1.5, 2, 3]) {
      psf.setPixelRatio(ratio);
      const support = stellarPsfSupportPixels(ratio), half = support * .5;
      let maxPixelError = 0, maxFluxError = 0, maxUnitFluxError = 0;
      for (let phaseX = 0; phaseX < 32; phaseX++) for (let phaseY = 0; phaseY < 32; phaseY++) {
        let flux = 0, referenceFlux = 0;
        for (let iy = -1; iy <= support; iy++) for (let ix = -1; ix <= support; ix++) {
          const x = ix - half + .5 - phaseX / 32, y = iy - half + .5 - phaseY / 32;
          if (x < -half || x >= half || y < -half || y >= half) continue;
          const actual = lookupEnergy(psf, x, y), reference = stellarPixelEnergy(x, y, ratio);
          assert.ok(Number.isFinite(actual) && actual >= 0);
          maxPixelError = Math.max(maxPixelError, Math.abs(actual - reference));
          flux += actual; referenceFlux += reference;
        }
        maxFluxError = Math.max(maxFluxError, Math.abs(flux - referenceFlux));
        maxUnitFluxError = Math.max(maxUnitFluxError, Math.abs(flux - 1));
      }
      // Sweep interval interiors and both texture-row boundaries as well as
      // the lattice above; its fixed physical offsets do not assume texel centers.
      for (let i = 0; i <= 16384; i++) {
        const x = i / 16384 * half;
        for (const y of [0, .25, .5, x]) {
          maxPixelError = Math.max(maxPixelError, Math.abs(lookupEnergy(psf, x, y) - stellarPixelEnergy(x, y, ratio)));
        }
      }
      assert.ok(maxPixelError < 3e-6, `pixel error ${maxPixelError} at DPR ${ratio}`);
      assert.ok(maxFluxError < 1e-5, `flux error ${maxFluxError} at DPR ${ratio}`);
      assert.ok(maxUnitFluxError < 1e-5, `unit flux error ${maxUnitFluxError} at DPR ${ratio}`);
      results.push({ratio, maxPixelError, maxFluxError, maxUnitFluxError});
    }
    t.diagnostic(JSON.stringify(results));
  } finally { psf.dispose(); }
});

test('PSF table storage and upload lifetime are bounded per owner', () => {
  const first = createStellarPsfTexture(), second = createStellarPsfTexture();
  try {
    const texture = first.texture, pixels = texture.image.data, initialVersion = texture.version;
    assert.notEqual(texture, second.texture); assert.notEqual(pixels, second.texture.image.data);
    assert.equal(texture.type, THREE.FloatType); assert.equal(texture.format, THREE.RGFormat);
    assert.equal(texture.minFilter, THREE.NearestFilter); assert.equal(texture.magFilter, THREE.NearestFilter);
    assert.equal(texture.generateMipmaps, false);
    assert.ok(texture.image.width <= 2048 && texture.image.height <= 2048);
    assert.equal(pixels.byteLength, 40960);
    for (let i = 0; i < 100; i++) first.setPixelRatio(1);
    assert.equal(texture.version, initialVersion);
    first.setPixelRatio(2);
    assert.equal(texture.version, initialVersion + 1); assert.equal(texture.image.data, pixels);
    assert.equal(second.texture.version, initialVersion);
  } finally { first.dispose(); second.dispose(); }
});
