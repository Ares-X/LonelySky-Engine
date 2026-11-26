import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TERRAIN_MESH_VERTEX_CAPACITY, buildTerrainMesh, createMeshTerrainWorkspace, meshTerrainDistance, visitMeshTerrainSweepRoots } from '../src/mesh-terrain.js';
import { createSolidWorkspace, solidDistance, sweepSolid } from '../src/solid-geometry.js';
import { createCollisionWorld } from '../src/collision.js';
import { createRingHabitat } from '../src/ring-habitat.js';
import { cosmicRingParts } from '../src/cosmic-bodies.js';

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

let habitat;
function productionMesh() {
  if (!habitat) { const options = { radius: 900000, halfWidth: .022, thickness: .0005, phase: 1.3, broken: false, theme: 'silver-dust', seed: '0' };habitat = createRingHabitat({ ...options, parts: cosmicRingParts(options) }); }
  return habitat.terrainGroups[4];
}
function referenceMeshDistance(mesh, local) {
  const triangle = new THREE.Triangle(), p = new THREE.Vector3(...local), q = new THREE.Vector3();let squared = Infinity, angle = 0;
  for (const face of mesh.faces) {
    const a = mesh.vertices[face[0]], b = mesh.vertices[face[1]], c = mesh.vertices[face[2]];
    triangle.a.fromArray(a);triangle.b.fromArray(b);triangle.c.fromArray(c);triangle.closestPointToPoint(p, q);squared = Math.min(squared, p.distanceToSquared(q));
    const aa = a.map((n, i) => n - local[i]), bb = b.map((n, i) => n - local[i]), cc = c.map((n, i) => n - local[i]);
    const la = Math.hypot(...aa), lb = Math.hypot(...bb), lc = Math.hypot(...cc), dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const determinant = aa[0] * (bb[1] * cc[2] - bb[2] * cc[1]) + aa[1] * (bb[2] * cc[0] - bb[0] * cc[2]) + aa[2] * (bb[0] * cc[1] - bb[1] * cc[0]);
    angle += 2 * Math.atan2(determinant, la * lb * lc + dot(aa, bb) * lc + dot(bb, cc) * la + dot(cc, aa) * lb);
  }
  return (Math.abs(angle) > Math.PI * 2 ? -1 : 1) * Math.sqrt(squared);
}
function faceGeometry(mesh, index) {
  const face = Array.isArray(index) ? index : mesh.faces[index], a = new THREE.Vector3(...mesh.vertices[face[0]]), b = new THREE.Vector3(...mesh.vertices[face[1]]), c = new THREE.Vector3(...mesh.vertices[face[2]]);
  const point = a.clone().add(b).add(c).multiplyScalar(1 / 3), normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  const line = new THREE.Line3(), closest = new THREE.Vector3();let clearance = Infinity;
  for (let i = 0; i < 3; i++) {
    line.start.fromArray(mesh.vertices[face[i]]);line.end.fromArray(mesh.vertices[face[(i + 1) % 3]]);line.closestPointToPoint(point, true, closest);clearance = Math.min(clearance, closest.distanceTo(point));
  }
  const world = point.clone().add(new THREE.Vector3(...mesh.center));
  return { point, normal, clearance, upright: -(normal.x * world.x + normal.z * world.z) / Math.hypot(world.x, world.z) };
}
function referenceRayFace(mesh, origin, direction) {
  const ray = new THREE.Ray(origin, direction), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), point = new THREE.Vector3();
  let nearest = Infinity, first = -1;
  for (let i = 0; i < mesh.faces.length; i++) {
    const face = mesh.faces[i];a.fromArray(mesh.vertices[face[0]]);b.fromArray(mesh.vertices[face[1]]);c.fromArray(mesh.vertices[face[2]]);
    if (ray.intersectTriangle(a, b, c, false, point)) { const distance = origin.distanceTo(point);if (distance < nearest) { nearest = distance;first = i; } }
  }
  return first;
}
// Independent sphere entry: convex minimization and bisection of Three.js's
// closest-point distance to each triangle, with no CPU CCD root equations or BVH.
function referenceSphereEntry(mesh, start, end, radius) {
  const triangle = new THREE.Triangle(), point = new THREE.Vector3(), closest = new THREE.Vector3(), direction = end.clone().sub(start);
  let first = 1, face = -1;
  for (let i = 0; i < mesh.faces.length; i++) {
    const indices = mesh.faces[i];triangle.a.fromArray(mesh.vertices[indices[0]]);triangle.b.fromArray(mesh.vertices[indices[1]]);triangle.c.fromArray(mesh.vertices[indices[2]]);
    const squared = t => { point.copy(start).addScaledVector(direction, t);triangle.closestPointToPoint(point, closest);return point.distanceToSquared(closest); };
    let low = 0, high = 1;
    for (let iteration = 0; iteration < 60; iteration++) {
      const a = (2 * low + high) / 3, b = (low + 2 * high) / 3;if (squared(a) < squared(b)) high = b;else low = a;
    }
    const minimum = (low + high) / 2;
    if (squared(minimum) >= radius * radius - 1e-8) continue;
    low = 0;high = minimum;
    for (let iteration = 0; iteration < 60; iteration++) { const middle = (low + high) / 2;if (squared(middle) > radius * radius) low = middle;else high = middle; }
    const entry = (low + high) / 2;if (entry < first) { first = entry;face = i; }
  }
  return { fraction: first, face };
}
function assertClosedFaces(mesh, faceIndices, expectedBoundary = []) {
  const edges = new Map();
  for (const index of faceIndices) {
    const face = mesh.faces[index];
    assert.ok(new Set(face).size === 3);
    for (let edge = 0; edge < 3; edge++) {
      const a = face[edge], b = face[(edge + 1) % 3], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const entry = edges.get(key) ?? { count: 0, balance: 0 };entry.count++;entry.balance += a < b ? 1 : -1;edges.set(key, entry);
    }
  }
  const boundary = [];
  for (const [key, edge] of edges) {
    if (edge.count === 1) boundary.push(key);else { assert.equal(edge.count, 2, 'every internal edge has two incident faces');assert.equal(edge.balance, 0, 'incident faces have opposite edge winding'); }
  }
  assert.deepEqual(boundary.sort(), [...expectedBoundary].sort());
}

