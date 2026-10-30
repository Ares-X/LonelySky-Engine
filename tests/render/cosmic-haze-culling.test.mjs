import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGalaxyHaze } from '../../src/render/galaxy-haze.js';
import { createCosmos } from '../../src/render/cosmos.js';
import { NebulaRenderPass } from '../../src/render/nebula-render-pass.js';
import { describeCosmicStructures, cosmicStructureRelativeCenter, COSMIC_GRID_CELLS, COSMIC_VIEW_FADE_START, COSMIC_VIEW_FAR } from '../../src/cosmic-structures.js';
import { CELL_SIZE, encodeCell } from '../../src/coordinates.js';
import {createSpatialGalacticMedium} from '../../src/galactic-spatial-medium.js';

const descriptor = {
  id: 'culling', seed: 'culling', kind: 'galaxy', morphology: 'irregular', radius: 1,
  thickness: .1, arms: 3, pitch: .33, bar: false, asymmetry: .37, orientation: [0, 0, 0],
};
function fixture(options = { structures: true }, shape = descriptor) {
  const haze = createGalaxyHaze(options);
  haze.userData.setDescriptors([shape]);
  const camera = new THREE.PerspectiveCamera(90, 1, .5, 220000);
  const frame = { centers: [[0, 0, -10]], cameraPosition: [0, 0, 0], camera, quality: 'high', brightness: .7, home: false };
  return { haze, camera, frame, mesh: haze.children[0], update() { return haze.userData.update(frame); } };
}

test('extended medium support drives viewport culling, transformed hulls and shared distance fade', () => {
  const medium = createSpatialGalacticMedium({seed: 'extended-cull', sourceCenter: [0, 0, 0], sourceAxes: [4, 1, 1],
    dustCenter: [0, 0, 0], dustAxes: [1, 1, 1], luminosities: [.01, 0, 0], colors: [[1, 1, 1], [1, 1, 1], [1, 1, 1]],
    dustIntegral: 0, extinctionColor: [1, 1, 1], resolvedFraction: .005,
    sourceKernels: [{component: 0, weight: 1, center: [-2, 0, 0], axes: [.6, .4, .4], rotation: [0, 0, 0]}], dustKernels: []});
  const f = fixture({structures: true, supportVisibility: new Float32Array([1])}, {...descriptor, medium});
  const parent = new THREE.Group(); parent.add(f.haze);
  const point = new THREE.Vector3();
  try {
    assert.ok(medium.supportRadius > 2);
    f.frame.centers[0] = [12, 0, -10];
    point.set(10, 0, -10).project(f.camera);
    assert.ok(Math.abs(point.x) <= 1 + 1e-14, 'the actual source center reaches the viewport edge');
    assert.equal(f.update(), 2, 'an offscreen actor center cannot hide its onscreen extended source');
    for (const [center, visible] of [[[0, 0, -10], 2], [[20, 0, -10], 0], [[0, 0, 10], 0]]) {
      f.frame.centers[0] = center; assert.equal(f.update(), visible);
    }
    parent.rotation.set(.3, .8, .2); parent.scale.set(3, .6, 1.7); f.haze.rotation.set(-.2, .7, .3);
    const positions = f.mesh.geometry.attributes.position;
    let contributing = 0, rejected = 0;
    for (let x = -20; x <= 20; x += 4) for (let y = -16; y <= 16; y += 4) {
      f.frame.centers[0] = [x, y, -10]; f.update();
      let onScreen = false;
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).applyMatrix4(f.mesh.matrixWorld).project(f.camera);
        if (Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && point.z > -1 && point.z < 1) onScreen = true;
      }
      if (onScreen) {contributing++; assert.equal(f.mesh.visible, true, `extended hull at ${x},${y}`);}
      if (!f.mesh.visible) rejected++;
    }
    assert.ok(contributing > 0 && rejected > 0);
  } finally {f.haze.userData.dispose(); parent.clear();}

  for (const field of [medium, null]) {
    const shape = {...descriptor, medium: field, radius: 10000000, gridCells: 1, macroCell: {x: 0, y: 0, z: 0}, offset: [0, 0, 0]};
    const provider = coordinate => coordinate.x === 0 && coordinate.y === 0 && coordinate.z === 0 ? [shape] : [];
    const cosmos = createCosmos({descriptorProvider: provider, gridCells: 1, structures: true, catalogue: {capacity: 4, supportFade: true}});
    const frame = {sectorIndex: encodeCell({x: 0, y: 0, z: 0}), cameraPosition: [0, 0, 0], quality: 'low'};
    try {
      cosmos.userData.update(frame);
      const volume = cosmos.children[1].children[0], support = shape.radius * (field ? field.supportRadius : 1);
      frame.cameraPosition = [COSMIC_VIEW_FAR + shape.radius * 1.2, 0, 0]; cosmos.userData.update(frame);
      assert.equal(volume.visible, Boolean(field), 'extended source remains supported after the legacy unit body fades out');
      frame.cameraPosition[0] = COSMIC_VIEW_FADE_START + support - 1; cosmos.userData.update(frame);
      assert.equal(volume.material.uniforms.structureVisibility.value, 1);
      frame.cameraPosition[0] = COSMIC_VIEW_FAR + support + 1; cosmos.userData.update(frame);
      assert.equal(volume.visible, false, 'the whole support has left the far visibility limit');
      assert.equal(volume.material.uniforms.structureVisibility.value, 0);
    } finally {cosmos.userData.dispose();}
  }
});

