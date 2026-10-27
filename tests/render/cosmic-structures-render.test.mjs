import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { encodeCell } from '../../src/coordinates.js';
import { describeCosmicStructures, COSMIC_GRID_CELLS, loadedCosmicStructures, cosmicStructureRelativeCenter, cosmicDrawDistance, cosmicTrueDistance } from '../../src/cosmic-structures.js';
import { createCosmos, COSMOS_QUALITY_COUNTS, sampleGalaxy } from '../../src/render/cosmos.js';

const seed = 'structure-render';
const options = { seed, descriptorProvider: describeCosmicStructures, gridCells: COSMIC_GRID_CELLS, structures: true };

test('V3 renderer uses the authoritative catalogue, retained buffers and physical 3D stars', () => {
  const cosmos = createCosmos(options), points = cosmos.children[0], volumes = cosmos.children[1];
  const cell = { x: 0, y: 0, z: 0 }, frame = { sectorIndex: encodeCell(cell), cameraPosition: [0, 0, 0], quality: 'low' };
  try {
    cosmos.userData.update(frame);
    const catalogue = loadedCosmicStructures(frame.sectorIndex, seed), count = COSMOS_QUALITY_COUNTS.low;
    assert.equal(cosmos.userData.stats.revision, 3);
    assert.equal(cosmos.userData.stats.structures, catalogue.length);
    assert.equal(cosmos.userData.stats.galaxies, catalogue.filter(d => d.kind === 'galaxy').length);
    assert.equal(cosmos.userData.stats.clusters, catalogue.filter(d => d.kind === 'cluster').length);
    assert.equal(cosmos.userData.stats.nebulae, catalogue.filter(d => d.kind === 'nebula').length);
    assert.equal(cosmos.userData.stats.particles, catalogue.length * count);
    assert.equal(volumes.children.length, catalogue.length);
    assert.ok(catalogue.some(d => d.kind === 'cluster') && catalogue.some(d => d.kind === 'nebula'));
    for (let j = 0; j < catalogue.length; j++) {
      const descriptor = catalogue[j], center = cosmicStructureRelativeCenter(descriptor, cell), sample = sampleGalaxy(descriptor, count);
      assert.deepEqual(points.geometry.attributes.position.array.slice(j * count * 3, (j + 1) * count * 3), Float32Array.from(sample.positions, (n, i) => n + center[i % 3]));
      assert.equal(volumes.children[j].name, descriptor.id);
      assert.equal(volumes.children[j].material.depthTest, false, 'volumes clip each integrated ray with the opaque depth snapshot');
      assert.equal(typeof volumes.children[j].userData.setSceneDepth, 'function');
    }
    const position = points.geometry.attributes.position, color = points.geometry.attributes.color;
    const meshes = volumes.children.slice(), uniforms = meshes.map(m => m.material.uniforms.localCamera.value);
    cosmos.userData.update({ ...frame, cameraPosition: [1000, 2000, 3000] });
    cosmos.userData.update({ ...frame, sectorIndex: encodeCell({ ...cell, x: 1 }) });
    assert.equal(points.geometry.attributes.position, position);
    assert.equal(points.geometry.attributes.color, color);
    assert.deepEqual(volumes.children, meshes);
    meshes.forEach((mesh, i) => assert.equal(mesh.material.uniforms.localCamera.value, uniforms[i]));
  } finally { cosmos.userData.dispose(); }
});

test('scene-depth handshake carries the active target dimensions and camera without retaining the texture', () => {
  const cosmos = createCosmos(options), depth = new THREE.DepthTexture(128, 64), camera = new THREE.PerspectiveCamera(55, 2, .5, 220000);
  try {
    cosmos.userData.update({ sectorIndex: 0, cameraPosition: [0, 0, 0], quality: 'low' });
    const mesh = cosmos.children[1].children[0], uniforms = mesh.material.uniforms;
    mesh.userData.setSceneDepth(depth, 128, 64, camera);
    assert.equal(uniforms.uSceneDepth.value, depth);
    assert.equal(uniforms.uHasSceneDepth.value, 1);
    assert.deepEqual(uniforms.uDepthResolution.value.toArray(), [128, 64]);
    assert.deepEqual(uniforms.uCameraNearFar.value.toArray(), [.5, 220000]);
    mesh.userData.setSceneDepth(null);
    assert.equal(uniforms.uSceneDepth.value, null);
    assert.equal(uniforms.uHasSceneDepth.value, 0);
    let geometries = 0, materials = 0, textures = 0;
    mesh.geometry.addEventListener('dispose', () => geometries++);
    for (const volume of cosmos.children[1].children) volume.material.addEventListener('dispose', () => materials++);
    uniforms.structureNoise.value.addEventListener('dispose', () => textures++);
    const materialCount = cosmos.children[1].children.length;
    cosmos.userData.dispose(); cosmos.userData.dispose();
    assert.equal(geometries, 1); assert.equal(materials, materialCount); assert.equal(textures, 1);
  } finally { cosmos.userData.dispose(); depth.dispose(); }
});

test('opaque-depth reconstruction recovers a physical ray limit at grazing and distant directions', () => {
  // Independent projection/depth pipeline, including off-axis radial distance.
  const camera = new THREE.PerspectiveCamera(55, 1.8, .5, 220000);
  for (const physical of [1, 150000, 160000, 1000000, 10000000, 100000000]) for (const cosine of [.25, .5, 1]) {
    const radial = cosmicDrawDistance(physical), forward = radial * cosine;
    const clip = new THREE.Vector4(Math.sqrt(1 - cosine * cosine) * radial, 0, -forward, 1).applyMatrix4(camera.projectionMatrix);
    const depth = (clip.z / clip.w + 1) / 2;
    const recoveredForward = camera.near * camera.far / (camera.far - depth * (camera.far - camera.near));
    const recovered = cosmicTrueDistance(recoveredForward / cosine);
    assert.ok(Math.abs(recovered - physical) / physical < 3e-8, `${physical} at cosine ${cosine}`);
  }
});

test('approach resolves the statistical continuum into retained 3D tracers without a support-wall jump', () => {
  const cosmos = createCosmos(options), frame = { sectorIndex: 0, cameraPosition: [0, 0, 0], quality: 'low' };
  try {
    cosmos.userData.update(frame);
    const mesh = cosmos.children[1].children[0], radius = mesh.material.uniforms.radius.value;
    const center = mesh.position.toArray(), stars = cosmos.children[0].geometry.attributes.position;
    const weights = [];
    for (let i = 0; i <= 220; i++) {
      const reach = 2.2 - i * .01;
      frame.cameraPosition[0] = center[0] + radius * reach;
      frame.cameraPosition[1] = center[1]; frame.cameraPosition[2] = center[2];
      cosmos.userData.update(frame);
      weights.push(mesh.material.uniforms.continuumWeight.value);
      assert.equal(cosmos.children[0].geometry.attributes.position, stars);
    }
    assert.ok(weights[0] > .99 && weights.at(-1) < .01);
    for (let i = 1; i < weights.length; i++) assert.ok(weights[i - 1] >= weights[i] && weights[i - 1] - weights[i] < .02);
  } finally { cosmos.userData.dispose(); }
});