test('actual closed heightgrid BVH agrees with independent Three.js nearest triangles and solid-angle sign', () => {
  const mesh = productionMesh(), w = createMeshTerrainWorkspace(), out = output(), bounds = mesh.nodes[0];
  for (const patch of habitat.terrainGroups) {
    assert.ok(patch.vertices.length <= 2048);assert.ok(patch.faces.length <= 4096);assert.ok(patch.nodes.length <= 2048);
    assert.ok(patch.refinedFaces.length <= 2, 'detail is a finite set of physical rock sites');
  }
  assertClosedFaces(mesh, mesh.faces.map((_, i) => i));
  assert.ok(mesh.refinedFaces.length > 0);
  for (const refined of mesh.refinedFaces) {
    assert.ok(refined.faces.length > 1 && refined.faces.includes(refined.face));
    const boundary = refined.base.map((a, i) => { const b = refined.base[(i + 1) % 3];return `${Math.min(a, b)}:${Math.max(a, b)}`; });
    assertClosedFaces(mesh, refined.faces, boundary);
    const original = faceGeometry(mesh, refined.base), vertices = new Set(refined.faces.flatMap(index => mesh.faces[index]));
    let raised = 0, transitionVertices = 0, rockVertices = 0;
    for (const vertex of vertices) if (!refined.base.includes(vertex)) {
      assert.ok(mesh.vertexUV[vertex]);
      const height = new THREE.Vector3(...mesh.vertices[vertex]).sub(original.point).dot(original.normal);
      const world = new THREE.Vector3(...mesh.vertices[vertex]).add(new THREE.Vector3(...mesh.center));
      const radialHeight = height / (-(original.normal.x * world.x + original.normal.z * world.z) / Math.hypot(world.x, world.z));
      assert.ok(radialHeight >= -1e-8);
      if (Math.abs(radialHeight) < 1e-8) assert.equal(mesh.surfaceKinds[vertex], 0, 'the unchanged slope cannot become bare rock');
      if (mesh.surfaceKinds[vertex] === 0) { assert.ok(radialHeight <= 6 + 1e-8);transitionVertices++; }
      else {
        assert.equal(mesh.surfaceKinds[vertex], 1);assert.ok(radialHeight > 0);
        raised = Math.max(raised, radialHeight);rockVertices++;
      }
    }
    assert.ok(transitionVertices > 0 && rockVertices > 0, 'a natural-material transition surrounds the finite raised rock');
    assert.ok(raised > 0, 'the replacement triangles have real raised geometry above the original face');
  }
  let state = 2930;const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0;return state / 4294967296; };
  for (let i = 0; i < 24; i++) {
    const local = bounds.min.map((n, axis) => n + (bounds.max[axis] - n) * (random() * 1.2 - .1)), point = local.map((n, axis) => n + mesh.center[axis]);
    near(sample(mesh, point, w, out).distance, referenceMeshDistance(mesh, local), 2e-7);assert.ok(w.nodeVisits <= 4096);
  }
  for (const vertex of mesh.vertices) {
    const point = vertex.map((n, i) => n + mesh.center[i]), result = sample(mesh, point, w, out);
    assert.ok(Math.abs(result.distance) < 1e-8);assert.ok(result.normal.every(Number.isFinite));near(Math.hypot(...result.normal), 1, 1e-8);
  }
});

