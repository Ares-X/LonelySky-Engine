import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TERRAIN_MESH_VERTEX_CAPACITY, buildTerrainMesh, createMeshTerrainWorkspace, meshTerrainDistance, visitMeshTerrainSweepRoots } from '../src/mesh-terrain.js';
import { createSolidWorkspace, solidDistance, sweepSolid } from '../src/solid-geometry.js';
import { createCollisionWorld } from '../src/collision.js';

const near = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
const output = () => ({ distance: 0, normal: [0, 0, 0] });
function normals(vertices, faces) {
  const result = vertices.map(() => [0, 0, 0]);
  for (const face of faces) {
    const a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]], ab = b.map((n, i) => n - a[i]), ac = c.map((n, i) => n - a[i]);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    for (const index of face) for (let i = 0; i < 3; i++) result[index][i] += n[i];
  }
  return result.map(p => { const size = Math.hypot(...p);return p.map(n => n / size); });
}
function boxInput() {
  const vertices = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  return { center: [0, 0, 0], radius: Math.sqrt(3), vertices, faces, normals: normals(vertices, faces) };
}
function lInput() {
  const polygon = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]], vertices = polygon.map(p => [...p, -1]).concat(polygon.map(p => [...p, 1]));
  const top = [[0, 1, 3], [1, 2, 3], [0, 3, 5], [3, 4, 5]], faces = top.map(f => [f[0], f[2], f[1]]).concat(top.map(f => f.map(n => n + 6)));
  for (let i = 0; i < 6; i++) { const j = (i + 1) % 6;faces.push([i, j, j + 6], [i, j + 6, i + 6]); }
  return { center: [0, 0, 0], radius: 3, vertices, faces, normals: normals(vertices, faces) };
}
function asSolid(mesh) {
  return { id: 'closed-terrain', position: [0, 0, 0], boundsRadius: Math.hypot(...mesh.center) + mesh.radius, shape: { type: 'compound', parts: [], terrainGroups: [mesh] } };
}
function sweep(mesh, start, end, radius = 0, options, w = createSolidWorkspace()) { return sweepSolid(asSolid(mesh), start, end, radius, options, w.result, w); }
function sample(mesh, p, w = createMeshTerrainWorkspace(), out = output()) {
  const result = meshTerrainDistance(mesh, ...p, out, w);assert.notEqual(result, false, w.reason);return result;
}
function boxDistance(p) { const q = p.map(n => Math.abs(n) - 1);return Math.hypot(...q.map(n => Math.max(n, 0))) + Math.min(0, Math.max(...q)); }
function lDistance([x, y, z]) {
  const inXY = x >= 0 && y >= 0 && x <= 2 && y <= 2 && !(x > 1 && y > 1);
  const d = Math.min(Math.hypot(Math.max(0, -x, x - 2), y), Math.hypot(x - 2, Math.max(0, -y, y - 1)),
    Math.hypot(Math.max(0, 1 - x, x - 2), y - 1), Math.hypot(x - 1, Math.max(0, 1 - y, y - 2)),
    Math.hypot(Math.max(0, -x, x - 1), y - 2), Math.hypot(x, Math.max(0, -y, y - 2)));
  const xy = inXY ? -d : d, vertical = Math.abs(z) - 1;
  return Math.hypot(Math.max(xy, 0), Math.max(vertical, 0)) + Math.min(0, Math.max(xy, vertical));
}
function oracleEntry(start, end, radius, distance) {
  const value = t => distance(start.map((n, i) => n + (end[i] - n) * t)) - radius;
  // Sample independent geometry before bisection, so non-convex entry is not
  // incorrectly treated as minimization of a convex distance function.
  let low = 0;
  for (let i = 1; i <= 2048; i++) {
    let high = i / 2048;
    if (value(high) < -1e-10) {
      for (let j = 0; j < 60; j++) { const middle = (low + high) / 2;if (value(middle) > 0) low = middle;else high = middle; }
      return (low + high) / 2;
    }
    low = high;
  }
  return null;
}

