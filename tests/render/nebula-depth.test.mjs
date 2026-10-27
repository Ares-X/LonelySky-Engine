import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createNebula } from '../../src/render/nebula.js';
import { NebulaRenderPass } from '../../src/render/nebula-render-pass.js';

function fixture(options) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, 1, .5, 220000);
  const nebula = createNebula();
  scene.add(nebula);
  camera.lookAt(1500, -500, -12500);
  camera.updateMatrixWorld();
  nebula.userData.update(camera, 0);
  const target = new THREE.WebGLRenderTarget(64, 32, { samples: 4 });
  target.resolveDepthBuffer = false;
  const pass = new NebulaRenderPass(scene, camera, options);
  let currentTarget = null;
  const clearColor = new THREE.Color(0x123456);
  let clearAlpha = .75;
  const draws = [], copies = [];
  const renderer = {
    autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
    getRenderTarget: () => currentTarget,
    getClearColor: value => value.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    setClearColor: (value, alpha = clearAlpha) => { clearColor.set(value); clearAlpha = alpha; },
    setClearAlpha: value => { clearAlpha = value; },
    setRenderTarget: value => { currentTarget = value; },
    clear() {},
    initRenderTarget(value) { assert.ok(value.isWebGLRenderTarget); },
    copyTextureToTexture(source, destination) {
      assert.notEqual(source, destination);
      assert.notEqual(destination, currentTarget.depthTexture);
      copies.push([source, destination]);
    },
    render(world, activeCamera) {
      // Mirror WebGLRenderer's matrix/hook ordering without simulating a GPU.
      if (world.matrixWorldAutoUpdate === true) world.updateMatrixWorld();
      if (activeCamera.parent === null && activeCamera.matrixWorldAutoUpdate === true) activeCamera.updateMatrixWorld();
      world.onBeforeRender(this, world, activeCamera, currentTarget);
      const visible = [], worldPositions = {};
      world.traverseVisible(object => {
        if (!object.layers.test(activeCamera.layers) || !object.material) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (!materials.some(material => material.visible)) return;
        visible.push(object.name);
        for (const material of materials) if (material.visible) {
          object.onBeforeRender(this, world, activeCamera, object.geometry, material, null);
          material.onBeforeRender(this, world, activeCamera, object.geometry, object, null);
          worldPositions[object.name] = object.matrixWorld.elements.slice(12, 15);
          object.onAfterRender(this, world, activeCamera, object.geometry, material, null);
        }
      });
      const volumeMaterial = nebula.children[0].material;
      draws.push({ visible, worldPositions, matrixWorldAutoUpdate: world.matrixWorldAutoUpdate,
        hasDepth: volumeMaterial.uniforms?.uHasSceneDepth.value,
        depth: volumeMaterial.uniforms?.uSceneDepth.value, background: world.background,
        resolveDepth: currentTarget.resolveDepthBuffer });
      world.onAfterRender(this, world, activeCamera);
    },
  };
  const add = (name, material, renderOrder = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.name = name; mesh.renderOrder = renderOrder; scene.add(mesh);
    return mesh;
  };
  return { scene, camera, nebula, target, pass, renderer, draws, copies, add,
    dispose() { pass.dispose(); nebula.userData.dispose(); target.dispose(); scene.traverse(o => {
      if (o === nebula.children[0]) return;
      o.geometry?.dispose();
      if (o.material) for (const material of [o.material].flat()) material.dispose();
    }); } };
}