test('independent nearest/sign oracles cover both sides of the retained refined rock triangles', () => {
  const mesh = productionMesh(), w = createMeshTerrainWorkspace(), out = output();let positive = 0, negative = 0;
  for (const refined of mesh.refinedFaces) for (const index of [refined.faces[0], refined.faces[Math.floor(refined.faces.length / 2)], refined.faces.at(-1)]) {
    const { point, normal } = faceGeometry(mesh, index);
    for (const offset of [-.5, .5]) {
      const local = point.clone().addScaledVector(normal, offset), world = local.clone().add(new THREE.Vector3(...mesh.center)), expected = referenceMeshDistance(mesh, local.toArray());
      near(sample(mesh, world.toArray(), w, out).distance, expected, 2e-7);
      assert.ok(expected * offset > 0, 'the independent closed-mesh oracle distinguishes each face exterior from its interior');
      if (expected > 0) positive++;else if (expected < 0) negative++;
    }
  }
  assert.ok(positive > 0 && negative > 0, 'new finite rock clusters are checked as actual closed solid boundaries');
});

test('exposed refined steep and top rock facets block zero/ship-radius high-speed crossings with real face normals', () => {
  const mesh = productionMesh(), span = mesh.radius * 3, center = new THREE.Vector3(...mesh.center), w = createSolidWorkspace();let tested = 0;
  // The compact clusters have smaller facets than the former broad platforms.
  // Select representative exposed steep/top faces across the retained sites,
  // using only geometry and independent rays, never the physics hit result.
  const candidates = mesh.refinedFaces.flatMap(refined => {
    const base = faceGeometry(mesh, refined.base);
    return refined.faces.map(index => ({ index, ...faceGeometry(mesh, index), base }));
  })
    .filter(face => mesh.faces[face.index].some(vertex => mesh.surfaceKinds[vertex] === 1)
      && face.point.clone().sub(face.base.point).dot(face.base.normal) > 1e-6)
    .sort((a, b) => b.clearance - a.clearance);
  for (const upright of [value => value < .5, value => value >= .85]) {
    const representatives = candidates.filter(face => upright(face.upright)
      && referenceRayFace(mesh, face.point.clone().addScaledVector(face.normal, span), face.normal.clone().negate()) === face.index).slice(0, 2);
    assert.equal(representatives.length, 2, 'the actual retained geometry provides two exposed representatives of each orientation');
    for (const face of representatives) {
      const startLocal = face.point.clone().addScaledVector(face.normal, span), endLocal = face.point.clone().addScaledVector(face.normal, -span);
      const expectedSphere = referenceSphereEntry(mesh, startLocal, endLocal, 8);
      assert.ok(expectedSphere.face >= 0 && expectedSphere.fraction < .5);
      // A finite-radius sphere can reach a neighboring microfold before the
      // central ray face. Its first triangle and contact normal come from the
      // independent full-mesh closest-point oracle, not a planar radius offset.
      const sphereCenter = startLocal.clone().lerp(endLocal, expectedSphere.fraction), sphereFace = mesh.faces[expectedSphere.face];
      const sphereTriangle = new THREE.Triangle(...sphereFace.map(index => new THREE.Vector3(...mesh.vertices[index])));
      const sphereClosest = sphereTriangle.closestPointToPoint(sphereCenter, new THREE.Vector3()), sphereNormal = sphereCenter.clone().sub(sphereClosest).normalize();
      near(referenceMeshDistance(mesh, sphereCenter.toArray()), 8, 2e-7);
      const start = startLocal.clone().add(center).toArray(), end = endLocal.clone().add(center).toArray();
      for (const radius of [0, 8]) {
        assert.ok(referenceMeshDistance(mesh, startLocal.toArray()) > radius);assert.ok(referenceMeshDistance(mesh, endLocal.toArray()) > radius);
        const hit = sweep(mesh, start, end, radius, undefined, w);
        assert.equal(hit.status, 'hit', hit.reason);near(hit.fraction, radius === 0 ? .5 : expectedSphere.fraction, 1e-10);
        if (radius === 0) assert.equal(hit.feature, 'mesh-face');
        const expectedNormal = radius === 0 ? face.normal : sphereNormal;
        for (let axis = 0; axis < 3; axis++) near(hit.normal[axis], expectedNormal.getComponent(axis), radius === 0 ? 1e-12 : 2e-8);
        const safe = start.map((n, axis) => n + (end[axis] - n) * hit.safeFraction - mesh.center[axis]);
        assert.ok(referenceMeshDistance(mesh, safe) >= radius - 2e-7);tested++;
      }
    }
  }
  assert.ok(tested >= 8);
});