test('one-time builder preserves geometry and constructs deterministic bounded balanced leaves', () => {
  const input = lInput(), before = structuredClone(input), mesh = buildTerrainMesh(input), again = buildTerrainMesh(input);
  assert.deepEqual(input, before);assert.equal(mesh.vertices, input.vertices);assert.equal(mesh.faces, input.faces);assert.equal(mesh.normals, input.normals);
  assert.deepEqual(mesh.nodes, again.nodes);assert.deepEqual(mesh.triangleOrder, again.triangleOrder);
  const covered = [];let depth = 0;
  function visit(index, level) {
    depth = Math.max(depth, level);const node = mesh.nodes[index];
    if (node.count > 0) {
      assert.ok(node.count <= 4);assert.equal(node.left, -1);assert.equal(node.right, -1);
      for (let i = node.start; i < node.start + node.count; i++) {
        const triangle = mesh.triangleOrder[i];covered.push(triangle);
        for (const vertex of mesh.faces[triangle]) for (let axis = 0; axis < 3; axis++)
          assert.ok(mesh.vertices[vertex][axis] >= node.min[axis] && mesh.vertices[vertex][axis] <= node.max[axis]);
      }
    } else {
      assert.ok(node.left > index && node.right > index);
      for (const child of [node.left, node.right]) for (let axis = 0; axis < 3; axis++)
        assert.ok(mesh.nodes[child].min[axis] >= node.min[axis] && mesh.nodes[child].max[axis] <= node.max[axis]);
      visit(node.left, level + 1);visit(node.right, level + 1);
    }
  }
  visit(0, 0);assert.ok(depth < 16);assert.ok(mesh.nodes.length <= 2048);
  assert.deepEqual(covered.sort((a, b) => a - b), input.faces.map((_, i) => i));
});

test('construction rejects open, reversed, degenerate and oversized data before query use', () => {
  const open = boxInput();open.faces.pop();assert.throws(() => buildTerrainMesh(open), RangeError);
  const reversed = boxInput();reversed.faces = reversed.faces.map(f => [...f].reverse());assert.throws(() => buildTerrainMesh(reversed), RangeError);
  const degenerate = boxInput();degenerate.faces[0][1] = degenerate.faces[0][0];assert.throws(() => buildTerrainMesh(degenerate), RangeError);
  const invalidBound = boxInput();invalidBound.radius = 1;assert.throws(() => buildTerrainMesh(invalidBound), RangeError);
  const oversized = boxInput();oversized.vertices = new Array(TERRAIN_MESH_VERTEX_CAPACITY+1).fill([0, 0, 0]);oversized.normals = new Array(TERRAIN_MESH_VERTEX_CAPACITY+1).fill([1, 0, 0]);
  assert.throws(() => buildTerrainMesh(oversized), RangeError);
});

test('BVH finite-triangle distance and signed concave interior agree with independent prism oracles', () => {
  const w = createMeshTerrainWorkspace(), out = output();
  for (const [mesh, oracle] of [[buildTerrainMesh(boxInput()), boxDistance], [buildTerrainMesh(lInput()), lDistance]]) {
    for (let i = 0; i < 210; i++) {
      const p = [-2 + (i * 17 % 71) / 17, -2 + (i * 23 % 67) / 16, -2 + (i * 31 % 79) / 19];
      const actual = sample(mesh, p, w, out);near(actual.distance, oracle(p));near(Math.hypot(...actual.normal), 1);
    }
  }
  const notch = sample(buildTerrainMesh(lInput()), [.8, .8, 0]);near(notch.distance, -Math.sqrt(.08));near(notch.normal[0], Math.SQRT1_2);near(notch.normal[1], Math.SQRT1_2);
});