test('depth composition shades surfaces and sorted transparencies once and samples a separate depth snapshot', () => {
  const f = fixture();
  const opaque = new THREE.MeshBasicMaterial(), glow = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  const sky = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
  const body = f.add('body', opaque), halo = f.add('glow', glow), background = f.add('sky', sky, -1000);
  const mixed = f.add('mixed', [opaque, glow]);
  const materials = [body.material, halo.material, background.material, mixed.material];
  f.scene.background = new THREE.Color(0x111111);
  const originalBackground = f.scene.background;
  try {
    f.pass.render(f.renderer, null, f.target);
    assert.equal(f.draws.length, 2);
    assert.deepEqual(f.draws[0].visible.sort(), ['body', 'mixed', 'sky']);
    assert.deepEqual(f.draws[1].visible.sort(), ['', 'glow', 'mixed']);
    assert.equal(f.draws[1].hasDepth, true);
    assert.ok(f.draws.every(draw => draw.resolveDepth), 'surface depth resolves while a volume consumes its snapshot');
    assert.equal(f.target.resolveDepthBuffer, false, 'postprocessing returns to colour-only resolves');
    assert.equal(f.draws[1].depth, f.copies[0][1]);
    assert.equal(f.draws[1].background, null);
    assert.equal(f.scene.background, originalBackground);
    assert.deepEqual([body.material, halo.material, background.material, mixed.material], materials);
    assert.equal(f.nebula.children[0].material.uniforms.uHasSceneDepth.value, false);
    assert.equal(f.renderer.autoClear, true);
  } finally { f.dispose(); }
});

