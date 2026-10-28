import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCosmicBodies } from '../../src/render/cosmic-bodies.js';

const frame = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function fixture(kind = 'ring') {
  const body = { id: 'physical-fixture', kind, radius: 1000000, halfWidth: .02, thickness: .0005, phase: .3,
    center: [2000000, 30000, -4000000], frame, light: [.5, .4, -.8], tint: [.5, .58, .64],
    shape: kind === 'ring' ? { type: 'compound', parts: [
      { type: 'annular-sector-slab', innerRadius: 999100, outerRadius: 1000700, minY: -22000, maxY: 21000, gapCenter: .42, gapHalfAngle: .27 },
      { type: 'annular-sector-slab', innerRadius: 998600, outerRadius: 1000900, minY: 21000, maxY: 24000, gapCenter: .48, gapHalfAngle: .31 },
    ] } : { type: 'sphere', radius: 1000000 } };
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000);
  camera.position.set(1300, -100, 12000);camera.lookAt(1200000, 80000, -1000000);camera.updateMatrixWorld();
  const group = createCosmicBodies();
  return { group, body, camera, update: () => group.userData.update({ body, camera, viewportHeight: 720, pixelRatio: 1.25 }) };
}

test('physical solids carry the catalogue bounds and every independent breach into the shader', () => {
  const { group, body, update } = fixture();
  try {
    update();
    const u = group.children[0].material.uniforms;
    assert.equal(u.uSectionCount.value, 2);
    assert.deepEqual(u.uSections.value[0].toArray(), [.9991, 1.0007, -.022, .021]);
    assert.deepEqual(u.uGaps.value[0].toArray(), [.42, .27]);
    assert.deepEqual(u.uSections.value[1].toArray(), [.9986, 1.0009, .021, .024]);
    assert.deepEqual(u.uGaps.value[1].toArray(), [.48, .31]);
    body.shape.parts[0].gapHalfAngle = .12;
    body.shape.parts[0].minY = -40000;
    update();
    assert.equal(u.uGaps.value[0].y, .12, 'no renderer-local rule replaces a changed gap');
    assert.equal(u.uSections.value[0].z, -.04);
    assert.equal(group.children[1].visible, false);
  } finally { group.userData.dispose(); }
});

test('the physical ray remains correct after camera rotation, floating-origin movement and viewport changes', () => {
  const { group, body, camera, update } = fixture('dark-world');
  try {
    update();
    const u = group.children[0].material.uniforms;
    const centreUniform = u.uBodyCenter.value, cameraUniform = u.uCameraRotation.value, sections = u.uSections.value;
    const direction = new THREE.Vector3(0, 0, 1).applyMatrix4(u.uInverseProjection.value).normalize().applyMatrix3(u.uCameraRotation.value);
    const expected = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(direction.distanceTo(expected) < 1e-12);
    assert.ok(direction.clone().applyMatrix3(u.uViewRotation.value).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-12);
    const oldSize = u.uPixelAngle.value;
    camera.position.addScalar(9000000);camera.lookAt(0, 0, 0);body.center[0] -= 9000000;
    group.userData.update({ body, camera, viewportHeight: 1440, pixelRatio: 1.25 });
    assert.equal(u.uPixelAngle.value, oldSize / 2);
    assert.equal(u.uBodyCenter.value.x, -7);
    assert.equal(u.uBodyCenter.value, centreUniform);
    assert.equal(u.uCameraRotation.value, cameraUniform);
    assert.equal(u.uSections.value, sections, 'stable update workspaces');
    assert.equal(group.children[0].frustumCulled, false, 'physical 4M distance is never clipped as a small proxy mesh');
  } finally { group.userData.dispose(); }
});

test('opaque bodies and translucent rings have separate depth ownership and switch without stale geometry', () => {
  const { group, body, camera, update } = fixture('gas-giant');
  try {
    body.ringed = true;update();
    const [solid, overlay] = group.children;
    assert.equal(solid.material.depthWrite, true);
    assert.equal(solid.material.transparent, false);
    assert.equal(overlay.material.depthWrite, false);
    assert.equal(overlay.material.depthTest, true);
    assert.equal(overlay.material.transparent, true);
    assert.equal(overlay.visible, true);
    body.kind = 'stellar-giant';body.ringed = false;body.prominences = [{ axis: [0, 1, 0], radii: [.06, .1] }];update();
    assert.equal(overlay.visible, true);
    assert.deepEqual(solid.material.uniforms.uPlasmaAxes.value[0].toArray(), [0, 1, 0]);
    body.prominences = [];update();
    assert.equal(overlay.visible, false);
    assert.deepEqual(solid.material.uniforms.uPlasmaAxes.value[0].toArray(), [0, 0, 0]);
    group.userData.update({ body: null, camera, viewportHeight: 720 });
    assert.equal(group.visible, false);
  } finally { group.userData.dispose(); }
});