test('deterministic parity handles shared face diagonals, projected edges and a ray through a vertex without retries', () => {
  const cube = buildTerrainMesh(boxInput());
  for (const t of [-.7, 0, .7]) {
    near(sample(cube, [0, t, t]).distance, boxDistance([0, t, t]));
    near(sample(cube, [-2, t, t]).distance, boxDistance([-2, t, t]));
  }
  const input = boxInput();
  const rotate = ([x, y, z]) => [(x + y + z) / Math.sqrt(3), (x - y) / Math.sqrt(2), (x + y - 2 * z) / Math.sqrt(6)];
  input.vertices = input.vertices.map(rotate);input.normals = input.normals.map(rotate);const diagonal = buildTerrainMesh(input);
  for (const x of [-1.4, 0, 1.4]) near(sample(diagonal, [x, 0, 0]).distance, -(1 - Math.abs(x) / Math.sqrt(3)));
  for (const p of [[0, 1, 1], [1, 1, 1], [1, 0, 0], [0, 0, 1]]) {
    const result = sample(cube, p);near(result.distance, 0);assert.ok(result.normal.every(Number.isFinite));near(Math.hypot(...result.normal), 1);
  }
});

test('long thin finite triangles retain their face region instead of losing the Gram determinant', () => {
  const input = boxInput();input.vertices = input.vertices.map(p => [p[0] * 1e8, p[1] * 1e-4, p[2]]);
  input.radius = Math.hypot(1e8, 1e-4, 1);input.normals = normals(input.vertices, input.faces);
  const mesh = buildTerrainMesh(input), result = sample(mesh, [2.5e7, 2e-4, -.4]);
  near(result.distance, 1e-4, 1e-12);near(result.normal[0], 0);near(result.normal[1], 1);near(result.normal[2], 0);
  const hit = sweep(mesh, [2.5e7, 1, -.4], [2.5e7, -1, -.4], 1e-5);
  assert.equal(hit.status, 'hit', hit.reason);near(hit.fraction, (1 - 1.1e-4) / 2, 1e-12);
});

test('real sphere sweeps retain faces, finite rounded edges/corners, tangencies and open non-convex valleys', () => {
  const cube = buildTerrainMesh(boxInput());
  const face = sweep(cube, [-5, 0, 0], [5, 0, 0], 1);assert.equal(face.status, 'hit', face.reason);near(face.fraction, .3);
  const y = 1.999, edge = sweep(cube, [-5, y, 0], [5, y, 0], 1);
  assert.equal(edge.status, 'hit', edge.reason);near(edge.fraction, (4 - Math.sqrt(1 - (y - 1) ** 2)) / 10);
  near(edge.normal[0], -Math.sqrt(1 - (y - 1) ** 2));near(edge.normal[1], y - 1);near(edge.normal[2], 0);
  const corner = sweep(cube, [-5, 2, 2], [5, 2, 2], 2);assert.equal(corner.status, 'hit', corner.reason);near(corner.fraction, (4 - Math.sqrt(2)) / 10);
  near(corner.normal[0], -Math.SQRT1_2);near(corner.normal[1], .5);near(corner.normal[2], .5);
  for (const [start, end, radius] of [
    [[-5, 2, 0], [5, 2, 0], 1], [[-5, 1.9, 1.9], [5, 1.9, 1.9], 1], [[-2, 0, 0], [-3, 0, 0], 1],
  ]) assert.equal(sweep(cube, start, end, radius).status, 'clear');
  const touching = sweep(cube, [-2, 0, 0], [-1, 0, 0], 1);assert.equal(touching.status, 'hit');assert.equal(touching.fraction, 0);
  const concave = buildTerrainMesh(lInput());
  assert.equal(sweep(concave, [1.5, 1.5, -5], [1.5, 1.5, 5], .1).status, 'clear');
  assert.equal(sweep(concave, [1.1, 1.8, 0], [1.8, 1.1, 0], .1).status, 'clear');
  const throughSolid = sweep(concave, [.8, .8, -5], [.8, .8, 5], .1);assert.equal(throughSolid.status, 'hit');near(throughSolid.fraction, .39);
});

