import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { encodeCell } from '../../src/coordinates.js';
import { createUniverse } from '../../src/generator.js';
import { createNebula } from '../../src/render/nebula.js';
import { createBlackHole } from '../../src/render/blackhole.js';
import { createDeepSky, deepSkyUniforms, setDeepSkyEnvironment } from '../../src/three.js';
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

test('six sea blends reach both views, copy descriptors and clear on an ordinary environment update', () => {
  const sky = createDeepSky(), hole = createBlackHole();
  const background = sky.children[0].material.uniforms, lens = hole.children[0].material.uniforms;
  const environment = { ambientTint: [.6, .7, .8], bandNormal: [0, 1, 0], skyBrightness: .02, bandStrength: .4, starDensity: .5 };
  const frame = new THREE.Matrix3().set(0, -1, 0, 1, 0, 0, 0, 0, 1).toArray();
  const weights = uniforms => [...uniforms.uSeaWeightsA.value.toArray(), ...uniforms.uSeaWeightsB.value.toArray()];
  try {
    assert.deepEqual(weights(background), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(weights(lens), [0, 0, 0, 0, 0, 0]);
    for (let family = 0; family < 6; family++) {
      const sea = { weights: Array.from({ length: 6 }, (_, i) => i === family ? 1 : 0), frame: [...frame], phase: family * .3, width: .7 };
      sky.userData.update({ ...environment, starSea: sea }, .5);
      hole.userData.setEnvironment({ ...environment, starSea: sea }, .5);
      for (const uniforms of [background, lens]) {
        assert.deepEqual(weights(uniforms), sea.weights);
        assert.deepEqual(uniforms.uSeaFrame.value.toArray(), frame);
        assert.equal(uniforms.uSeaPhase.value, sea.phase);
        assert.equal(uniforms.uSeaWidth.value, sea.width);
        assert.equal(uniforms.uSeaQuiet.value, .925);
      }
      sea.weights.fill(0); sea.frame.fill(0);
      assert.equal(weights(background)[family], 1);
      assert.equal(weights(lens)[family], 1);
      assert.deepEqual(background.uSeaFrame.value.toArray(), frame);
      assert.deepEqual(lens.uSeaFrame.value.toArray(), frame);
    }
    assert.notEqual(background.uSeaFrame.value, lens.uSeaFrame.value);
    sky.userData.update(environment); hole.userData.setEnvironment(environment);
    assert.deepEqual(weights(background), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(weights(lens), [0, 0, 0, 0, 0, 0]);
  } finally { sky.userData.dispose(); hole.userData.dispose(); }
});

test('seeded sea profiles reach the sky and lens without leaking into later legacy or empty environments', () => {
  const sky=createDeepSky(),hole=createBlackHole(), defaults=deepSkyUniforms();
  const environment={ambientTint:[.6,.7,.8],bandNormal:[0,1,0],skyBrightness:.02,bandStrength:0,starDensity:.2};
  const appearance={revision:1,morphologyWeights:Array.from({length:18},(_,i)=>i===17?.8:i===6?.2:0),
    cool:[.2,.3,.4],warm:[.7,.6,.5],accent:[.8,.2,.3],offset:[-3,4,5],
    shape:[.8,.2,.4,.5],structure:[3.4,2.5,.6,-.3],dust:[1.8,.03,.4,.7],state:[.6,.15,.9,.5]};
  const sea={weights:[0,0,0,0,0,1,0],frame:new THREE.Matrix3().toArray(),phase:1,width:1,appearance};
  const groups=['A','B','C','D','E','F'];
  const morphs=u=>groups.flatMap(group=>u[`uSeaMorph${group}`].value.toArray());
  try {
    sky.userData.update({...environment,starSea:sea});hole.userData.setEnvironment({...environment,starSea:sea});
    for(const object of [sky,hole]) {
      const uniforms=object.children[0].material.uniforms;
      assert.deepEqual(morphs(uniforms),appearance.morphologyWeights);
      for(const key of ['cool','warm','accent','offset','shape','structure','dust','state']) {
        assert.deepEqual(uniforms[`uSea${key[0].toUpperCase()+key.slice(1)}`].value.toArray(),appearance[key]);
      }
    }
    const before=morphs(sky.children[0].material.uniforms);appearance.morphologyWeights.fill(0);appearance.cool.fill(0);
    assert.deepEqual(morphs(sky.children[0].material.uniforms),before);
    assert.deepEqual(sky.children[0].material.uniforms.uSeaCool.value.toArray(),[.2,.3,.4]);
    const legacy={...sea};delete legacy.appearance;
    sky.userData.update({...environment,starSea:legacy});hole.userData.setEnvironment({...environment,starSea:legacy});
    for(const object of [sky,hole]) {
      const uniforms=object.children[0].material.uniforms;
      assert.deepEqual(morphs(uniforms),[0,0,0,0,0,1,...Array(12).fill(0)]);
      assert.deepEqual(uniforms.uSeaCool.value.toArray(),defaults.uSeaCool.value.toArray());
    }
    sky.userData.update(environment);hole.userData.setEnvironment(environment);
    assert.deepEqual(morphs(sky.children[0].material.uniforms),Array(18).fill(0));
    assert.deepEqual(morphs(hole.children[0].material.uniforms),Array(18).fill(0));
  } finally {sky.userData.dispose();hole.userData.dispose();}
});

test('custom sky uniforms and both views borrow the same optional detail texture', () => {
  const texture = new THREE.Texture(), released = disposalCount(texture);
  const sky = createDeepSky({ detailTexture: texture }), hole = createBlackHole({ detailTexture: texture });
  const custom = deepSkyUniforms({ detailTexture: texture });
  const environment = { ambientTint: [1, 1, 1], bandNormal: [0, 1, 0], skyBrightness: .01, bandStrength: 0, starDensity: .5,
    starSea: { weights: [.1, .2, .3, .1, .2, .1], frame: new THREE.Matrix3().toArray(), phase: .4, width: 1.2 } };
  try {
    setDeepSkyEnvironment(custom, environment);
    sky.userData.update(environment); hole.userData.setEnvironment(environment);
    for (const uniforms of [custom, sky.children[0].material.uniforms, hole.children[0].material.uniforms]) {
      assert.equal(uniforms.uSeaDetail.value, texture);
      assert.equal(uniforms.uSeaHasDetail.value, true);
      assert.deepEqual([...uniforms.uSeaWeightsA.value.toArray(), ...uniforms.uSeaWeightsB.value.toArray()], environment.starSea.weights);
    }
    assert.equal(deepSkyUniforms().uSeaDetail.value, null);
    assert.equal(deepSkyUniforms().uSeaHasDetail.value, false);
    sky.userData.dispose(); sky.userData.dispose(); hole.userData.dispose(); hole.userData.dispose();
    assert.equal(released(), 0);
  } finally { sky.userData.dispose(); hole.userData.dispose(); texture.dispose(); }
});

test('nebula distance follows transformed volume bounds and remains stable after rebasing', () => {
  const parent = new THREE.Group(), nebula = createNebula(), volume = nebula.children[0];
  parent.position.set(20000, -40000, 60000);
  parent.rotation.set(.2, .5, -.7);
  parent.scale.set(1.5, 2, .5);
  parent.add(nebula);
  parent.updateMatrixWorld(true);
  try {
    for (const local of [[0, 0, 0], [.9, -.9, .9], [-1, 1, -1]]) {
      const point = volume.localToWorld(new THREE.Vector3(...local)), before = point.clone();
      assert.ok(nebula.userData.distanceToVolume(point) < 1e-8);
      assert.deepEqual(point, before, 'distance queries must not mutate the camera position');
    }
    const outside = volume.localToWorld(new THREE.Vector3(1.3, -1.4, 1.2));
    const nearest = volume.localToWorld(new THREE.Vector3(1, -1, 1));
    const distance = nebula.userData.distanceToVolume(outside);
    assert.ok(Math.abs(distance - outside.distanceTo(nearest)) < 1e-8);
    const shift = new THREE.Vector3(40000, 20000, -20000);
    parent.position.sub(shift); outside.sub(shift);
    assert.ok(Math.abs(nebula.userData.distanceToVolume(outside) - distance) < 1e-8);
  } finally { nebula.userData.dispose(); }
});
