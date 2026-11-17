/** Static, closed triangle solids. All vertices and BVH bounds are relative
 * to mesh.center, which is in the owning body's local frame. Construction
 * validates topology once; synchronous queries use caller-owned scratch.
 */
const EMPTY = Object.freeze({});
// CPU closed-mesh limits; GPU transports own their independent capacities.
export const TERRAIN_MESH_VERTEX_CAPACITY=8192,TERRAIN_MESH_FACE_CAPACITY=16384,TERRAIN_MESH_NODE_CAPACITY=8192;
const MAX_VERTICES=TERRAIN_MESH_VERTEX_CAPACITY,MAX_TRIANGLES=TERRAIN_MESH_FACE_CAPACITY,MAX_NODES=TERRAIN_MESH_NODE_CAPACITY,LEAF_SIZE=4;
const positive = n => Number.isInteger(n) && n > 0;
const vector = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

function before(a, b, centroids, axis) {
  const delta = centroids[a * 3 + axis] - centroids[b * 3 + axis];return delta < 0 || delta === 0 && a < b;
}
function median(order, centroids, low, high, target, axis) {
  while (low < high) {
    const pivot = order[(low + high) >> 1];let left = low, right = high;
    while (left <= right) {
      while (before(order[left], pivot, centroids, axis)) left++;
      while (before(pivot, order[right], centroids, axis)) right--;
      if (left <= right) { const value = order[left];order[left++] = order[right];order[right--] = value; }
    }
    if (target <= right) high = right;else if (target >= left) low = left;else return;
  }
}

/** Build one median-balanced, four-triangle-leaf BVH. Original geometry arrays
 * are retained, not reordered. Plain static arrays support the generator's
 * existing deep freeze and the GPU's shared node/order representation.
 */