test('seeded real sweeps match independent non-convex distance entry measurements', () => {
  let state = 591093;const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0;return state / 4294967296; };
  const w = createSolidWorkspace();
  for (const [mesh, oracle] of [[buildTerrainMesh(boxInput()), boxDistance], [buildTerrainMesh(lInput()), lDistance]]) for (let i = 0; i < 70; i++) {
    const start = [-4, random() * 6 - 3, random() * 6 - 3], end = [4, random() * 6 - 3, random() * 6 - 3], radius = .1 + random() * .7;
    const expected = oracleEntry(start, end, radius, oracle), actual = sweep(mesh, start, end, radius, undefined, w);
    assert.notEqual(actual.status, 'failed', actual.reason);
    if (expected === null) assert.equal(actual.status, 'clear');else { assert.equal(actual.status, 'hit');near(actual.fraction, expected, 2e-8); }
  }
});

test('high speed, world-frame transforms and real overlap recovery retain the shared mesh boundary', () => {
  const mesh = buildTerrainMesh(boxInput()), hit = sweep(mesh, [-1e7, 0, 0], [1e7, 0, 0], 1);
  assert.equal(hit.status, 'hit', hit.reason);near(hit.fraction, (1e7 - 2) / 2e7, 1e-12);
  const solid = asSolid(mesh);solid.frame = [0, 0, -1, 0, 1, 0, 1, 0, 0];solid.position = [1e8, -2e8, 3e8];
  const world = p => [solid.position[0] - p[2], solid.position[1] + p[1], solid.position[2] + p[0]], w = createSolidWorkspace();
  const transformed = sweepSolid(solid, world([-5, 0, 0]), world([5, 0, 0]), 1, undefined, w.result, w);
  assert.equal(transformed.status, 'hit', transformed.reason);near(transformed.fraction, .3, 1e-8);near(transformed.normal[2], -1);
  const collision = createCollisionWorld({ sector: () => [], solidProvider: () => [asSolid(mesh)], shipRadius: .5 });
  const recovered = collision.ensureSafe(0, [0, 0, 0], [0, 0, 0]);assert.equal(recovered.failure, undefined);assert.equal(recovered.corrected, true);
  assert.ok(solidDistance(asSolid(mesh), recovered.position).distance >= .5);
});

test('query/root budgets fail explicitly without publishing partial distances or unbounded candidate storage', () => {
  const mesh = buildTerrainMesh(boxInput()), out = { distance: 123, normal: [7, 8, 9] }, tinyDistance = createMeshTerrainWorkspace({ maxDistanceNodes: 1 });
  assert.equal(meshTerrainDistance(mesh, 3, 0, 0, out, tinyDistance), false);assert.equal(tinyDistance.reason, 'mesh-distance-node-budget');assert.deepEqual(out, { distance: 123, normal: [7, 8, 9] });
  const collect = (t, context) => { context.push(t);return true; }, roots = [];
  for (const [options, reason] of [[{ maxSweepNodes: 1 }, 'mesh-sweep-node-budget'], [{ maxRootTests: 1 }, 'mesh-root-test-budget'], [{ maxRoots: 1 }, 'mesh-root-budget']]) {
    const w = createMeshTerrainWorkspace(options);assert.equal(visitMeshTerrainSweepRoots(mesh, [-5, 0, 0], [10, 0, 0], 1, w, collect, roots), false);assert.equal(w.reason, reason);
  }
  const w = createMeshTerrainWorkspace();assert.equal(visitMeshTerrainSweepRoots(mesh, [-5, 0, 0], [10, 0, 0], 1, w, () => false), false);assert.equal(w.reason, 'mesh-root-visitor');
  const failed = sweep(mesh, [-5, 0, 0], [5, 0, 0], 1, { maxIterations: 1 });assert.equal(failed.status, 'failed');assert.equal(failed.reason, 'solid-root-budget');assert.equal(failed.safeFraction, 0);
});

