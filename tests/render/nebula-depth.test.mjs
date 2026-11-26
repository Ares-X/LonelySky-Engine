import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createNebula } from '../../src/render/nebula.js';
import { NebulaRenderPass } from '../../src/render/nebula-render-pass.js';
import { planetMaterial,atmosphereMaterial } from '../../src/render/materials.js';

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
  const draws = [], copies = [], stages = [];
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
      stages.push({stage: 'depth snapshot', resolveDepth: currentTarget.resolveDepthBuffer, storeDepth: currentTarget.storeMultisampledDepthBuffer});
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
        resolveDepth: currentTarget.resolveDepthBuffer, storeDepth: currentTarget.storeMultisampledDepthBuffer });
      stages.push({stage: 'scene draw', resolveDepth: currentTarget.resolveDepthBuffer, storeDepth: currentTarget.storeMultisampledDepthBuffer});
      world.onAfterRender(this, world, activeCamera);
    },
  };
  const add = (name, material, renderOrder = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.name = name; mesh.renderOrder = renderOrder; scene.add(mesh);
    return mesh;
  };
  return { scene, camera, nebula, target, pass, renderer, draws, copies, stages, add,
    dispose() { pass.dispose(); nebula.userData.dispose(); target.dispose(); scene.traverse(o => {
      if (o === nebula.children[0]) return;
      o.geometry?.dispose();
      if (o.material) for (const material of [o.material].flat()) material.dispose();
    }); } };
}