export function buildTerrainMesh(mesh) {
  const { center, radius, vertices, faces, normals } = mesh;
  if (!vector(center) || !Number.isFinite(radius) || radius <= 0 || !Array.isArray(vertices) || vertices.length < 4 || vertices.length > MAX_VERTICES ||
    !Array.isArray(faces) || faces.length < 4 || faces.length > MAX_TRIANGLES || !Array.isArray(normals) || normals.length !== vertices.length)
    throw new RangeError('Invalid closed terrain mesh representation');
  let farthest = 0;
  for (let i = 0; i < vertices.length; i++) {
    if (!vector(vertices[i]) || !vector(normals[i])) throw new RangeError('Non-finite terrain vertex or normal');
    farthest = Math.max(farthest, Math.hypot(...vertices[i]));
  }
  if (farthest > radius + 32 * Number.EPSILON * Math.max(1, radius)) throw new RangeError('Terrain radius does not contain its vertices');
  const order = Array.from({ length: faces.length }, (_, i) => i), centroids = new Float64Array(faces.length * 3);
  const masks = new Array(faces.length).fill(0), vertexOwners = new Int32Array(vertices.length).fill(-1), edges = new Map();
  let volume = 0;
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (!Array.isArray(face) || face.length !== 3 || !face.every(index => Number.isInteger(index) && index >= 0 && index < vertices.length) ||
      face[0] === face[1] || face[1] === face[2] || face[2] === face[0]) throw new RangeError('Invalid terrain triangle indices');
    const a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]];
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2], bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
    if (!(Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) > 0)) throw new RangeError('Degenerate terrain triangle');
    volume += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    for (let axis = 0; axis < 3; axis++) centroids[i * 3 + axis] = (a[axis] + b[axis] + c[axis]) / 3;
    for (let corner = 0; corner < 3; corner++) {
      const ia = face[corner], ib = face[(corner + 1) % 3];
      if (vertexOwners[ia] < 0) { vertexOwners[ia] = i;masks[i] |= 1 << (corner + 3); }
      const key = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`, previous = edges.get(key);
      if (!previous) { edges.set(key, { from: ia, to: ib, count: 1 });masks[i] |= 1 << corner; }
      else {
        if (previous.count !== 1 || previous.from !== ib || previous.to !== ia) throw new RangeError('Terrain mesh is not an oriented closed manifold');
        previous.count++;
      }
    }
  }
  for (const edge of edges.values()) if (edge.count !== 2) throw new RangeError('Terrain mesh has an open boundary');
  for (const owner of vertexOwners) if (owner < 0) throw new RangeError('Terrain mesh has an unused vertex');
  if (!(volume > 0)) throw new RangeError('Terrain mesh has inward winding or zero volume');
  const nodes = [];
  function build(start, end) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const face = faces[order[i]];
      for (let axis = 0; axis < 3; axis++) {
        const midpoint = centroids[order[i] * 3 + axis];low[axis] = Math.min(low[axis], midpoint);high[axis] = Math.max(high[axis], midpoint);
        for (let corner = 0; corner < 3; corner++) { const value = vertices[face[corner]][axis];min[axis] = Math.min(min[axis], value);max[axis] = Math.max(max[axis], value); }
      }
    }
    const index = nodes.length, node = { min, max, left: -1, right: -1, start, count: end - start };nodes.push(node);
    if (nodes.length > MAX_NODES) throw new RangeError(`Terrain BVH exceeds ${MAX_NODES} nodes`);
    if (end - start > LEAF_SIZE) {
      let axis = 0;if (high[1] - low[1] > high[axis] - low[axis]) axis = 1;if (high[2] - low[2] > high[axis] - low[axis]) axis = 2;
      const middle = (start + end) >> 1;median(order, centroids, start, end - 1, middle, axis);
      node.count = 0;node.start = 0;node.left = build(start, middle);node.right = build(middle, end);
    }
    return index;
  }
  build(0, faces.length);
  return { ...mesh, nodes, triangleOrder: order, featureMasks: masks };
}

export function createMeshTerrainWorkspace({ maxDistanceNodes = TERRAIN_MESH_NODE_CAPACITY*2, maxSweepNodes = TERRAIN_MESH_NODE_CAPACITY, maxRoots = 32768, maxRootTests = TERRAIN_MESH_FACE_CAPACITY*5/2+TERRAIN_MESH_VERTEX_CAPACITY } = EMPTY) {
  if (!positive(maxDistanceNodes) || !positive(maxSweepNodes) || !positive(maxRoots) || !positive(maxRootTests)) throw new RangeError('Mesh query budgets must be positive integers');
  return { maxDistanceNodes, maxSweepNodes, maxRoots, maxRootTests, stack: new Int32Array(32), nodeVisits: 0, tests: 0, rootCount: 0,
    status: 'complete', reason: undefined, maxFraction:1, closest: { squared: Infinity, point: [0, 0, 0], normal: [0, 0, 0], face: -1, feature: '', edgeA: -1, edgeB: -1, vertex: -1 } };
}

function fail(w, reason) { w.status = 'failed';w.reason = reason;return false; }
function boxDistance(node, x, y, z) {
  const dx = Math.max(node.min[0] - x, 0, x - node.max[0]), dy = Math.max(node.min[1] - y, 0, y - node.max[1]), dz = Math.max(node.min[2] - z, 0, z - node.max[2]);
  return dx * dx + dy * dy + dz * dz;
}
function closestTriangle(mesh, index, x, y, z, best) {
  const face = mesh.faces[index], a = mesh.vertices[face[0]], b = mesh.vertices[face[1]], c = mesh.vertices[face[2]];
  const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2], bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, normalSquared = nx * nx + ny * ny + nz * nz;
  const height = ((x - a[0]) * nx + (y - a[1]) * ny + (z - a[2]) * nz) / normalSquared;
  const px = x - nx * height, py = y - ny * height, pz = z - nz * height;
  // Cross-product barycentrics avoid subtracting two O(edge^4) Gram terms
  // when a finite triangle is long and thin.
  const qx = px - a[0], qy = py - a[1], qz = pz - a[2];
  const u = ((qy * bz - qz * by) * nx + (qz * bx - qx * bz) * ny + (qx * by - qy * bx) * nz) / normalSquared;
  const v = ((ay * qz - az * qy) * nx + (az * qx - ax * qz) * ny + (ax * qy - ay * qx) * nz) / normalSquared;
  const previous = best.squared;
  if (u >= 0 && v >= 0 && u + v <= 1) {
    const squared = (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2;
    if (squared < best.squared) {
      best.squared = squared;best.point[0] = px;best.point[1] = py;best.point[2] = pz;
      best.feature = 'mesh-face';best.edgeA = -1;best.edgeB = -1;best.vertex = -1;
    }
  }
  for (let edge = 0; edge < 3; edge++) {
    const ia = face[edge], ib = face[(edge + 1) % 3], start = mesh.vertices[ia], end = mesh.vertices[ib];
    const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
    const t = Math.max(0, Math.min(1, ((x - start[0]) * dx + (y - start[1]) * dy + (z - start[2]) * dz) / (dx * dx + dy * dy + dz * dz)));
    const qx = start[0] + dx * t, qy = start[1] + dy * t, qz = start[2] + dz * t, squared = (x - qx) ** 2 + (y - qy) ** 2 + (z - qz) ** 2;
    if (squared < best.squared) {
      best.squared = squared;best.point[0] = qx;best.point[1] = qy;best.point[2] = qz;
      if (t <= 0 || t >= 1) { best.feature = 'mesh-vertex';best.vertex = t <= 0 ? ia : ib;best.edgeA = -1;best.edgeB = -1; }
      else { best.feature = 'mesh-edge';best.edgeA = Math.min(ia, ib);best.edgeB = Math.max(ia, ib);best.vertex = -1; }
    }
  }
  if (best.squared < previous) {
    const size = Math.sqrt(normalSquared);best.normal[0] = nx / size;best.normal[1] = ny / size;best.normal[2] = nz / size;best.face = index;
  }
}

// Half-open projected edges give each shared triangle edge exactly one owner.
// Endpoint coordinates are translated before the cross products, so reversing
// a shared edge negates the same two products, including an exact zero.
function projectedEdge(value, ay, az, by, bz, sign) {
  value *= sign;
  if (value !== 0) return value > 0;
  const dz = (bz - az) * sign, dy = (by - ay) * sign;
  return dz > 0 || dz === 0 && dy < 0;
}
function parityCrossing(mesh, faceIndex, x, y, z) {
  const face = mesh.faces[faceIndex], a = mesh.vertices[face[0]], b = mesh.vertices[face[1]], c = mesh.vertices[face[2]];
  const ay = a[1] - y, az = a[2] - z, by = b[1] - y, bz = b[2] - z, cy = c[1] - y, cz = c[2] - z;
  const ab = ay * bz - az * by, bc = by * cz - bz * cy, ca = cy * az - cz * ay, determinant = ab + bc + ca;
  if (determinant === 0) return false;
  const sign = determinant > 0 ? 1 : -1;
  if (!projectedEdge(ab, ay, az, by, bz, sign) || !projectedEdge(bc, by, bz, cy, cz, sign) || !projectedEdge(ca, cy, cz, ay, az, sign)) return false;
  return ((a[0] - x) * bc + (b[0] - x) * ca + (c[0] - x) * ab) / determinant > 0;
}
function parityNode(node, x, y, z) {
  return node.max[0] > x && y >= node.min[1] && y <= node.max[1] && z >= node.min[2] && z <= node.max[2];
}

/** Exact finite-triangle nearest distance, signed by a deterministic +X ray
 * with half-open shared-edge counting. Shading normals do not change physical
 * distances or contact normals. Returns false, without publishing a partial
 * output, if a caller's explicit node budget is exhausted.
 */
export function meshTerrainDistance(mesh, x, y, z, out, w) {
  w.status = 'complete';w.reason = undefined;w.nodeVisits = 0;
  x -= mesh.center[0];y -= mesh.center[1];z -= mesh.center[2];
  const closest = w.closest, stack = w.stack;closest.squared = Infinity;closest.face = -1;
  let top = 0;stack[top++] = 0;
  while (top) {
    if (++w.nodeVisits > w.maxDistanceNodes) return fail(w, 'mesh-distance-node-budget');
    const node = mesh.nodes[stack[--top]];
    if (boxDistance(node, x, y, z) >= closest.squared) continue;
    if (node.count > 0) for (let i = node.start; i < node.start + node.count; i++) closestTriangle(mesh, mesh.triangleOrder[i], x, y, z, closest);
    else {
      const left = boxDistance(mesh.nodes[node.left], x, y, z), right = boxDistance(mesh.nodes[node.right], x, y, z);
      if (left <= right) { if (right < closest.squared) stack[top++] = node.right;if (left < closest.squared) stack[top++] = node.left; }
      else { if (left < closest.squared) stack[top++] = node.left;if (right < closest.squared) stack[top++] = node.right; }
    }
  }
  const size = Math.sqrt(closest.squared), root = mesh.nodes[0];let parity = 0;
  if (size > 0 && x >= root.min[0] && x <= root.max[0] && y >= root.min[1] && y <= root.max[1] && z >= root.min[2] && z <= root.max[2]) {
    top = 0;stack[top++] = 0;
    while (top) {
      if (++w.nodeVisits > w.maxDistanceNodes) return fail(w, 'mesh-distance-node-budget');
      const node = mesh.nodes[stack[--top]];
      if (!parityNode(node, x, y, z)) continue;
      if (node.count > 0) {
        for (let i = node.start; i < node.start + node.count; i++) if (parityCrossing(mesh, mesh.triangleOrder[i], x, y, z)) parity ^= 1;
      } else { stack[top++] = node.right;stack[top++] = node.left; }
    }
  }
  out.distance = parity ? -size : size;out.face = closest.face;out.feature = closest.feature;
  out.edgeA = closest.edgeA;out.edgeB = closest.edgeB;out.vertex = closest.vertex;
  // A finite face interior has its actual outward plane normal at every
  // distance. At contact, p-projection can cancel to a single noisy coordinate;
  // normalizing that residual can reverse entering motion. Edges/vertices
  // retain their rounded closest-point direction when it is nonzero.
  if (closest.feature === 'mesh-face' || size === 0) { out.normal[0] = closest.normal[0];out.normal[1] = closest.normal[1];out.normal[2] = closest.normal[2]; }
  else {
    const sign = parity ? -1 : 1;
    out.normal[0] = (x - closest.point[0]) / size * sign;out.normal[1] = (y - closest.point[1]) / size * sign;out.normal[2] = (z - closest.point[2]) / size * sign;
  }
  return out;
}

function segmentEntry(node, x, y, z, dx, dy, dz, radius, maximum=1) {
  let low = 0, high = maximum;
  for (let axis = 0; axis < 3; axis++) {
    const p = axis === 0 ? x : axis === 1 ? y : z, d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const min = node.min[axis] - radius, max = node.max[axis] + radius;
    if (d === 0) { if (p < min || p > max) return Infinity; }
    else { const a = (min - p) / d, b = (max - p) / d;low = Math.max(low, Math.min(a, b));high = Math.min(high, Math.max(a, b));if (low > high) return Infinity; }
  }
  return low;
}
function rootTest(w) { return ++w.tests <= w.maxRootTests || fail(w, 'mesh-root-test-budget'); }
function emit(t, w, visitor, context, faceIndex = -1) {
  if (t < 0 || t > w.maxFraction) return true;
  if (++w.rootCount > w.maxRoots) return fail(w, 'mesh-root-budget');
  if (t === 0) t = 0;
  return (faceIndex < 0 ? visitor(t, context) : visitor(t, context, faceIndex)) !== false || fail(w, 'mesh-root-visitor');
}
// Point rays use a dominant-axis shear: shared vertices undergo identical
// operations and a reversed shared edge negates the same two products. Test
// all three finite projected edges before interpolating the root; rebuilding
// a world-space plane hit and then testing barycentrics loses this property.
function pointTriangleRoot(mesh,index,x,y,z,dx,dy,dz,w,visitor,context){
  const face=mesh.faces[index],a=mesh.vertices[face[0]],b=mesh.vertices[face[1]],c=mesh.vertices[face[2]];
  let kz=0;if(Math.abs(dy)>Math.abs(dx))kz=1;if(Math.abs(dz)>(kz===0?Math.abs(dx):Math.abs(dy)))kz=2;
  const kx=(kz+1)%3,ky=(kx+1)%3,dominant=kz===0?dx:kz===1?dy:dz;
  const sx=(kx===0?dx:kx===1?dy:dz)/dominant,sy=(ky===0?dx:ky===1?dy:dz)/dominant;
  const originZ=kz===0?x:kz===1?y:z,originX=kx===0?x:kx===1?y:z,originY=ky===0?x:ky===1?y:z;
  const az=a[kz]-originZ,bz=b[kz]-originZ,cz=c[kz]-originZ;
  const ax=a[kx]-originX-sx*az,ay=a[ky]-originY-sy*az,bx=b[kx]-originX-sx*bz,by=b[ky]-originY-sy*bz,cx=c[kx]-originX-sx*cz,cy=c[ky]-originY-sy*cz;
  const u=cx*by-cy*bx,v=ax*cy-ay*cx,q=bx*ay-by*ax;
  if((u<0||v<0||q<0)&&(u>0||v>0||q>0))return true;
  const determinant=u+v+q;if(determinant===0)return true;
  return emit((u*az+v*bz+q*cz)/(determinant*dominant),w,visitor,context,index);
}
function triangleRoots(mesh, index, x, y, z, dx, dy, dz, radius, w, visitor, context) {
  if (!rootTest(w)) return false;
  const face = mesh.faces[index], a = mesh.vertices[face[0]], b = mesh.vertices[face[1]], c = mesh.vertices[face[2]], mask = mesh.featureMasks[index];
  const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2], bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const length = Math.hypot(nx, ny, nz);nx /= length;ny /= length;nz /= length;
  const slope = nx * dx + ny * dy + nz * dz;
  if (radius === 0) {
    if (!pointTriangleRoot(mesh,index,x,y,z,dx,dy,dz,w,visitor,context)) return false;
  } else if (slope !== 0) {
    const signed = nx * (x - a[0]) + ny * (y - a[1]) + nz * (z - a[2]);
    for (let side = 0; side < 2; side++) {
      const offset = side ? -radius : radius, t = (offset - signed) / slope;
      if (t < 0 || t > 1) continue;
      const px = x + dx * t - nx * offset - a[0], py = y + dy * t - ny * offset - a[1], pz = z + dz * t - nz * offset - a[2];
      const u = ((py * bz - pz * by) * nx + (pz * bx - px * bz) * ny + (px * by - py * bx) * nz) / length;
      const v = ((ay * pz - az * py) * nx + (az * px - ax * pz) * ny + (ax * py - ay * px) * nz) / length;
      if (u >= 0 && v >= 0 && u + v <= 1 && !emit(t, w, visitor, context)) return false;
    }
  }
  for (let edge = 0; edge < 3; edge++) if (mask & 1 << edge) {
    if (!rootTest(w)) return false;
    const start = mesh.vertices[face[edge]], end = mesh.vertices[face[(edge + 1) % 3]];
    const vx = end[0] - start[0], vy = end[1] - start[1], vz = end[2] - start[2], axisSquared = vx * vx + vy * vy + vz * vz;
    const qx = x - start[0], qy = y - start[1], qz = z - start[2];
    const cx = dy * vz - dz * vy, cy = dz * vx - dx * vz, cz = dx * vy - dy * vx, perpendicular = cx * cx + cy * cy + cz * cz;
    if (perpendicular === 0) continue;
    const across = qx * cx + qy * cy + qz * cz, discriminant = perpendicular * radius * radius - across * across;
    if (discriminant < 0) continue;
    const along = (qy * vz - qz * vy) * cx + (qz * vx - qx * vz) * cy + (qx * vy - qy * vx) * cz, root = Math.sqrt(axisSquared * discriminant);
    for (let side = 0; side < 2; side++) {
      const t = (-along + (side ? root : -root)) / perpendicular;
      if (t < 0 || t > 1) continue;
      const projection = ((qx + dx * t) * vx + (qy + dy * t) * vy + (qz + dz * t) * vz) / axisSquared;
      if (projection >= 0 && projection <= 1 && !emit(t, w, visitor, context)) return false;
    }
  }
  const motionSquared = dx * dx + dy * dy + dz * dz;
  for (let corner = 0; corner < 3; corner++) if (mask & 1 << (corner + 3)) {
    if (!rootTest(w)) return false;
    const vertex = mesh.vertices[face[corner]], qx = x - vertex[0], qy = y - vertex[1], qz = z - vertex[2];
    const cx = qy * dz - qz * dy, cy = qz * dx - qx * dz, cz = qx * dy - qy * dx, discriminant = motionSquared * radius * radius - (cx * cx + cy * cy + cz * cz);
    if (discriminant < 0) continue;
    const along = qx * dx + qy * dy + qz * dz, root = Math.sqrt(discriminant);
    if (!emit((-along - root) / motionSquared, w, visitor, context) || !emit((-along + root) / motionSquared, w, visitor, context)) return false;
  }
  return true;
}

/** Visit only BVH leaves meeting the radius-expanded swept segment. Face
 * planes, finite edge cylinders and vertex spheres supply analytic roots.
 * Radius-zero finite face roots additionally pass their face index to the
 * visitor; positive-radius and edge/vertex callbacks keep their old signature.
 * Static feature ownership avoids duplicate edge/vertex roots without a
 * per-query Set or a global vertex scan; an owner triangle's box contains its
 * owned feature. The union solver owns final sign/entering/skin decisions.
 */
export function visitMeshTerrainSweepRoots(mesh, p, delta, radius, w, visitor, context) {
  w.status = 'complete';w.reason = undefined;w.nodeVisits = 0;w.tests = 0;w.rootCount = 0;
  const x = p[0] - mesh.center[0], y = p[1] - mesh.center[1], z = p[2] - mesh.center[2], dx = delta[0], dy = delta[1], dz = delta[2];
  if (dx === 0 && dy === 0 && dz === 0) return true;
  const stack = w.stack;let top = 0;stack[top++] = 0;
  while (top) {
    if (++w.nodeVisits > w.maxSweepNodes) return fail(w, 'mesh-sweep-node-budget');
    const node = mesh.nodes[stack[--top]];
    if (segmentEntry(node, x, y, z, dx, dy, dz, radius,w.maxFraction) === Infinity) continue;
    if (node.count > 0) {
      for (let i = node.start; i < node.start + node.count; i++)
        if (!triangleRoots(mesh, mesh.triangleOrder[i], x, y, z, dx, dy, dz, radius, w, visitor, context)) return false;
    } else {
      const left = segmentEntry(mesh.nodes[node.left], x, y, z, dx, dy, dz, radius,w.maxFraction), right = segmentEntry(mesh.nodes[node.right], x, y, z, dx, dy, dz, radius,w.maxFraction);
      if (left <= right) { if (right !== Infinity) stack[top++] = node.right;if (left !== Infinity) stack[top++] = node.left; }
      else { if (left !== Infinity) stack[top++] = node.left;if (right !== Infinity) stack[top++] = node.right; }
    }
  }
  return true;
}