test('a fixed-range multi-body query keeps simultaneous solids and reuses slots when the query changes', () => {
  const { group, body } = fixture('dark-world');
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000);
  const second = { ...body, id: 'second', center: [2000000, 0, -4000000] };
  const behind = { ...body, id: 'behind', center: [0, 0, 4000000] };
  body.center = [0, 0, -4000000];
  try {
    group.userData.update({ bodies: [body, second, behind], camera, viewportHeight: 720 });
    assert.equal(group.children.length, 6);
    assert.equal(group.children[0].visible, true);assert.equal(group.children[2].visible, true);
    assert.equal(group.children[4].visible, false, 'physical support is wholly behind the near plane');
    assert.equal(group.children[0].geometry, group.children[4].geometry);
    const slot = group.children[2], material = slot.material;
    const bounds = material.uniforms.uScreenBounds.value;
    for (let i = 0; i < 160; i++) {
      const y = 1 - (i + .5) / 80, angle = i * 2.399963229728653;
      const point = new THREE.Vector3(Math.sqrt(1 - y * y) * Math.cos(angle), y, Math.sqrt(1 - y * y) * Math.sin(angle));
      point.multiplyScalar(second.radius).add(new THREE.Vector3().fromArray(second.center)).project(camera);
      if (point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1)
        assert.ok(point.x >= bounds.x && point.x <= bounds.z && point.y >= bounds.y && point.y <= bounds.w, 'projected solid fits its conservative screen quad');
    }
    group.userData.update({ bodies: [second], camera, viewportHeight: 720 });
    assert.equal(group.children[2], slot);assert.equal(slot.material, material);
    assert.equal(slot.visible, false);assert.equal(group.children[4].visible, false);
    group.userData.update({ bodies: [], camera, viewportHeight: 720 });
    assert.equal(group.visible, false);
  } finally { group.userData.dispose(); }
});

test('far partial visibility blends without owning depth and shares physical transparent ordering with overlays', () => {
  const { group, body } = fixture('gas-giant');
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000);
  body.center = [0, 0, -28000000];body.ringed = true;body.visibility = .5;
  const near = { ...body, center: [0, 0, -4000000], visibility: 1 };
  try {
    group.userData.update({ bodies: [near, body], camera, viewportHeight: 720 });
    const [nearSurface, nearOverlay, farSurface, farOverlay] = group.children;
    assert.equal(nearSurface.material.transparent, false);assert.equal(nearSurface.material.depthWrite, true);
    assert.equal(farSurface.material.transparent, true);assert.equal(farSurface.material.depthWrite, false);
    assert.equal(farSurface.material.uniforms.uVisibility.value, .5);
    assert.equal(farSurface.renderOrder, farOverlay.renderOrder);
    assert.ok(farSurface.renderOrder < nearOverlay.renderOrder, 'far surface and overlay draw before the near overlay');
    body.visibility = 0;
    group.userData.update({ bodies: [body], camera, viewportHeight: 720 });
    assert.equal(nearSurface.visible, false);assert.equal(nearOverlay.visible, false);
    body.visibility = 1;
    group.userData.update({ bodies: [body], camera, viewportHeight: 720 });
    assert.equal(nearSurface.material.transparent, false);assert.equal(nearSurface.material.depthWrite, true);
    assert.equal(nearSurface.material.uniforms.uVisibility.value, 1);
  } finally { group.userData.dispose(); }
});

test('dispose releases each owned GPU resource once and retains borrowed texture ownership', () => {
  const texture = new THREE.Texture(), group = createCosmicBodies({ surfaceTexture: texture, cloudTexture: texture, stellarTexture: texture });
  let textures = 0, geometries = 0, materials = 0;
  texture.addEventListener('dispose', () => textures++);
  group.children[0].geometry.addEventListener('dispose', () => geometries++);
  for (const mesh of group.children) mesh.material.addEventListener('dispose', () => materials++);
  group.userData.dispose();group.userData.dispose();
  assert.equal(geometries, 1);assert.equal(materials, 2);assert.equal(textures, 0);
  assert.equal(group.children.length, 0);assert.equal(group.visible, false);
  group.userData.update({ body: {}, camera: null });
  assert.equal(group.visible, false, 'late updates cannot revive a disposed surface');
  texture.dispose();
});