test('a real exposed face keeps its geometric normal at contact and blocks a radius-zero crossing', () => {
  const options = { radius: 900000, halfWidth: .022, thickness: .0005, phase: 1.3, broken: false, theme: 'silver-dust', seed: 'habitat-fixture' };
  const mesh = createRingHabitat({ ...options, parts: cosmicRingParts(options) }).terrainGroups[4], face = mesh.faces[518];
  const a = mesh.vertices[face[0]], b = mesh.vertices[face[1]], c = mesh.vertices[face[2]], u = b.map((n, i) => n - a[i]), v = c.map((n, i) => n - a[i]);
  const raw = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], length = Math.hypot(...raw), normal = raw.map(n => n / length);
  const point = a.map((n, i) => mesh.center[i] + (n + b[i] + c[i]) / 3), start = point.map((n, i) => n + normal[i] * 10), end = point.map((n, i) => n - normal[i] * 10);
  const w = createMeshTerrainWorkspace(), out = output();
  near(sample(mesh, start, w, out).distance, 10, 1e-8);near(sample(mesh, end, w, out).distance, -10, 1e-8);
  for (const offset of [-1e-8, 0, 1e-8]) {
    const p = point.map((n, i) => n + normal[i] * offset), result = sample(mesh, p, w, out);
    assert.equal(result.feature, 'mesh-face');assert.equal(result.face, 518);
    for (let i = 0; i < 3; i++) near(result.normal[i], normal[i], 1e-12);
  }
  const hit = sweep(mesh, start, end, 0);
  assert.equal(hit.status, 'hit', hit.reason);near(hit.fraction, .5, 1e-10);
  for (let i = 0; i < 3; i++) near(hit.normal[i], normal[i], 1e-12);
  const safe = start.map((n, i) => n + (end[i] - n) * hit.safeFraction);assert.ok(sample(mesh, safe, w, out).distance >= -1e-8);
});

