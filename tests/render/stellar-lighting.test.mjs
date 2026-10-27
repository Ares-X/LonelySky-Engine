import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { planetMaterial, atmosphereMaterial, ringMaterial } from '../../src/render/materials.js';
import { setStellarLighting, setPlanetRingShadow, stellarLightingGLSL, ringDensityGLSL } from '../../src/render/stellar-lighting.js';

const planet = { kind: 'ocean', seed: 917, radius: 10, colorA: 0x123456, colorB: 0x789abc, proceduralSurface: true };
const sun = { offset: [100, 20, 30], color: 0xffddaa, intensity: 1.25, radius: 3 };
const blue = { offset: [-90, -10, 20], color: 0xaabbff, intensity: .4, radius: 1 };

test('all receivers retain legacy direction until a sample is explicitly supplied', () => {
  const direction = new THREE.Vector3(3, 4, 0);
  const materials = [planetMaterial(planet, { lightDirection: direction }), atmosphereMaterial(0x7799cc, direction), ringMaterial(0xddcc99, 917, { lightDirection: direction })];
  try {
    for (const material of materials) {
      const uniforms = material.uniforms, originalDirection = uniforms.lightDir.value;
      assert.equal(uniforms.stellarLighting.value, false);
      assert.ok(originalDirection.distanceTo(new THREE.Vector3(.6, .8, 0)) < 1e-12);
      assert.notEqual(originalDirection, direction);
      setStellarLighting(material, [sun, blue], [{ offset: [40, 1, 3], radius: 5 }]);
      assert.equal(uniforms.stellarLighting.value, true);
      assert.equal(uniforms.stellarCount.value, 2);
      assert.equal(uniforms.occluderCount.value, 1);
      assert.deepEqual(uniforms.stellarOffsets.value[1].toArray(), blue.offset);
      assert.equal(uniforms.stellarColors.value[1].getHex(), blue.color);
      assert.equal(uniforms.stellarIntensities.value[0], 1.25);
      assert.equal(uniforms.lightDir.value, originalDirection);
      setStellarLighting(material, []);
      assert.equal(uniforms.stellarCount.value, 0, 'empty sample is an unlit scene, not legacy fallback');
      assert.equal(uniforms.occluderCount.value, 0);
      assert.deepEqual(Array.from(uniforms.stellarIntensities.value), [0, 0]);
      assert.deepEqual(Array.from(uniforms.occluderRadii.value), [0, 0]);
    }
  } finally { for (const material of materials) material.dispose(); }
});

test('samples reuse preallocated storage and copy caller state without sharing it', () => {
  const material = planetMaterial(planet);
  try {
    const uniforms = material.uniforms;
    const offsets = uniforms.stellarOffsets.value, vector = offsets[0], colors = uniforms.stellarColors.value;
    const intensities = uniforms.stellarIntensities.value, radii = uniforms.stellarRadii.value;
    const input = { ...sun, offset: [...sun.offset] };
    setStellarLighting(material, [input, blue]);
    input.offset[0] = 999;
    assert.equal(vector.x, 100);
    setStellarLighting(material, [blue]);
    assert.equal(uniforms.stellarOffsets.value, offsets);
    assert.equal(offsets[0], vector);
    assert.equal(uniforms.stellarColors.value, colors);
    assert.equal(uniforms.stellarIntensities.value, intensities);
    assert.equal(uniforms.stellarRadii.value, radii);
    assert.equal(intensities[1], 0, 'removed second star cannot illuminate the receiver');
    assert.equal(radii[1], 0);
    const other = planetMaterial(planet);
    try { assert.notEqual(other.uniforms.stellarOffsets.value[0], vector); }
    finally { other.dispose(); }
  } finally { material.dispose(); }
});

test('invalid or oversized samples preserve the last complete sample', () => {
  const material = planetMaterial(planet);
  try {
    setStellarLighting(material, [sun]);
    const invalid = [
      () => setStellarLighting(material, [sun, blue, sun]),
      () => setStellarLighting(material, [sun], [{ offset: [0, 0, 0], radius: 1 }, { offset: [0, 0, 0], radius: 1 }, { offset: [0, 0, 0], radius: 1 }]),
      () => setStellarLighting(material, [blue, { ...sun, offset: [NaN, 0, 0] }]),
      () => setStellarLighting(material, [{ ...sun, intensity: -1 }]),
      () => setStellarLighting(material, [{ ...sun, radius: Infinity }]),
      () => setStellarLighting(material, [{ ...sun, color: NaN }]),
      () => setStellarLighting(material, [sun], [{ offset: [1, 2, 3], radius: -3 }]),
    ];
    for (const update of invalid) {
      assert.throws(update);
      assert.equal(material.uniforms.stellarCount.value, 1);
      assert.deepEqual(material.uniforms.stellarOffsets.value[0].toArray(), sun.offset);
    }
  } finally { material.dispose(); }
});