test('physical haze support retains inside, tangent, partial edges and distances beyond the raster far plane', () => {
  const f = fixture();
  try {
    for (const center of [[0, 0, 0], [0, 0, 100000000], [0, 0, -100000000], [10 + Math.SQRT2, 0, -10], [0, 10 + Math.SQRT2 - .0001, -10]]) {
      f.frame.centers[0] = center;
      const insideOrOnscreen = center[2] <= 0;
      assert.equal(f.update(), Number(insideOrOnscreen), center.toString());
    }
    for (const center of [[10 + Math.SQRT2 + .01, 0, -10], [0, -10 - Math.SQRT2 - .01, -10], [0, 0, 10]]) {
      f.frame.centers[0] = center;
      assert.equal(f.update(), 0, center.toString());
    }
    f.frame.centers[0] = [0, 0, -.1];
    assert.equal(f.update(), 1, 'the near plane must not reject a volume containing the observer');
  } finally { f.haze.userData.dispose(); }
});

test('support bound includes transformed ellipsoid axes and remains conservative under camera roll and parent rotation', () => {
  const f = fixture(undefined, { ...descriptor, morphology: 'elliptical', thickness: 2, orientation: [.3, .8, .4] });
  const parent = new THREE.Group(); parent.add(f.camera);
  parent.position.set(100, -50, 70); parent.rotation.set(.4, -.9, .6);
  f.camera.rotation.set(.3, .2, .8);
  f.camera.fov = 61; f.camera.aspect = 1.7; f.camera.updateProjectionMatrix();
  const rotation = new THREE.Quaternion(), worldPosition = new THREE.Vector3(), local = new THREE.Vector3(), point = new THREE.Vector3();
  let contributing = 0, rejected = 0;
  try {
    f.camera.getWorldQuaternion(rotation); f.camera.getWorldPosition(worldPosition);
    f.frame.cameraPosition = worldPosition.toArray();
    for (let x = -12; x <= 12; x++) for (let y = -9; y <= 9; y++) {
      local.set(x, y, -10).applyQuaternion(rotation).add(worldPosition);
      f.frame.centers[0] = local.toArray();
      f.update();
      let sampledContribution = false;
      // Independent projected surface samples ensure real support pixels are
      // retained even when the descriptor centre lies beyond a viewport side.
      for (let a = 0; a < 16; a++) for (let b = 0; b < 9; b++) {
        const longitude = a * Math.PI / 8, latitude = b * Math.PI / 8;
        point.set(Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude));
        point.multiply(f.mesh.scale).applyQuaternion(f.mesh.quaternion).add(local).project(f.camera);
        if (Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && point.z < 1) sampledContribution = true;
      }
      if (sampledContribution) { contributing++; assert.equal(f.mesh.visible, true); }
      if (!f.mesh.visible) rejected++;
    }
    assert.ok(contributing > 0 && rejected > 0, `contributing=${contributing}, rejected=${rejected}`);
    // Change only the parent pose, without manually updating camera matrices.
    parent.rotation.y += Math.PI;
    f.frame.centers[0] = new THREE.Vector3(0, 0, -10).applyQuaternion(rotation).add(worldPosition).toArray();
    assert.equal(f.update(), 0);
    parent.rotation.y -= Math.PI;
    assert.equal(f.update(), 1, 'camera rotation restoration is never latched out');
  } finally { f.haze.userData.dispose(); }
});

