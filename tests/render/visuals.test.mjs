import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { encodeCell } from '../../src/coordinates.js';
import { createUniverse } from '../../src/generator.js';
import { createNebula } from '../../src/render/nebula.js';
import { createBlackHole } from '../../src/render/blackhole.js';
import { planetMaterial, atmosphereMaterial, ringMaterial, starMaterial } from '../../src/render/materials.js';
import { createGalaxyHaze } from '../../src/render/galaxy-haze.js';
import { createCosmos, loadedMacros, sampleGalaxy, MAX_COSMOS_PARTICLES, COSMOS_QUALITY_COUNTS } from '../../src/render/cosmos.js';

function disposalCount(resource) {
  let count = 0;
  resource.addEventListener('dispose', () => count++);
  return () => count;
}

function camera() {
  const result = new THREE.PerspectiveCamera(60, 1, 1, 220000);
  result.position.z = 20000;
  return result;
}

test('nebula instances share noise until the last owner is disposed', () => {
  const a = createNebula({ seed: 'dust-a' }), b = createNebula({ seed: 'dust-b' });
  const noise = a.children[0].material.uniforms.uNoise.value;
  const released = disposalCount(noise);
  assert.equal(b.children[0].material.uniforms.uNoise.value, noise);
  try {
    a.userData.update(camera(), 1, { quality: 'low', visibility: .4 });
    assert.equal(a.userData.stats.steps, 16);
    assert.equal(a.children[0].material.uniforms.uVisibility.value, .4);
    a.userData.dispose(); a.userData.dispose();
    assert.equal(released(), 0);
    b.userData.update(camera(), 2, { quality: 'high' });
    assert.equal(b.userData.stats.steps, 48);
    b.userData.dispose(); b.userData.dispose();
    assert.equal(released(), 1);
    const next = createNebula();
    try { assert.notEqual(next.children[0].material.uniforms.uNoise.value, noise); }
    finally { next.userData.dispose(); }
  } finally { a.userData.dispose(); b.userData.dispose(); }
});

test('black hole owns its optical resources but borrows an injected sky texture', () => {
  const sky = new THREE.Texture(), skyReleased = disposalCount(sky);
  const hole = createBlackHole({ radius: 300, seed: 'optics', skyTexture: sky });
  const mesh = hole.children[0], geometryReleased = disposalCount(mesh.geometry), materialReleased = disposalCount(mesh.material);
  try {
    assert.equal(mesh.material.uniforms.uSky.value, sky);
    hole.userData.update(camera(), 1, { quality: 'high' });
    assert.equal(hole.userData.stats.steps, 144);
    hole.userData.setVisibility(.25);
    assert.equal(mesh.material.uniforms.visibility.value, .25);
    hole.userData.dispose(); hole.userData.dispose();
    assert.equal(geometryReleased(), 1);
    assert.equal(materialReleased(), 1);
    assert.equal(skyReleased(), 0);
  } finally { hole.userData.dispose(); sky.dispose(); }
});

test('public universe descriptors create body materials without browser or texture assets', () => {
  const descriptor = createUniverse({ seed: 'material-fixture', density: 1 }).getSector(0);
  const planet = descriptor.planets[0], star = descriptor.stars[0];
  const ringMap = new THREE.Texture(), mapReleased = disposalCount(ringMap);
  const materials = [planetMaterial(planet), atmosphereMaterial(planet.colorA),
    ringMaterial(planet.ringColor, planet.seed, { texture: ringMap, planetRadius: planet.radius }), starMaterial(star.color)];
  try {
    assert.ok(materials.every(material => material.isShaderMaterial));
    assert.equal(materials[0].uniforms.proceduralSurface.value, true);
    assert.equal(materials[0].uniforms.bodyRadius.value, planet.radius);
    assert.equal(materials[2].uniforms.ringMap.value, ringMap);
    assert.equal(materials[2].uniforms.planetRadius.value, planet.radius);
    for (const material of materials) material.dispose();
    assert.equal(mapReleased(), 0);
  } finally { ringMap.dispose(); }
});

test('explicit cosmos seed is order independent and quality samples retain prefixes', () => {
  const indices = [0, 42, encodeCell({ x: -16384, y: 16383, z: -1 })];
  const expected = indices.map(index => loadedMacros(index, 'catalogue-a'));
  for (const index of [...indices].reverse()) assert.deepEqual(loadedMacros(index, 'catalogue-a'), expected[indices.indexOf(index)]);
  assert.notDeepEqual(loadedMacros(0, 'catalogue-b'), expected[0]);
  assert.deepEqual(loadedMacros(0), loadedMacros(0, 'lonelysky'));
  const descriptor = expected.flat()[0];
  assert.ok(descriptor, 'sample sectors contain at least one galaxy');
  const small = sampleGalaxy(descriptor, 32), larger = sampleGalaxy(descriptor, 64);
  for (const key of ['positions', 'colors', 'sizes']) {
    assert.deepEqual(small[key], larger[key].slice(0, small[key].length));
    assert.ok(small[key].every(Number.isFinite));
  }
  for (let i = 0; i < small.positions.length; i += 3) {
    assert.ok(Math.hypot(...small.positions.slice(i, i + 3)) <= descriptor.radius);
  }
});