test('ring shadow normal is normalized and texture remains borrowed after disposal', () => {
  const material = planetMaterial(planet), texture = new THREE.Texture();
  let disposed = 0;
  texture.addEventListener('dispose', () => disposed++);
  const normal = material.uniforms.ringShadowNormal.value;
  try {
    setPlanetRingShadow(material, { normal: [0, 0, 5], texture, seed: 917 });
    assert.equal(material.uniforms.ringShadowNormal.value, normal);
    assert.deepEqual(normal.toArray(), [0, 0, 1]);
    assert.equal(material.uniforms.ringShadowSeed.value, 17);
    assert.equal(material.uniforms.ringShadowMap.value, texture);
    assert.equal(material.uniforms.ringShadowUseMap.value, true);
    assert.throws(() => setPlanetRingShadow(material, { normal: [0, 0, 0] }));
    assert.deepEqual(normal.toArray(), [0, 0, 1]);
    setPlanetRingShadow(material, { normal: [0, 2, 0], enabled: false });
    assert.equal(material.uniforms.ringShadowEnabled.value, false);
    assert.equal(material.uniforms.ringShadowMap.value, null);
    material.dispose();
    assert.equal(disposed, 0);
  } finally { texture.dispose(); }
});

// Exercise the actual scalar GLSL overlap calculation. This checks geometric
// limits and the finite domains; the browser separately compiles and draws it.
const discBody = stellarLightingGLSL.match(/float stellarDiscVisibility\([^)]*\)\{([\s\S]*?)\n\}/)[1];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const visibleDisc = Function('sourceRadius', 'blockerRadius', 'separation', 'clamp', 'step', 'abs', 'max', 'acos', 'sqrt', discBody.replace(/\bfloat\b/g, 'let'));
const visibility = (source, blocker, separation) => visibleDisc(source, blocker, separation, clamp, (edge, value) => value < edge ? 0 : 1, Math.abs, Math.max, Math.acos, Math.sqrt);

test('analytic stellar eclipses resolve total, annular, partial and point-source limits', () => {
  assert.equal(visibility(.05, 0, 0), 1);
  assert.equal(visibility(.05, .1, 0), 0);
  assert.equal(visibility(.1, .05, 0), .75);
  assert.equal(visibility(.1, .05, .15), 1);
  assert.equal(visibility(0, .05, .01), 0);
  assert.equal(visibility(0, .05, .1), 1);
  assert.ok(Math.abs(visibility(.1, .1, .1) - (1 - (2 * Math.PI / 3 - Math.sqrt(3) / 2) / Math.PI)) < 1e-10);
  for (const source of [0, 1e-9, .01, .1, 1.57]) for (const blocker of [0, 1e-9, .01, .1, 1.57]) {
    let previous = 0;
    for (let i = 0; i <= 200; i++) {
      const value = visibility(source, blocker, i / 50);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
      assert.ok(value >= previous - 1e-10, 'uncovering a disc cannot darken it');
      previous = value;
    }
  }
});


// Run the sphere function itself with float32 vector operations so this also
// exercises its source/occluder ordering, not only projected disc overlap.
const f32 = Math.fround;
const dot32 = (a, b) => f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2]));
const length32 = value => f32(Math.sqrt(dot32(value, value)));
const sphereBody = stellarLightingGLSL.match(/float sphereTransmission\([^)]*\)\{([\s\S]*?)\n\}/)[1]
  .replace(/source-point/g, 'subtract(source,point)').replace(/blocker-point/g, 'subtract(blocker,point)')
  .replace(/blocker-source/g, 'subtract(blocker,source)')
  .replace(/toSource\/sourceDistance/g, 'divide(toSource,sourceDistance)')
  .replace(/toBlocker\/blockerDistance/g, 'divide(toBlocker,blockerDistance)')
  .replace(/\b(?:vec3|float)\b/g, 'let');