test('production queries reuse all instance storage and high-level sweep pools after warming', () => {
  const mesh = productionMesh(), w = createMeshTerrainWorkspace(), out = output(), point = mesh.vertices[300].map((n, i) => n + mesh.center[i]);
  sample(mesh, point, w, out);const retained = [w.stack, w.closest, w.closest.point, w.closest.normal, out.normal];
  for (let i = 0; i < 20; i++) sample(mesh, point, w, out);
  assert.deepEqual([w.stack, w.closest, w.closest.point, w.closest.normal, out.normal].map((v, i) => v === retained[i]), [true, true, true, true, true]);
  const solidWork = createSolidWorkspace(), cube = buildTerrainMesh(boxInput());sweep(cube, [-5, 0, 0], [5, 0, 0], 1, undefined, solidWork);
  const pool = solidWork.candidates, stack = solidWork.terrain.stack;
  for (let i = 0; i < 20; i++) assert.equal(sweep(cube, [-5, 0, 0], [5, 0, 0], 1, undefined, solidWork).status, 'hit');
  assert.equal(solidWork.candidates, pool);assert.equal(solidWork.terrain.stack, stack);
});

test('large closed torus retains its open hole, analytic axis entries and finite budget failures with reused workspaces', t => {
  const major = 128, minor = 64, R = 50, r = 10, vertices = [], faces = [], vertexNormals = [];
  const index = (i, j) => (i % major) * minor + j % minor;
  for (let i = 0; i < major; i++) for (let j = 0; j < minor; j++) {
    const theta = 2 * Math.PI * i / major, phi = 2 * Math.PI * j / minor, c = Math.cos(phi), s = Math.sin(phi);
    vertices.push([(R + r * c) * Math.cos(theta), r * s, (R + r * c) * Math.sin(theta)]);
    vertexNormals.push([c * Math.cos(theta), s, c * Math.sin(theta)]);
    // dtheta x dphi points inward for this Y-axis parametrization.
    const a = index(i, j), b = index(i + 1, j), c0 = index(i + 1, j + 1), d = index(i, j + 1);
    faces.push([a, c0, b], [a, d, c0]);
  }
  const mesh = buildTerrainMesh({center: [0, 0, 0], radius: R + r, vertices, faces, normals: vertexNormals});
  const solid = asSolid(mesh), w = createSolidWorkspace(), distanceWork = createMeshTerrainWorkspace(), out = output();
  const stack = distanceWork.stack, terrainStack = w.terrain.stack, closest = distanceWork.closest;
  // At the hole centre the nearest inner polygon edge is its apothem, not
  // the smooth torus's radius 40; this tests the actual finite mesh topology.
  near(sample(mesh, [0, 0, 0], distanceWork, out).distance, (R - r) * Math.cos(Math.PI / major), 1e-8);
  const axisX = 0;
  const start = [axisX, 0, -100], end = [axisX, 0, 100];
  const axisSweep = radius => sweepSolid(solid, start, end, radius, undefined, w.result, w);
  // On this axis the rounded first shared-edge intersection is z=-60. Its r7 Minkowski
  // boundary is exactly z=-67, independently of triangle discretization.
  let hit = axisSweep(7);assert.equal(hit.status, 'hit', hit.reason);near(hit.fraction, (100 - R - r - 7) / 200, 1e-10);
  near(hit.normal[0], 0, 1e-8);near(hit.normal[1], 0, 1e-8);near(hit.normal[2], -1, 1e-8);
  const sphereEntry = hit.fraction;
  const candidates = w.candidates; // Capture after the one-time terrain warmup.
  hit = axisSweep(0);assert.equal(hit.status, 'hit', hit.reason);near(hit.fraction, (100 - R - r) / 200, 1e-10);
  // A mesh vertex has four valid adjacent outward face normals, not the
  // unique smooth-torus normal. The planar cell normal follows from its
  // angular midpoints; no queried face index is used to construct the oracle.
  const pointRayEntry = hit.fraction, pointMeshes = w.pointMeshes, pointFaces = w.pointFaces;
  let bestNormalError = Infinity;
  for (const thetaSign of [-1, 1]) for (const phiSign of [-1, 1]) {
    const theta = 3 * Math.PI / 2 + thetaSign * Math.PI / major, phi = phiSign * Math.PI / minor;
    const n = [Math.cos(phi) * Math.cos(theta), Math.sin(phi) * Math.cos(Math.PI / major), Math.cos(phi) * Math.sin(theta)];
    const size = Math.hypot(...n);
    bestNormalError = Math.min(bestNormalError, Math.hypot(...n.map((v, i) => v / size - hit.normal[i])));
  }
  assert.ok(bestNormalError < 1e-8, `axis point ray must return an adjacent outward plane normal: ${bestNormalError}`);
  near(Math.hypot(...hit.normal), 1);
  const touching = sweepSolid(solid, [0, 0, -67], [0, 0, -50], 7, undefined, w.result, w);
  assert.equal(touching.status, 'hit', touching.reason);near(touching.fraction, 0);near(touching.normal[2], -1, 1e-8);
  for (const radius of [0, 7]) {
    assert.equal(sweepSolid(solid, [0, 0, -20], [0, 0, 20], radius, undefined, w.result, w).status, 'clear', 'the hole remains traversable');
    assert.equal(sweepSolid(solid, [60 + radius, 0, -100], [60 + radius, 0, 100], radius, undefined, w.result, w).status, 'clear', 'a convex vertex tangent has no entering interval');
  }
  // An exact outer polygon edge, offset by r7 along its horizontal normal.
  // Moving parallel to that edge touches its rounded boundary without entry.
  const half = Math.PI / major, n = [Math.cos(half), 0, Math.sin(half)], tangent = [-n[2], 0, n[0]], apothem = 60 * Math.cos(half) + 7;
  const edgeStart = n.map((v, i) => v * apothem - 100 * tangent[i]), edgeEnd = n.map((v, i) => v * apothem + 100 * tangent[i]);
  assert.equal(sweepSolid(solid, edgeStart, edgeEnd, 7, undefined, w.result, w).status, 'clear', 'finite edge tangent has no entering interval');
  // Exact rational triangle/ray reference measurements also cover x=0 and
  // the actual outer vertex x +/-1e-14. Rounding a reconstructed closest
  // point must not turn an entering shared-edge hit into a tangent normal.
  const vertexX = vertices[index(major * 3 / 4, 0)][0];
  for (const x of [0, vertexX - 1e-14, vertexX, vertexX + 1e-14, -1e-12, 1e-12]) for (const y of [-1e-12, 0, 1e-12]) for (const direction of [-1, 1]) {
    const first = sweepSolid(solid, [x, y, -100 * direction], [x, y, 100 * direction], 0, undefined, w.result, w);
    assert.equal(first.status, 'hit', first.reason);near(first.fraction, .2, 1e-12);
    near(Math.hypot(...first.normal), 1);assert.ok(first.normal[2] * direction < -.99, 'contact normal must oppose entry, including both shared-edge sides');
  }
  // These separations are many orders above the computed reconstruction
  // uncertainty; they must remain genuine misses, not conservative contacts.
  for (const radius of [0, 7]) for (const direction of [-1, 1]) {
    const miss = sweepSolid(solid, [60 + radius + 1e-8, 0, -100 * direction], [60 + radius + 1e-8, 0, 100 * direction], radius, undefined, w.result, w);
    assert.equal(miss.status, 'clear', miss.reason);
  }
  for (let i = 0; i < 3; i++) {
    hit = axisSweep(7);assert.equal(hit.status, 'hit', hit.reason);near(hit.fraction, .165, 1e-10);
    assert.equal(sample(mesh, [0, 0, 0], distanceWork, out), out);assert.equal(w.result, hit);
  }
  assert.equal(distanceWork.stack, stack);assert.equal(distanceWork.closest, closest);assert.equal(w.terrain.stack, terrainStack);assert.equal(w.candidates, candidates);assert.equal(w.pointMeshes, pointMeshes);assert.equal(w.pointFaces, pointFaces);
  const pointLimited = sweepSolid(solid, start, end, 0, {maxIterations: 1}, w.result, w);
  assert.equal(pointLimited.status, 'failed');assert.equal(pointLimited.reason, 'solid-root-budget');assert.equal(pointLimited.safeFraction, 0);
  const untouched = {distance: 123, normal: [7, 8, 9]}, tinyDistance = createMeshTerrainWorkspace({maxDistanceNodes: 1});
  assert.equal(meshTerrainDistance(mesh, 0, 0, 0, untouched, tinyDistance), false);assert.equal(tinyDistance.reason, 'mesh-distance-node-budget');assert.deepEqual(untouched, {distance: 123, normal: [7, 8, 9]});
  for (const [options, reason] of [[{maxSweepNodes: 1}, 'mesh-sweep-node-budget'], [{maxRootTests: 1}, 'mesh-root-test-budget'], [{maxRoots: 1}, 'mesh-root-budget']]) {
    const tiny = createMeshTerrainWorkspace(options);
    assert.equal(visitMeshTerrainSweepRoots(mesh, start, [0, 0, 200], 7, tiny, () => true), false);assert.equal(tiny.reason, reason);
  }
  const limited = sweepSolid(solid, start, end, 7, {maxIterations: 1}, w.result, w);
  assert.equal(limited.status, 'failed');assert.equal(limited.reason, 'solid-root-budget');assert.equal(limited.safeFraction, 0);
  t.diagnostic(JSON.stringify({vertices: vertices.length, faces: faces.length, nodes: mesh.nodes.length, pointRayEntry, pointRayNormalError: bestNormalError, sphereEntry, warmCandidateBytes: candidates.byteLength}));
  // CPU geometry and scratch have no external resource/dispose contract.
});

