import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { describeNebulaAppearance, NEBULA_APPEARANCE_FAMILIES } from '../../src/render/nebula-appearance.js';
import { createNebula } from '../../src/render/nebula.js';

const morphologies = ['columns', 'halo', 'knots', 'rift', 'shell', 'stream', 'wisps'];
const uniforms = group => group.children[0].material.uniforms;

test('independent nebula descriptors are deterministic and respect morphology families', () => {
  const expected = ['emission-cloud', 'planetary-shell', 'reflection-dust', 'dark-cloud', 'supernova-remnant'];
  for (const [index, morphology] of morphologies.entries()) {
    const descriptor = describeNebulaAppearance({ seed: 'fixed', morphology });
    describeNebulaAppearance({ seed: 'unrelated', morphology: 'stream' });
    assert.deepEqual(describeNebulaAppearance({ seed: 'fixed', morphology }), descriptor);
    if (index < expected.length) assert.equal(descriptor.family, expected[index]);
    assert.equal(descriptor.code, NEBULA_APPEARANCE_FAMILIES[descriptor.family].code);
    assert.ok(descriptor.name && descriptor.description);
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(Object.isFrozen(descriptor.lightDirection));
    assert.ok(Math.abs(Math.hypot(...descriptor.lightDirection) - 1) < 1e-12);
  }
  const families = new Set(Array.from({ length: 40 }, (_, seed) => describeNebulaAppearance({ seed, morphology: 'wisps' }).family));
  assert.equal(families.size, 3);
  assert.equal(describeNebulaAppearance({ seed: 0, morphology: 'unknown' }), null);
});

test('appearance leaves seeded geometry, stationary noise and legacy defaults intact', () => {
  const legacy = createNebula({ seed: 42, morphology: 'halo', colorA: 0x123456 });
  const styled = createNebula({ seed: 42, morphology: 'halo', appearance: describeNebulaAppearance({ seed: 42, morphology: 'halo' }) });
  const invalid = createNebula({ appearance: { family: '__proto__' } });
  try {
    assert.equal(uniforms(legacy).uAppearance.value, 0);
    assert.equal(uniforms(invalid).uAppearance.value, 0);
    assert.equal(uniforms(legacy).uColorA.value.getHex(), 0x123456);
    assert.equal(uniforms(legacy).uExtinction.value, 1);
    assert.equal(uniforms(styled).uAppearance.value, 4);
    for (const key of ['uMorphology', 'uNoise', 'uNoiseOffset']) {
      assert.deepEqual(uniforms(styled)[key].value, uniforms(legacy)[key].value);
    }
    assert.deepEqual(styled.children[0].position, legacy.children[0].position);
    assert.deepEqual(styled.children[0].scale, legacy.children[0].scale);
    assert.deepEqual(styled.children[0].geometry.attributes.position.array, legacy.children[0].geometry.attributes.position.array);
    assert.equal(styled.children.length, 1);
    const camera = new THREE.PerspectiveCamera();
    for (const [quality, steps] of [['low', 16], ['auto', 32], ['high', 48]]) {
      styled.userData.update(camera, 123, { quality });
      assert.equal(uniforms(styled).uSteps.value, steps);
    }
  } finally { legacy.userData.dispose(); styled.userData.dispose(); invalid.userData.dispose(); }
});

test('caller coefficients stay finite and bounded and dark clouds cannot gain emission', () => {
  const extreme = createNebula({ appearance: { family: 'reflection-dust', emission: 999, scattering: Infinity,
    excitation: -9, rimStrength: NaN, extinction: 999, phase: -Infinity, lightDirection: [1e308, 1e308, 0], colorA: NaN } });
  const dark = createNebula({ appearance: { family: 'dark-cloud', emission: 999, scattering: 999, excitation: 999, rimStrength: 999 } });
  try {
    const u = uniforms(extreme);
    for (const [name, lower, upper] of [['uEmission', 0, .6], ['uScattering', 0, 1], ['uExcitation', 0, .6],
      ['uRimStrength', 0, .5], ['uExtinction', .5, 2], ['uPhase', 0, Math.PI * 2]]) {
      assert.ok(Number.isFinite(u[name].value) && u[name].value >= lower && u[name].value <= upper, name);
    }
    assert.ok(Math.abs(u.uLightDirection.value.length() - 1) < 1e-12);
    assert.ok(u.uColorA.value.toArray().every(Number.isFinite));
    assert.equal(uniforms(dark).uEmission.value, 0);
    assert.equal(uniforms(dark).uExcitation.value, 0);
    assert.ok(uniforms(dark).uScattering.value <= .035);
    assert.ok(uniforms(dark).uRimStrength.value <= .015);
  } finally { extreme.userData.dispose(); dark.userData.dispose(); }
});

test('appearance shares the existing noise and releases each owned resource once', () => {
  const a = createNebula({ appearance: describeNebulaAppearance({ seed: 'a', morphology: 'shell' }) });
  const b = createNebula({ appearance: describeNebulaAppearance({ seed: 'b', morphology: 'rift' }) });
  const noise = uniforms(a).uNoise.value;
  const resources = [a.children[0].geometry, a.children[0].material, noise];
  const counts = resources.map(() => 0);
  resources.forEach((resource, i) => resource.addEventListener('dispose', () => counts[i]++));
  assert.equal(uniforms(b).uNoise.value, noise);
  a.userData.dispose(); a.userData.dispose();
  assert.deepEqual(counts, [1, 1, 0]);
  b.userData.dispose(); b.userData.dispose();
  assert.deepEqual(counts, [1, 1, 1]);
});
