import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createGalaxyHaze} from '../../src/render/galaxy-haze.js';

const base = {id: 'first', seed: 'lifetime-a', kind: 'galaxy', morphology: 'spiral', theme: 'old-gold',
  radius: 12000, thickness: .08, arms: 3, pitch: .33, bar: true, asymmetry: .37, orientation: [.2, .4, .6]};
const other = {...base, id: 'second', seed: 'lifetime-b', kind: 'nebula', morphology: 'elliptical',
  theme: 'blue-nursery', radius: 8500, thickness: .7, arms: 2, pitch: .24, bar: false, asymmetry: .81, orientation: [-.3, .7, -.2]};
const changed = {...base, seed: 'same-id-new-appearance', kind: 'cluster', morphology: 'irregular', theme: 'silver-dust',
  radius: 19000, thickness: .23, arms: 4, pitch: .51, bar: false, asymmetry: .11, orientation: [.9, -.5, .1, 'ZYX']};

function valueSnapshot(value) {
  if (value?.isTexture) return {pixels: Array.from(value.image.data), width: value.image.width, height: value.image.height};
  if (value?.toArray) return value.toArray();
  if (Array.isArray(value)) return value.map(valueSnapshot);
  return value;
}
function snapshot(mesh) {
  return {name: mesh.name, position: mesh.position.toArray(), quaternion: mesh.quaternion.toArray(),
    scale: mesh.scale.toArray(), visible: mesh.visible, appearance: mesh.userData.appearance,
    uniforms: Object.fromEntries(Object.entries(mesh.material.uniforms).map(([name, uniform]) => [name, valueSnapshot(uniform.value)]))};
}

test('populated catalogue replacement retains shader owners while applying every new descriptor and fresh draw default', () => {
  for (const options of [{}, {structures: true}, {structures: true, supportVisibility: new Float32Array([.25, .75])}]) {
    const haze = createGalaxyHaze(options), fresh = createGalaxyHaze(options), depth = new THREE.Texture();
    const camera = new THREE.PerspectiveCamera(55, 1, 2, 90000);
    try {
      haze.userData.setDescriptors([base, other]);
      const slots = [...haze.children], materials = slots.map(mesh => mesh.material);
      const uniformTables = materials.map(material => material.uniforms);
      const uniformValues = uniformTables.map(table => Object.fromEntries(Object.entries(table).map(([name, uniform]) => [name, uniform.value])));
      let released = 0;
      for (const material of materials) material.addEventListener('dispose', () => released++);
      // Reorder, change all inputs at the same ID, then return to the original
      // descriptor. Each replacement follows an ordinary draw's mutable state.
      for (const next of [[other, changed], [changed, base], [base, other]]) {
        haze.userData.update({centers: [[100, 200, -20000], [-500, 0, -18000]], cameraPosition: [20, 30, 40], quality: 'low', brightness: .3, home: false});
        for (const mesh of haze.children) mesh.userData.setSceneDepth?.(depth, 901, 503, camera);
        haze.userData.update({centers: [[100, 200, -20000], [-500, 0, -18000]], cameraPosition: [20, 30, 40], quality: 'low', brightness: .3, home: true});
        haze.userData.setDescriptors(next); fresh.userData.setDescriptors(next);
        assert.equal(haze.children.length, slots.length);
        assert.equal(released, 0);
        for (let i = 0; i < slots.length; i++) {
          assert.equal(haze.children[i], slots[i], 'active slots stay attached to preserve renderer program references');
          assert.equal(slots[i].material, materials[i]);
          assert.equal(materials[i].uniforms, uniformTables[i], 'Three caches the uniform table');
          for (const [name, value] of Object.entries(uniformValues[i])) if (value && typeof value === 'object') {
            assert.equal(materials[i].uniforms[name].value, value, `${name} keeps its owned storage`);
          }
          assert.deepEqual(snapshot(slots[i]), snapshot(fresh.children[i]), 'reused slot matches a fresh descriptor installation');
          if (options.structures) {
            const legacy = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...next[i].orientation)));
            assert.deepEqual(materials[i].uniforms.worldOrientation.value.elements, legacy.elements,
              'descriptor orientation keeps the exact legacy Euler arithmetic uploaded to the shader');
          }
        }
      }
    } finally {haze.userData.dispose(); fresh.userData.dispose(); depth.dispose();}
  }
});

test('shrinking releases only removed slots, growing has no hidden pool, and empty/final cleanup releases resources once', () => {
  const haze = createGalaxyHaze({structures: true});
  const releases = new Map();
  const watch = mesh => {const material = mesh.material; releases.set(material, 0); material.addEventListener('dispose', () => releases.set(material, releases.get(material) + 1));};
  haze.userData.setDescriptors([base, other, changed]);
  const original = [...haze.children], geometry = original[0].geometry, noise = original[0].material.uniforms.structureNoise.value;
  let geometryReleases = 0, noiseReleases = 0;
  geometry.addEventListener('dispose', () => geometryReleases++); noise.addEventListener('dispose', () => noiseReleases++);
  for (const mesh of original) watch(mesh);
  try {
    haze.userData.setDescriptors([other]);
    assert.equal(haze.children[0], original[0]);
    assert.deepEqual(original.map(mesh => releases.get(mesh.material)), [0, 1, 1]);
    assert.equal(original[1].parent, null); assert.equal(original[2].parent, null);
    haze.userData.setDescriptors([changed, base, other]);
    assert.equal(haze.children[0], original[0]);
    for (const mesh of haze.children.slice(1)) {assert.ok(!original.includes(mesh)); watch(mesh);}
    haze.userData.setDescriptors([]);
    assert.equal(haze.children.length, 0); assert.ok([...releases.values()].every(n => n === 1));
    assert.equal(geometryReleases, 0); assert.equal(noiseReleases, 0);
    haze.userData.setDescriptors([base]); watch(haze.children[0]);
    assert.equal(haze.children[0].geometry, geometry); assert.equal(haze.children[0].material.uniforms.structureNoise.value, noise);
  } finally {haze.userData.dispose(); haze.userData.dispose();}
  haze.userData.setDescriptors([base]);
  assert.equal(haze.children.length, 0); assert.ok([...releases.values()].every(n => n === 1));
  assert.equal(geometryReleases, 1); assert.equal(noiseReleases, 1);
});