test('cosmos streaming bounds allocations, avoids stationary rebuilds and releases resources', () => {
  const cosmos = createCosmos({ seed: 'stream-fixture' });
  const points = cosmos.children[0], geometryReleased = disposalCount(points.geometry), materialReleased = disposalCount(points.material);
  try {
    const update = options => cosmos.userData.update({ sectorIndex: 0, cameraPosition: [0, 0, 0], quality: 'low', ...options });
    update();
    const initial = cosmos.userData.stats;
    assert.equal(initial.particles, initial.galaxies * COSMOS_QUALITY_COUNTS.low);
    assert.ok(initial.galaxies <= 27);
    assert.ok(initial.particles <= MAX_COSMOS_PARTICLES);
    assert.equal(points.geometry.attributes.position.count, initial.particles);
    update({ cameraPosition: [10, 0, 0] });
    assert.equal(cosmos.userData.stats.rebuilds, initial.rebuilds);
    for (const coordinate of [{ x: 17, y: -20, z: 8 }, { x: -16384, y: 16383, z: 0 }]) {
      update({ sectorIndex: encodeCell(coordinate) });
      assert.ok(cosmos.userData.stats.galaxies <= 27);
      assert.ok(cosmos.userData.stats.particles <= MAX_COSMOS_PARTICLES);
      assert.ok(points.geometry.attributes.position.array.every(Number.isFinite));
    }
    update({ home: true });
    assert.equal(cosmos.visible, false);
    assert.equal(cosmos.userData.stats.batches, 0);
    const releasesBeforeDispose = geometryReleased();
    cosmos.userData.dispose(); cosmos.userData.dispose();
    assert.equal(geometryReleased(), releasesBeforeDispose + 1);
    assert.equal(materialReleased(), 1);
    assert.equal(cosmos.children.length, 0);
    update();
    assert.equal(cosmos.children.length, 0);
  } finally { cosmos.userData.dispose(); }
});

test('haze replacement releases old materials and retains noise until final disposal', () => {
  const haze = createGalaxyHaze({ seed: 'haze-fixture' });
  const descriptor = loadedMacros(0, 'haze-fixture')[0];
  assert.ok(descriptor);
  try {
    haze.userData.setDescriptors([descriptor]);
    const original = haze.children[0], materialReleased = disposalCount(original.material);
    const noise = original.material.uniforms.structureNoise.value, noiseReleased = disposalCount(noise);
    const geometryReleased = disposalCount(original.geometry);
    haze.userData.setDescriptors([descriptor]);
    assert.equal(materialReleased(), 1);
    assert.equal(haze.children[0].material.uniforms.structureNoise.value, noise);
    assert.equal(noiseReleased(), 0);
    assert.equal(geometryReleased(), 0);
    const finalMaterialReleased = disposalCount(haze.children[0].material);
    haze.userData.dispose(); haze.userData.dispose();
    assert.equal(finalMaterialReleased(), 1);
    assert.equal(geometryReleased(), 1);
    assert.equal(noiseReleased(), 1);
    assert.equal(haze.children.length, 0);
  } finally { haze.userData.dispose(); }
});

test('black-hole lens and directional background share independent environment uniforms', async () => {
  const { createDeepSky } = await import('../../src/render/deep-sky.js');
  const hole = createBlackHole(), sky = createDeepSky();
  const environment = { ambientTint: [.6, .7, .8], bandNormal: [.6, .8, 0], skyBrightness: .02, bandStrength: .4, starDensity: .5 };
  const source = hole.children[0].material.uniforms, background = sky.children[0].material.uniforms;
  try {
    for (const quiet of [0, .5, 1]) {
      hole.userData.setEnvironment(environment, quiet); sky.userData.update(environment, quiet);
      for (const key of ['uSkyTint', 'uSkyBandNormal', 'uSkyBrightness', 'uSkyBandStrength', 'uSkyStarDensity']) {
        const a = source[key].value, b = background[key].value;
        assert.deepEqual(a.toArray?.() ?? a, b.toArray?.() ?? b);
      }
    }
    environment.ambientTint[0] = 0;
    assert.equal(source.uSkyTint.value.r, .6);
    assert.notEqual(source.uSkyTint.value, background.uSkyTint.value);
  } finally { hole.userData.dispose(); sky.userData.dispose(); }
});

test('directional sky releases resources once and ignores updates after disposal', async () => {
  const { createDeepSky } = await import('../../src/render/deep-sky.js');
  const sky = createDeepSky(), mesh = sky.children[0];
  const geometryReleased = disposalCount(mesh.geometry), materialReleased = disposalCount(mesh.material);
  const before = mesh.material.uniforms.uSkyBrightness.value;
  sky.userData.dispose(); sky.userData.dispose();
  sky.userData.update({ ambientTint: [1, 1, 1], bandNormal: [1, 0, 0], skyBrightness: 8, bandStrength: 1, starDensity: 1 });
  assert.equal(geometryReleased(), 1); assert.equal(materialReleased(), 1);
  assert.equal(mesh.material.uniforms.uSkyBrightness.value, before);
});