test('haze parent transforms use world-space support and update before rejection', () => {
  const f = fixture(), parent = new THREE.Group(); parent.add(f.haze);
  try {
    f.frame.centers[0] = [0, 0, 10];
    assert.equal(f.update(), 0);
    parent.rotation.y = Math.PI;
    assert.equal(f.update(), 1, 'rotated local +z is in front of the world camera');
    parent.rotation.y = 0;
    assert.equal(f.update(), 0, 'the current parent transform is not latched');

    parent.position.set(20000000, -30000000, 40000000);
    f.camera.position.copy(parent.position); f.frame.cameraPosition = f.camera.position.toArray();
    parent.rotation.set(.3, .8, .2); parent.scale.set(3, .6, 1.7);
    f.haze.rotation.set(-.2, .7, .3); // Nonuniform parent scale plus rotation gives shear.
    const point = new THREE.Vector3(), positions = f.mesh.geometry.attributes.position;
    let contributing = 0, rejected = 0;
    for (let x = -12; x <= 12; x += 2) for (let y = -8; y <= 8; y += 2) {
      f.frame.centers[0] = [x, y, -10]; f.update();
      // Project the actual raster vertices independently of the culling bound.
      let onScreen = false;
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).applyMatrix4(f.mesh.matrixWorld).project(f.camera);
        if (Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && point.z > -1 && point.z < 1) onScreen = true;
      }
      if (onScreen) { contributing++; assert.equal(f.mesh.visible, true, `visible proxy at ${x},${y}`); }
      if (!f.mesh.visible) rejected++;
    }
    assert.ok(contributing > 0 && rejected > 0, `contributing=${contributing}, rejected=${rejected}`);
  } finally { f.haze.userData.dispose(); parent.clear(); }
});

test('camera-only turns retain physical weights, sampling and material state while unsupported cameras retain the existing path', () => {
  const weights = new Float32Array([.63]), f = fixture({ structures: true, supportVisibility: weights });
  try {
    assert.equal(f.update(), 1);
    const uniforms = f.mesh.material.uniforms;
    const nodes = uniforms.quadrature.value, coreNodes = uniforms.coreQuadrature.value;
    const continuum = uniforms.continuumWeight.value;
    f.camera.rotation.y = Math.PI;
    assert.equal(f.update(), 0);
    assert.equal(uniforms.structureVisibility.value, weights[0]);
    assert.equal(uniforms.continuumWeight.value, continuum);
    assert.equal(uniforms.quadrature.value, nodes);
    f.camera.rotation.y = 0;
    assert.equal(f.update(), 1);
    assert.equal(uniforms.coreQuadrature.value, coreNodes);
    assert.equal(uniforms.steps.value, 48); assert.equal(uniforms.brightness.value, .7);
    f.frame.centers[0] = [12, 0, -10];
    for (const [fov, visible] of [[60, 0], [120, 1], [60, 0]]) {
      f.camera.fov = fov; f.camera.updateProjectionMatrix();
      assert.equal(f.update(), visible, 'projection changes are evaluated every frame');
    }
    f.frame.centers[0] = [0, 0, 10];
    for (const camera of [undefined, {}, new THREE.Camera(), new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100)]) {
      f.frame.camera = camera;
      assert.equal(f.update(), 1);
    }
  } finally { f.haze.userData.dispose(); }
  const legacy = fixture({ structures: false });
  try { legacy.frame.centers[0] = [0, 0, 10]; assert.equal(legacy.update(), 1); }
  finally { legacy.haze.userData.dispose(); }
});

