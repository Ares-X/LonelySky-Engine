import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createBlackHole} from '../../src/render/blackhole.js';

// Execute the actual scalar GLSL branch condition. Its far depth must apply only
// to optical sky without a forward disk/captured shadow, not to all outward rays.
const hole = createBlackHole({radius: 1});
const source = hole.children[0].material.fragmentShader;
const condition = source.match(/if\s*\(([^)]+)\)\s*\{\s*gl_FragDepth\s*=\s*1\.0\s*;/)[1];
hole.userData.dispose();
const skyDepth = Function('firstDiskDistance', 'b', 'escaped', 'captured', `return ${condition}`);

test('escaped outward proxy rays use sky depth instead of a clamped point before the near plane', () => {
  const camera = new THREE.Vector3(0, 0, 4), direction = new THREE.Vector3(0, 0, 1);
  const b = camera.dot(direction), lineImpact = new THREE.Vector3().crossVectors(camera, direction).length();
  assert.equal(lineImpact, 0);
  assert.equal(camera.clone().addScaledVector(direction, Math.max(0, -b)).length(), 4, 'line closest point is behind the forward ray');
  assert.ok(Math.max(.001, -b) < .01, 'old fallback places the proxy before the fixture near plane');
  assert.equal(skyDepth(-1, b, true, false), true);
  assert.equal(skyDepth(-1, 0, true, false), true);
  assert.equal(skyDepth(-1, -4, true, false), false, 'inbound lens keeps its centre-plane depth');
  assert.equal(skyDepth(-1, b, false, true), false, 'captured shadow keeps optical depth');
  assert.equal(skyDepth(-1, b, false, false), false, 'an unresolved path is not treated as escaped sky');
});

test('outward forward-disk intersections retain their actual positive encounter depth', () => {
  const camera = new THREE.Vector3(3, .8, 0), target = new THREE.Vector3(4, 0, 0);
  const direction = target.clone().sub(camera).normalize(), b = camera.dot(direction);
  const diskNormal = new THREE.Vector3(0, .92847669, .37139068);
  const travel = -camera.dot(diskNormal) / direction.dot(diskNormal);
  const hit = camera.clone().addScaledVector(direction, travel);
  assert.ok(b > 0 && travel > 0);
  assert.ok(hit.distanceTo(target) < 1e-12);
  assert.ok(hit.length() > 2.94 && hit.length() < 5.7, 'fixture crosses the luminous annulus');
  assert.equal(skyDepth(travel, b, true, false), false);
});