test('streaming planets retain opaque depth coverage in front of optical volumes',()=>{
  const f=fixture(),material=planetMaterial({kind:'rock',seed:1,radius:100,colorA:0x668899,colorB:0xaabbcc});
  const air=atmosphereMaterial(0x668899);
  f.add('fading planet',material);f.add('translucent air',air);
  try{
    assert.equal(material.alphaHash,true);assert.equal(material.transparent,false);
    for(const visibility of [.9999091460814943,.5,.0001]){
      material.uniforms.visibility.value=visibility;f.draws.length=0;
      f.pass.render(f.renderer,null,f.target,.016,false);
      assert.equal(material.depthWrite,true);
      assert.ok(f.draws[0].visible.includes('fading planet'));
      assert.ok(!f.draws[1].visible.includes('fading planet'));
      assert.ok(!f.draws[0].visible.includes('translucent air'));
      assert.ok(f.draws[1].visible.includes('translucent air'));
      assert.equal(material.uniforms.visibility.value,visibility);
    }
  }finally{f.dispose();}
});

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
    assert.deepEqual(f.stages, [
      {stage: 'scene draw', resolveDepth: true, storeDepth: true},
      {stage: 'depth snapshot', resolveDepth: true, storeDepth: true},
      {stage: 'scene draw', resolveDepth: false, storeDepth: true},
    ], 'resolve surface depth once, copy it before translucency, then resolve colour while retaining MSAA depth for depthTest');
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
    f.target.resolveDepthBuffer = original;
    f.target.storeMultisampledDepthBuffer = !original;
    const render = f.renderer.render;
    let draws = 0;
    f.renderer.render = function (...args) {
      if (++draws === 2) {
        assert.equal(f.scene.matrixWorldAutoUpdate, false);
        assert.equal(f.target.resolveDepthBuffer, false);
        assert.equal(f.target.storeMultisampledDepthBuffer, true);
        throw new Error('second draw failed');
      }
      return render.apply(this, args);
    };
    try {
      assert.throws(() => f.pass.render(f.renderer, null, f.target), /second draw failed/);
      assert.equal(f.scene.matrixWorldAutoUpdate, original);
      assert.equal(f.target.resolveDepthBuffer, original);
      assert.equal(f.target.storeMultisampledDepthBuffer, !original);
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
    assert.equal(f.nebula.userData.stats.steps, 96);
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

test('every optical prepare consumes the current opaque snapshot before translucent filtering and draw', () => {
  const f = fixture(), volume = f.nebula.children[0], originalVolume = volume.material, events = [];
  const opaque = f.add('opaque', new THREE.MeshBasicMaterial()), transparent = f.add('transparent', new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  const surfaceMaterial = opaque.material, transparentMaterial = transparent.material;
  const second = f.add('second volume', new THREE.ShaderMaterial({ uniforms: { uVisibility: { value: 1 }, uDensity: { value: 1 } }, transparent: true, depthWrite: false }));
  const secondMaterial = second.material, setDepth = volume.userData.setSceneDepth, render = f.renderer.render, copy = f.renderer.copyTextureToTexture;
  let secondDepth = null;
  volume.userData.setSceneDepth = (...args) => { setDepth(...args);events.push(args[0] ? 'first depth' : 'first clear'); };
  second.userData.setSceneDepth = texture => { secondDepth = texture;events.push(texture ? 'second depth' : 'second clear'); };
  const prepared = label => (renderer, width, height, camera) => {
    events.push(label);assert.equal(renderer, f.renderer);assert.deepEqual([width, height], [64, 32]);assert.equal(camera, f.camera);
    assert.equal(f.renderer.getRenderTarget(), f.target);
    assert.equal(originalVolume.uniforms.uSceneDepth.value, f.copies.at(-1)[1]);assert.equal(secondDepth, f.copies.at(-1)[1]);
    assert.equal(opaque.material, surfaceMaterial);assert.equal(transparent.material.visible, false);
    assert.equal(volume.material.visible, false);assert.equal(second.material.visible, false);
  };
  volume.userData.prepareVolume = prepared('first prepare');second.userData.prepareVolume = prepared('second prepare');
  f.renderer.copyTextureToTexture = (...args) => { const result = copy(...args);events.push('snapshot');return result; };
  f.renderer.render = (...args) => { events.push(events.at(-1) === 'second prepare' ? 'translucent draw' : 'opaque draw');return render(...args); };
  try {
    for (let frame = 0; frame < 2; frame++) {
      events.length = 0;f.pass.render(f.renderer, null, f.target);
      assert.deepEqual(events, ['opaque draw', 'snapshot', 'first depth', 'second depth', 'first prepare', 'second prepare', 'translucent draw', 'first clear', 'second clear']);
      assert.equal(volume.material, originalVolume);assert.equal(second.material, secondMaterial);assert.equal(transparent.material, transparentMaterial);
      assert.equal(originalVolume.uniforms.uSceneDepth.value, null);assert.equal(secondDepth, null);
    }
  } finally { f.dispose(); }
});

for (const reuseWorldMatrices of [false, true]) {
  test(`optical prepare failure restores borrowed materials, depth bindings and pass state (matrix reuse ${reuseWorldMatrices})`, () => {
    const f = fixture({ reuseWorldMatrices }), prior = new THREE.WebGLRenderTarget(8, 8), volume = f.nebula.children[0], failure = new Error('optical prepare failed');
    const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })], mixed = f.add('mixed', materials);
    const originalVolume = volume.material, background = new THREE.Color(0x193847), override = new THREE.MeshBasicMaterial();
    f.scene.background = background;f.scene.overrideMaterial = override;f.renderer.setRenderTarget(prior);
    const color = f.renderer.getClearColor(new THREE.Color()), alpha = f.renderer.getClearAlpha(), storeDepth = f.target.storeMultisampledDepthBuffer;
    f.pass.clearColor = new THREE.Color(0xff3344);f.pass.clearAlpha = .13;
    let borrowedDisposals = 0;for (const material of [...materials, originalVolume]) material.addEventListener('dispose', () => borrowedDisposals++);
    volume.userData.prepareVolume = () => {
      assert.equal(f.draws.length, 1);assert.ok(originalVolume.uniforms.uSceneDepth.value);
      assert.equal(mixed.material[0], materials[0]);assert.equal(mixed.material[1].visible, false);throw failure;
    };
    try {
      assert.throws(() => f.pass.render(f.renderer, null, f.target), error => error === failure);
      assert.equal(f.draws.length, 1);assert.equal(mixed.material, materials);assert.equal(volume.material, originalVolume);
      assert.equal(originalVolume.uniforms.uSceneDepth.value, null);assert.equal(originalVolume.uniforms.uHasSceneDepth.value, false);
      assert.equal(f.scene.background, background);assert.equal(f.scene.overrideMaterial, override);assert.equal(f.scene.matrixWorldAutoUpdate, true);
      assert.equal(f.renderer.getRenderTarget(), prior);assert.equal(f.renderer.autoClear, true);
      assert.ok(f.renderer.getClearColor(new THREE.Color()).equals(color));assert.equal(f.renderer.getClearAlpha(), alpha);
      assert.equal(f.target.resolveDepthBuffer, false);assert.equal(f.target.storeMultisampledDepthBuffer, storeDepth);
      assert.equal(borrowedDisposals, 0);
      assert.ok(f.pass._objects.every(record => record.object === null && record.original === null && record.filtered.every(material => material === null)));
    } finally { f.dispose();prior.dispose();override.dispose(); }
  });
}