test('canonical cosmos passes the camera each frame and floating-origin rebases preserve visibility and particle buffers', () => {
  const cosmos = createCosmos({ seed: 'structure-render', descriptorProvider: describeCosmicStructures, gridCells: COSMIC_GRID_CELLS, structures: true });
  const camera = new THREE.PerspectiveCamera(60, 1.6, .5, 220000);
  const frame = { sectorIndex: encodeCell({ x: 0, y: 0, z: 0 }), cameraPosition: [0, 0, 0], quality: 'low', camera };
  try {
    cosmos.userData.update({ ...frame, camera: null });
    const haze = cosmos.children[1];
    const target = haze.children.find(mesh => mesh.visible && mesh.position.length() > 2 * mesh.scale.length());
    assert.ok(target, 'fixture contains a distant supported structure');
    camera.lookAt(target.position);
    cosmos.userData.update(frame);
    assert.equal(target.visible, true);
    const visible = haze.children.filter(mesh => mesh.visible).map(mesh => mesh.name);
    const geometry = cosmos.children[0].geometry, position = geometry.attributes.position;
    const weights = cosmos.children[0].material.uniforms.structureWeights.value.slice();
    const generations = cosmos.userData.stats.sampleGenerations;
    assert.equal(cosmos.userData.stats.batches, 1 + visible.length);
    frame.sectorIndex = encodeCell({ x: 1, y: 0, z: 0 });
    camera.position.x -= CELL_SIZE; frame.cameraPosition[0] -= CELL_SIZE;
    cosmos.userData.update(frame);
    assert.deepEqual(haze.children.filter(mesh => mesh.visible).map(mesh => mesh.name), visible);
    assert.equal(geometry.attributes.position, position);
    assert.deepEqual(cosmos.children[0].material.uniforms.structureWeights.value, weights);
    assert.equal(cosmos.userData.stats.sampleGenerations, generations);
  } finally { cosmos.userData.dispose(); }
});

test('haze culling consumes the rebased toroidal centre rather than an unwrapped macro address', () => {
  const shape = { ...descriptor, radius: 1000000, gridCells: 1, macroCell: { x: -16384, y: 0, z: -5000 }, offset: [0, 0, 0] };
  const f = fixture(undefined, shape);
  try {
    for (const [cellX, cameraX] of [[16383, 9000], [-16384, -11000]]) {
      const cell = { x: cellX, y: 0, z: 0 };
      f.frame.centers[0] = cosmicStructureRelativeCenter(shape, cell);
      f.camera.position.x = cameraX; f.frame.cameraPosition[0] = cameraX;
      f.camera.rotation.y = 0;
      assert.equal(f.update(), 1);
      assert.equal(f.frame.centers[0][0] - cameraX, 11000);
      f.camera.rotation.y = Math.PI;
      assert.equal(f.update(), 0);
    }
  } finally { f.haze.userData.dispose(); }
});

test('offscreen-only haze skips the actual depth-pass branch and camera restoration enables it again', () => {
  const f = fixture(), scene = new THREE.Scene(); scene.add(f.haze);
  const pass = new NebulaRenderPass(scene, f.camera), target = new THREE.WebGLRenderTarget(8, 8);
  let currentTarget = null, draws = 0, copies = 0;
  const color = new THREE.Color();
  const renderer = {
    autoClear: true, getRenderTarget: () => currentTarget, setRenderTarget: value => { currentTarget = value; },
    getClearColor: value => value.copy(color), getClearAlpha: () => 1, setClearColor() {},
    clear() {}, initRenderTarget() {}, copyTextureToTexture() { copies++; }, render() { draws++; },
  };
  try {
    f.camera.rotation.y = Math.PI; f.update();
    pass.render(renderer, null, target);
    assert.equal(draws, 1); assert.equal(copies, 0); assert.equal(target.depthTexture, null);
    f.camera.rotation.y = 0; f.update();
    pass.render(renderer, null, target);
    assert.equal(draws, 3); assert.equal(copies, 1); assert.ok(target.depthTexture);
    assert.equal(f.mesh.material.uniforms.uHasSceneDepth.value, 0);
  } finally { pass.dispose(); target.dispose(); f.haze.userData.dispose(); }
});