const transmitSphere = Function('point', 'source', 'sourceRadius', 'blocker', 'blockerRadius',
  'subtract', 'divide', 'dot', 'length', 'cross', 'max', 'clamp', 'asin', 'atan', 'stellarDiscVisibility', sphereBody);
const sphereVisibility = (source, blocker, blockerRadius, sourceRadius = .1) => transmitSphere([0, 0, 0], source, sourceRadius, blocker, blockerRadius,
  (a, b) => a.map((value, i) => f32(value - b[i])), (a, b) => a.map(value => f32(value / b)), dot32, length32,
  (a, b) => [f32(a[1] * b[2] - a[2] * b[1]), f32(a[2] * b[0] - a[0] * b[2]), f32(a[0] * b[1] - a[1] * b[0])],
  Math.max, clamp, Math.asin, Math.atan2, visibility);

test('an oblique stellar occluder never eclipses its own emitter through normalization roundoff', () => {
  const source = [1, 1, 2], distance = length32(source);
  const along = dot32(source, source.map(value => f32(value / distance)));
  assert.ok(along < distance, 'fixture passes the old projected-distance guard');
  assert.equal(sphereVisibility(source, source, .1), 1);
  assert.equal(sphereVisibility(source, source, 3), 1, 'self-center exclusion precedes the inside-blocker test');
  assert.equal(sphereVisibility(source, [.5, .5, 1], .1), 0, 'another foreground star still produces an eclipse');
  assert.equal(sphereVisibility(source, [2, 2, 4], .1), 1, 'a source behind the emitter cannot eclipse it');
  assert.equal(sphereVisibility(source, [1, 0, 0], .1), 1, 'an off-axis foreground source leaves the disc visible');
  const remote = [10000, 10000, 20000];
  assert.equal(sphereVisibility(remote, [10000.00001, 10000, 20000], 100, 100), 1, 'sub-ULP center differences remain self-identical');
  assert.equal(sphereVisibility(remote, [9990, 9990, 19980], 100, 100), 0, 'a resolved nearby foreground center remains a blocker');
});

const densityBody = ringDensityGLSL.match(/float ringDensity\([^)]*\)\{([\s\S]*?)\n\}/)[1];
const density = Function('r', 'ringSeed', 'textured', 'ringTexture', 'texture2D', 'vec2', 'sin', 'smoothstep', 'abs', 'clamp', densityBody.replace(/\bfloat\b/g, 'let'));
const smoothstep = (a, b, value) => { const t = clamp((value - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const opacity = (r, alpha = null) => density(r, 17, alpha !== null, null, () => ({ a: alpha }), () => null, Math.sin, smoothstep, Math.abs, clamp);

test('shared ring density respects actual annulus, Cassini gap and texture alpha', () => {
  assert.equal(opacity(1.1), 0);
  assert.equal(opacity(2.3), 0);
  const gap = 1.18 + 1.08 * .65;
  assert.ok(opacity(gap) < .08);
  assert.ok(opacity(gap - .07) > .2);
  assert.equal(opacity(1.6, 0), 0, 'transparent texture bands cast no shadow');
  assert.ok(Math.abs(opacity(1.6, .4) - opacity(1.6) * .4) < 1e-12);
});

// Evaluate the scalar finite-disc horizon directly from its GLSL source. The
// fully hidden disc alone permits skipping all reflected/specular/limb terms;
// the geometric normal, rather than an artistically perturbed shading normal,
// decides this boundary.
const dayBody = stellarLightingGLSL.match(/float stellarDay\([^)]*\)\{([^}]+)\}/)[1].replace(/\bfloat\b/g, 'let');
const finiteDiscDay = Function('cosine', 'angularRadius', 'max', 'smoothstep', dayBody);
test('finite-disc dark-side boundary retains partial stellar discs independent of surface normal perturbation', () => {
  for (const angularRadius of [0, .0001, .01, .12, 1]) {
    const width = Math.max(angularRadius, .0001);
    for (const cosine of [-1, -width, -width * 2]) assert.equal(finiteDiscDay(cosine, angularRadius, Math.max, smoothstep), 0);
    for (const cosine of [-width * .999, 0, width * .999]) assert.ok(finiteDiscDay(cosine, angularRadius, Math.max, smoothstep) > 0);
    assert.equal(finiteDiscDay(width, angularRadius, Math.max, smoothstep), 1);
  }
});
