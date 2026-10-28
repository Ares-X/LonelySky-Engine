import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createNebula } from '../../src/render/nebula.js';
import { createBlackHole } from '../../src/render/blackhole.js';
import { createGalaxyHaze } from '../../src/render/galaxy-haze.js';
import { describeCosmicStructures, cosmicDrawDistance, cosmicTrueDistance } from '../../src/cosmic-structures.js';

function cameraFor(reversed) {
  const camera = new THREE.PerspectiveCamera(55, 1.7, .5, 220000);
  Object.defineProperty(camera, 'reversedDepth', { value: reversed });
  const top = camera.near * Math.tan(camera.fov * Math.PI / 360), right = top * camera.aspect;
  camera.projectionMatrix.makePerspective(-right, right, top, -top, camera.near, camera.far, THREE.WebGLCoordinateSystem, reversed);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  return camera;
}
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function scalar(source, names, values) { return Function(...names, 'clamp', 'max', `return ${source};`)(...values, clamp, Math.max); }

for (const reversed of [false, true]) {
  test(`${reversed ? 'reverse' : 'ordinary'} custom optical depth follows the active projection from near to far`, () => {
    const camera = cameraFor(reversed), nebula = createNebula(), hole = createBlackHole({ radius: 1 });
    try {
      for (const object of [nebula, hole]) {
        const shader = object.children[0].material.fragmentShader;
        const assignments = [...shader.matchAll(/gl_FragDepth\s*=\s*([^;]+);/g)].map(match => match[1]);
        const source = assignments.slice(-2)[reversed ? 0 : 1];
        for (const distance of [.5, 1, 20, 10000, 160000, 210000, 220000]) {
          const projected = new THREE.Vector4(0, 0, -distance, 1).applyMatrix4(camera.projectionMatrix);
          const depth = scalar(source, ['clip'], [projected]);
          const reverseDepth = (1 / distance - 1 / camera.far) / (1 / camera.near - 1 / camera.far);
          const expected = reversed ? reverseDepth : 1 - reverseDepth;
          assert.ok(Math.abs(depth - expected) < 1e-12);
        }
      }
    } finally { nebula.userData.dispose(); hole.userData.dispose(); }
  });

  test(`${reversed ? 'reverse' : 'ordinary'} sampled depth unprojects through the real nebula transform`, () => {
    const camera = cameraFor(reversed), nebula = createNebula(), depthTexture = new THREE.DepthTexture(128, 64, THREE.FloatType);
    try {
      camera.position.set(400, -200, 700); camera.lookAt(-100, 500, -12000); camera.updateMatrixWorld();
      nebula.position.set(-300, 220, 700); nebula.rotation.set(.2, -.4, .1); nebula.updateMatrixWorld(true);
      nebula.userData.update(camera, 0); const volume = nebula.children[0];
      volume.userData.setSceneDepth(depthTexture, 128, 64, camera);
      const shader = volume.material.fragmentShader;
      const expressions = [...shader.matchAll(/float surfaceClipDepth=([^;]+);/g)].map(match => match[1]);
      for (const distance of [100, 1000, 10000, 100000]) {
        const world = new THREE.Vector3(.2, -.3, -1).normalize().multiplyScalar(distance).applyMatrix4(camera.matrixWorld);
        const clip = new THREE.Vector4(...world.toArray(), 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
        const sampledDepth = reversed ? clip.z / clip.w : clip.z / clip.w * .5 + .5;
        const z = scalar(expressions[reversed ? 0 : 1], ['surfaceDepth'], [sampledDepth]);
        const recovered = new THREE.Vector4(clip.x / clip.w, clip.y / clip.w, z, 1).applyMatrix4(volume.material.uniforms.uClipToLocal.value);
        recovered.multiplyScalar(1 / recovered.w);
        const expected = volume.worldToLocal(world.clone());
        assert.ok(new THREE.Vector3(recovered.x, recovered.y, recovered.z).distanceTo(expected) < 1e-7);
      }
    } finally { nebula.userData.dispose(); depthTexture.dispose(); }
  });
}

test('V3 volume depth reconstruction uses both actual projection conventions at macro distances', () => {
  const haze = createGalaxyHaze({ structures: true });
  let descriptor;
  for (let x = -4; x < 4 && !descriptor; x++) for (let y = -4; y < 4 && !descriptor; y++) for (let z = -4; z < 4 && !descriptor; z++) descriptor = describeCosmicStructures({ x, y, z })[0];
  haze.userData.setDescriptors([descriptor]);
  try {
    const source = haze.children[0].material.fragmentShader;
    const expressions = [...source.matchAll(/float forward=([^;]+);/g)].map(match => match[1]);
    for (const reversed of [false, true]) {
      const camera = cameraFor(reversed);
      for (const physical of [100, 150000, 1000000, 10000000, 100000000]) {
        const radial = cosmicDrawDistance(physical), clip = new THREE.Vector4(0, 0, -radial, 1).applyMatrix4(camera.projectionMatrix);
        const depth = reversed ? clip.z / clip.w : .5 * clip.z / clip.w + .5;
        const forward = scalar(expressions[reversed ? 0 : 1], ['near', 'far', 'depth'], [camera.near, camera.far, depth]);
        assert.ok(Math.abs(cosmicTrueDistance(forward) - physical) / physical < 3e-8);
      }
    }
  } finally { haze.userData.dispose(); }
});


test('cloud frustum admission agrees across depth conventions before, inside and beyond its support', () => {
  const nebula = createNebula();
  try {
    for (const z of [1000, 40000, 80000, 200000, 260000]) for (const lookingAway of [false, true]) {
      const admissions = [false, true].map(reversed => {
        const camera = cameraFor(reversed);
        camera.position.set(0, 0, z); camera.lookAt(0, 0, lookingAway ? z + 1000 : -9000); camera.updateMatrixWorld();
        return nebula.userData.isInView(camera);
      });
      assert.equal(admissions[0], admissions[1]);
      if (lookingAway || z === 260000) assert.equal(admissions[0], false);
    }
  } finally { nebula.userData.dispose(); }
});