test('point face provenance leaves resolvable translated rounded-edge sphere contacts independent of face order', () => {
  for (const [B, radius] of [[1e9, 2.5e-5], [1e6, 2.5e-8]]) for (let rotation = 0; rotation < 12; rotation++) {
    const input = boxInput();input.vertices = input.vertices.map(v => [v[0] + B, v[1] + B, v[2]]);
    input.radius = Math.hypot(B + 1, B + 1, 1);input.faces = input.faces.slice(rotation).concat(input.faces.slice(0, rotation));
    const mesh = buildTerrainMesh(input), solid = asSolid(mesh), w = createSolidWorkspace();
    const x = B + 1 + radius * .1, separation = x - (B + 1), zSeparation = Math.sqrt(radius * radius - separation * separation);
    const expected = (1 - zSeparation) / 2;
    const hit = sweepSolid(solid, [x, B, 2], [x, B, 0], radius, undefined, w.result, w);
    assert.equal(hit.status, 'hit', `${B}/${rotation}: ${hit.reason}`);near(hit.fraction, expected, 1e-15);
    near(hit.normal[0], separation / radius, 1e-7);near(hit.normal[1], 0);near(hit.normal[2], zSeparation / radius, 1e-7);
    assert.equal(w.pointMeshes, null);assert.equal(w.pointFaces, null, 'positive-radius calls do not allocate point provenance');
    // The infinite z=1 plane is crossed, but its finite face is missed.
    // No face provenance may be published for that crossing.
    const point = [B + 1 + radius, B, 2], delta = [0, 0, -2], roots = [], mw = createMeshTerrainWorkspace();
    assert.equal(visitMeshTerrainSweepRoots(mesh, point, delta, 0, mw, (t, _, face) => { if (face !== undefined) roots.push(face);return true; }), true);
    assert.equal(roots.length, 0);
    const miss = sweepSolid(solid, point, [point[0], B, 0], 0, undefined, w.result, w);assert.equal(miss.status, 'clear');
  }
});


test('point root face ownership survives candidate sorting across reordered terrain groups and world frames', () => {
  const left = boxInput(), right = boxInput();left.center = [-10, 0, 0];right.center = [10, 0, 0];
  left.faces = left.faces.slice(10).concat(left.faces.slice(0, 10));
  const solid = {position: [1e8, -2e8, 3e8], frame: [0, 0, -1, 0, 1, 0, 1, 0, 0], boundsRadius: 12,
    shape: {type: 'compound', parts: [], terrainGroups: [buildTerrainMesh(right), buildTerrainMesh(left)]}};
  const world = p => [solid.position[0] - p[2], solid.position[1] + p[1], solid.position[2] + p[0]], w = createSolidWorkspace();
  const hit = sweepSolid(solid, world([-20, 0, 0]), world([20, 0, 0]), 0, undefined, w.result, w);
  assert.equal(hit.status, 'hit', hit.reason);near(hit.fraction, 9 / 40, 1e-10);near(hit.normal[0], 0);near(hit.normal[1], 0);near(hit.normal[2], -1);
  assert.equal(hit.part, 1);
});