for (const hook of ['scene before', 'scene after', 'object before', 'object after', 'material before']) {
  test(`default matrix updates preserve transform changes from ${hook} hooks`, () => {
    const f = fixture();
    const surface = f.add('surface', new THREE.MeshBasicMaterial());
    const halo = f.add('halo', new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    let changed = false;
    const moveHalo = () => {
      if (changed) return;
      changed = true;
      halo.position.x = 7;
    };
    if (hook === 'scene before') f.scene.onBeforeRender = moveHalo;
    if (hook === 'scene after') f.scene.onAfterRender = moveHalo;
    if (hook === 'object before') surface.onBeforeRender = moveHalo;
    if (hook === 'object after') surface.onAfterRender = moveHalo;
    if (hook === 'material before') surface.material.onBeforeRender = moveHalo;
    try {
      f.pass.render(f.renderer, null, f.target);
      assert.equal(f.pass.reuseWorldMatrices, false);
      assert.equal(changed, true);
      assert.deepEqual(f.draws[1].worldPositions.halo, [7, 0, 0]);
      assert.deepEqual(f.draws.map(draw => draw.matrixWorldAutoUpdate), [true, true]);
      assert.equal(f.scene.matrixWorldAutoUpdate, true);
    } finally { f.dispose(); }
  });
}

test('default mode retains a matrix-update setting changed by a render hook', () => {
  const f = fixture();
  let draws = 0;
  f.scene.onAfterRender = () => { if (++draws === 2) f.scene.matrixWorldAutoUpdate = false; };
  try {
    f.pass.render(f.renderer, null, f.target);
    assert.equal(draws, 2);
    assert.equal(f.scene.matrixWorldAutoUpdate, false);
  } finally { f.dispose(); }
});

test('matrix reuse skips only the second propagation and applies parent changes on the next frame', () => {
  const f = fixture({ reuseWorldMatrices: true });
  const parent = new THREE.Group();
  const halo = f.add('halo', new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  parent.add(halo); f.scene.add(parent); halo.position.x = 3;
  let updates = 0;
  const updateMatrixWorld = f.scene.updateMatrixWorld;
  f.scene.updateMatrixWorld = function (...args) { updates++; return updateMatrixWorld.apply(this, args); };
  try {
    parent.position.x = 6;
    f.pass.render(f.renderer, null, f.target);
    assert.equal(updates, 1);
    assert.deepEqual(f.draws[1].worldPositions.halo, [9, 0, 0]);
    assert.deepEqual(f.draws.map(draw => draw.matrixWorldAutoUpdate), [true, false]);
    assert.equal(f.scene.matrixWorldAutoUpdate, true);

    parent.position.x = 9;
    f.pass.render(f.renderer, null, f.target);
    assert.equal(updates, 2);
    assert.deepEqual(f.draws[3].worldPositions.halo, [12, 0, 0]);
    assert.equal(f.scene.matrixWorldAutoUpdate, true);
  } finally { f.dispose(); }
});

test('matrix reuse preserves caller-managed world matrices and an originally false update flag', () => {
  const f = fixture({ reuseWorldMatrices: true });
  const halo = f.add('halo', new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  halo.position.x = 4;
  f.scene.updateMatrixWorld(true);
  f.scene.matrixWorldAutoUpdate = false;
  halo.position.x = 8;
  try {
    f.pass.render(f.renderer, null, f.target);
    assert.deepEqual(f.draws[1].worldPositions.halo, [4, 0, 0]);
    assert.deepEqual(f.draws.map(draw => draw.matrixWorldAutoUpdate), [false, false]);
    assert.equal(f.scene.matrixWorldAutoUpdate, false);
  } finally { f.dispose(); }
});

for (const original of [true, false]) {
  test(`second draw failure restores the original matrix update flag (${original})`, () => {
    const f = fixture({ reuseWorldMatrices: true });
    const halo = f.add('halo', new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    const material = halo.material;
    f.scene.matrixWorldAutoUpdate = original;
    const render = f.renderer.render;
    let draws = 0;
    f.renderer.render = function (...args) {
      if (++draws === 2) {
        assert.equal(f.scene.matrixWorldAutoUpdate, false);
        throw new Error('second draw failed');
      }
      return render.apply(this, args);
    };
    try {
      assert.throws(() => f.pass.render(f.renderer, null, f.target), /second draw failed/);
      assert.equal(f.scene.matrixWorldAutoUpdate, original);
      assert.equal(halo.material, material);
      assert.equal(f.nebula.children[0].material.uniforms.uSceneDepth.value, null);
      assert.equal(f.renderer.getRenderTarget(), null);
    } finally { f.dispose(); }
  });
}

test('matrix reuse leaves the ordinary single draw and its automatic transforms unchanged', () => {
  const f = fixture({ reuseWorldMatrices: true });
  const surface = f.add('surface', new THREE.MeshBasicMaterial());
  f.nebula.visible = false;
  surface.position.x = 6;
  try {
    f.pass.render(f.renderer, null, f.target);
    assert.equal(f.draws.length, 1);
    assert.deepEqual(f.draws[0].worldPositions.surface, [6, 0, 0]);
    assert.equal(f.draws[0].matrixWorldAutoUpdate, true);
    assert.equal(f.scene.matrixWorldAutoUpdate, true);
    assert.equal(f.copies.length, 0);
    assert.equal(f.pass._depthTarget, null);
  } finally { f.dispose(); }
});

test('no visible or in-view nebula keeps the original single render without allocating depth targets', () => {
  const f = fixture();
  try {
    for (const offscreen of [false, true]) {
      f.nebula.visible = offscreen;
      if (offscreen) { f.camera.lookAt(0, 0, 10000); f.camera.updateMatrixWorld(); }
      f.pass.render(f.renderer, null, f.target);
    }
    assert.equal(f.draws.length, 2);
    assert.equal(f.copies.length, 0);
    assert.equal(f.target.depthTexture, null);
    assert.equal(f.pass._depthTarget, null);
  } finally { f.dispose(); }
});

test('failed rendering restores original material arrays, masks, background, target and clear state', () => {
  const f = fixture(), prior = new THREE.WebGLRenderTarget(8, 8);
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
  const mesh = f.add('ring', [material]);
  mesh.layers.set(4);
  const originals = mesh.material;
  f.renderer.setRenderTarget(prior);
  f.renderer.copyTextureToTexture = () => { throw new Error('depth copy failed'); };
  try {
    assert.throws(() => f.pass.render(f.renderer, null, f.target), /depth copy failed/);
    assert.equal(mesh.material, originals);
    assert.equal(mesh.layers.mask, 1 << 4);
    assert.equal(material.visible, true);
    assert.equal(f.renderer.autoClear, true);
    assert.equal(f.renderer.getRenderTarget(), prior);
    assert.equal(f.target.resolveDepthBuffer, false);
    assert.equal(f.nebula.children[0].material.uniforms.uSceneDepth.value, null);
  } finally { f.dispose(); prior.dispose(); }
});

test('first surface draw failures restore custom RenderPass clear colour and alpha', () => {
  const f = fixture();
  const clearColor = f.renderer.getClearColor(new THREE.Color()), clearAlpha = f.renderer.getClearAlpha();
  const originalMaterial = f.nebula.children[0].material;
  f.pass.clearColor = new THREE.Color(0xff0000);
  f.pass.clearAlpha = .1;
  f.renderer.render = () => { throw new Error('first draw failed'); };
  try {
    assert.throws(() => f.pass.render(f.renderer, null, f.target), /first draw failed/);
    assert.ok(f.renderer.getClearColor(new THREE.Color()).equals(clearColor));
    assert.equal(f.renderer.getClearAlpha(), clearAlpha);
    assert.equal(f.renderer.getRenderTarget(), null);
    assert.equal(f.renderer.autoClear, true);
    assert.equal(f.nebula.children[0].material, originalMaterial);
  } finally { f.dispose(); }
});

test('depth snapshots resize, adapt to composer target changes and release only owned attachments', () => {
  const f = fixture(), other = new THREE.WebGLRenderTarget(16, 8, { depthTexture: new THREE.DepthTexture(16, 8) });
  const borrowed = other.depthTexture;
  let borrowedDisposals = 0, ownDisposals = 0;
  borrowed.addEventListener('dispose', () => borrowedDisposals++);
  try {
    f.pass.render(f.renderer, null, f.target);
    const owned = f.target.depthTexture;
    owned.addEventListener('dispose', () => ownDisposals++);
    f.target.setSize(96, 48);
    f.target.samples = 0;
    f.pass.render(f.renderer, null, f.target);
    assert.equal(f.pass._depthTarget.width, 96);
    assert.equal(f.pass._depthTarget.height, 48);
    f.pass.render(f.renderer, null, other);
    assert.equal(f.pass._depthTarget.width, 16);
    f.pass.dispose();
    assert.equal(f.target.depthTexture, null);
    assert.equal(other.depthTexture, borrowed);
    assert.equal(ownDisposals, 1);
    assert.equal(borrowedDisposals, 0);
  } finally { f.dispose(); other.dispose(); }
});

test('depth unprojection follows translated, rotated and rebased nebula transforms', () => {
  const f = fixture();
  try {
    f.nebula.rotation.z = .4;
    f.nebula.position.set(2100, -400, 800);
    f.nebula.userData.update(f.camera, 0, { quality: 'high' });
    const volume = f.nebula.children[0], point = new THREE.Vector3(.1, -.2, .3);
    const world = volume.localToWorld(point.clone());
    const ndc = world.clone().project(f.camera);
    volume.userData.setSceneDepth(new THREE.DepthTexture(64, 32), 64, 32, f.camera);
    const actual = ndc.clone().applyMatrix4(volume.material.uniforms.uClipToLocal.value);
    assert.ok(actual.distanceTo(point) < 1e-8);
    assert.equal(f.nebula.userData.stats.steps, 48);
    assert.equal(f.nebula.userData.isInView(f.camera), true);
    f.camera.position.addScalar(1e5); f.nebula.position.addScalar(1e5);
    assert.equal(f.nebula.userData.isInView(f.camera), true);
  } finally { f.dispose(); }
});

test('pass scratch retains capacity while releasing scene and material references after each frame', () => {
  const f = fixture(), opaque = new THREE.MeshBasicMaterial(), glow = new THREE.MeshBasicMaterial({depthWrite: false});
  const mixed = f.add('mixed', [opaque, glow]);
  try {
    f.pass.render(f.renderer, null, f.target);
    const records = f.pass._objects, first = records[0], filtered = records.find(record => record.filtered.length === 2).filtered;
    assert.ok(records.every(record => record.object === null && record.original === null && record.filtered.every(value => value === null)));
    assert.ok(f.pass._volumes.every(value => value === null));
    f.pass.render(f.renderer, null, f.target);
    assert.equal(f.pass._objects, records); assert.equal(records[0], first);
    assert.equal(records.find(record => record.filtered.length === 2).filtered, filtered);
    f.scene.remove(mixed); f.pass.render(f.renderer, null, f.target);
    assert.ok(records.every(record => record.object === null && record.original === null));
    mixed.geometry.dispose(); opaque.dispose(); glow.dispose();
    f.nebula.visible = false; f.pass.render(f.renderer, null, f.target);
    assert.equal(records.length, 0);
  } finally {f.dispose();}
});
