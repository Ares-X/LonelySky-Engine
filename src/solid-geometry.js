/** Distances and finite-feature continuous sweeps for static solid descriptors.
 * frame is an orthonormal world-to-local Matrix3 in Three.js column order.
 * Compound parts are annular slabs and optional terrainGroups of closed triangle
 * landscapes. Rendering and CCD consume the same local vertices/planes.
 */
import {createMeshTerrainWorkspace,meshTerrainDistance,visitMeshTerrainSweepRoots} from './mesh-terrain.js';
export class SolidQueryFailure extends RangeError {
  constructor(code,message){super(message);this.name='SolidQueryFailure';this.code=code;}
}
const capFeatures = {
  inner: ['inner-bottom', 'inner-top'], outer: ['outer-bottom', 'outer-top'],
  'gap-minus': ['gap-minus-bottom', 'gap-minus-top'], 'gap-plus': ['gap-plus-bottom', 'gap-plus-top'],
};
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const makeDistance = () => ({ distance: 0, normal: [0, 0, 0], feature: '', part: -1 });
function localPoint(solid, point, out) {
  const x = point[0] - solid.position[0], y = point[1] - solid.position[1], z = point[2] - solid.position[2], f = solid.frame;
  if (!f) { out[0] = x; out[1] = y; out[2] = z; return; }
  out[0] = f[0] * x + f[3] * y + f[6] * z;
  out[1] = f[1] * x + f[4] * y + f[7] * z;
  out[2] = f[2] * x + f[5] * y + f[8] * z;
}
function worldNormal(solid, out) {
  const f = solid.frame;
  if (!f) return;
  const n = out.normal, x = n[0], y = n[1], z = n[2];
  n[0] = f[0] * x + f[1] * y + f[2] * z;
  n[1] = f[3] * x + f[4] * y + f[5] * z;
  n[2] = f[6] * x + f[7] * y + f[8] * z;
}
// Nearest point on a radial segment. These segments are also the two gap faces
// in the horizontal section. Endpoints, rather than angular inflation, retain
// the round Minkowski edges when the ship has finite radius.
function segmentNearest(x, z, angle, inner, outer, out) {
  const c = Math.cos(angle), s = Math.sin(angle), r = Math.max(inner, Math.min(outer, x * c + z * s));
  out[0] = c * r; out[1] = s * r;
}
function slabDistance(part, x, y, z, out, scratch) {
  const r = Math.hypot(x, z), angle = Math.atan2(z, x), gap = part.gapHalfAngle;
  const inGap = gap > 0 && Math.abs(angleDelta(angle, part.gapCenter)) < gap;
  const insideXZ = !inGap && r >= part.innerRadius && r <= part.outerRadius;
  let qx, qz, horizontal, feature;
  if (inGap) {
    segmentNearest(x, z, part.gapCenter - gap, part.innerRadius, part.outerRadius, scratch);
    qx = scratch[0]; qz = scratch[1]; feature = 'gap-minus';
    let squared = (x - qx) ** 2 + (z - qz) ** 2;
    segmentNearest(x, z, part.gapCenter + gap, part.innerRadius, part.outerRadius, scratch);
    const other = (x - scratch[0]) ** 2 + (z - scratch[1]) ** 2;
    if (other < squared) { qx = scratch[0]; qz = scratch[1]; feature = 'gap-plus'; squared = other; }
    horizontal = Math.sqrt(squared);
  } else {
    const rr = Math.max(part.innerRadius, Math.min(part.outerRadius, r));
    qx = r ? x * rr / r : rr; qz = r ? z * rr / r : 0;
    horizontal = Math.abs(r - rr); feature = r < part.innerRadius ? 'inner' : 'outer';
  }
  if (insideXZ) {
    let nearest = part.outerRadius - r;
    qx = r ? x * part.outerRadius / r : part.outerRadius; qz = r ? z * part.outerRadius / r : 0; feature = 'outer';
    if (part.innerRadius > 0 && r - part.innerRadius < nearest) {
      nearest = r - part.innerRadius; qx = r ? x * part.innerRadius / r : part.innerRadius;
      qz = r ? z * part.innerRadius / r : 0; feature = 'inner';
    }
    if (gap > 0) for (let side = -1; side <= 1; side += 2) {
      segmentNearest(x, z, part.gapCenter + side * gap, part.innerRadius, part.outerRadius, scratch);
      const d = Math.hypot(x - scratch[0], z - scratch[1]);
      if (d < nearest) { nearest = d; qx = scratch[0]; qz = scratch[1]; feature = side < 0 ? 'gap-minus' : 'gap-plus'; }
    }
    horizontal = -nearest;
  }
  // An angular face has a constant analytic plane normal while its closest
  // point projects inside the finite radial segment. Surface subtraction at
  // a point root can lose that direction even when its residual is nonzero.
  let gapFace=false,gapNX=0,gapNZ=0;
  if(feature==='gap-minus'||feature==='gap-plus'){
    const a=part.gapCenter+(feature==='gap-plus'?gap:-gap),c=Math.cos(a),s=Math.sin(a),along=x*c+z*s;
    if(along>=part.innerRadius&&along<=part.outerRadius){const sign=feature==='gap-plus'?-1:1;gapFace=true;gapNX=-s*sign;gapNZ=c*sign;}
  }
  const qy = Math.max(part.minY, Math.min(part.maxY, y));
  const vertical = y < part.minY ? part.minY - y : y > part.maxY ? y - part.maxY : -Math.min(y - part.minY, part.maxY - y);
  let nx, ny, nz;
  if (horizontal <= 0 && vertical <= 0) {
    if (vertical > horizontal) {
      out.distance = vertical; nx = 0; ny = y - part.minY < part.maxY - y ? -1 : 1; nz = 0; feature = ny < 0 ? 'bottom' : 'top';
    } else {
      out.distance = horizontal; ny = 0;
      if (feature === 'inner' || feature === 'outer') {
        // A cylinder has an analytic normal even when its signed distance is
        // within rounding error of zero. Subtracting two surface coordinates
        // first would normalize cancellation noise at a radius-zero sweep.
        const sign = feature === 'inner' ? -1 : 1; nx = sign * (r ? x / r : 1); nz = sign * (r ? z / r : 0);
      }else if(gapFace){nx=gapNX;nz=gapNZ;}else{
        nx=qx-x;nz=qz-z;
        if(nx===0&&nz===0){const a=part.gapCenter+(feature==='gap-plus'?gap:-gap),sign=feature==='gap-plus'?-1:1;nx=-Math.sin(a)*sign;nz=Math.cos(a)*sign;}
      }
    }
  } else {
    ny=vertical>0?y-qy:0;
    if(horizontal>0&&(feature==='inner'||feature==='outer')){
      const radialSign=feature==='inner'?-1:1;
      nx=radialSign*(r?x/r:1)*horizontal;nz=radialSign*(r?z/r:0)*horizontal;
    }else if(horizontal>0&&gapFace){nx=gapNX*horizontal;nz=gapNZ*horizontal;}
    else{nx=horizontal>0?x-qx:0;nz=horizontal>0?z-qz:0;}
    out.distance = Math.hypot(nx, ny, nz);
    if (vertical > 0) feature = horizontal > 0 ? capFeatures[feature][y < part.minY ? 0 : 1] : (y < part.minY ? 'bottom' : 'top');
  }
  const size = Math.hypot(nx, ny, nz);
  out.normal[0] = nx / size; out.normal[1] = ny / size; out.normal[2] = nz / size; out.feature = feature;
}
export function createSolidWorkspace() {
  return { point: [0, 0, 0], start: [0, 0, 0], end: [0, 0, 0], probe: [0, 0, 0], scratch: [0, 0],
    terrain:createMeshTerrainWorkspace(),
    // A contact proof runs while the root traversal stack is live. Its distance
    // traversal therefore owns separate scratch, rather than corrupting that stack.
    contactWorkspace:{point:[0,0,0],scratch:[0,0],partDistance:makeDistance(),terrain:createMeshTerrainWorkspace()},contactDistance:makeDistance(),contactPoint:[0,0,0],sweepStart:[0,0,0],sweepDelta:[0,0,0],sweepSolid:null,sweepRadius:0,sweepLower:0,sweepSpan:1,pruneTerrain:false,contactProofs:0,meshSweepNodes:0,meshSweepTests:0,meshSweepRoots:0,
    distance: makeDistance(), partDistance: makeDistance(), roots: Array.from({ length: 5 }, () => new Float64Array(16)), rootCounts: new Uint8Array(5),
    coefficients: Array.from({ length: 5 }, () => new Float64Array(5)), candidates: new Float64Array(1024), candidateCount: 0, evaluations: 0, maxIterations: 32768,
    pointMode: false, pointMeshes: null, pointFaces: null, terrainGroupIndex: -1, pointNormal: makeDistance(),
    result: { status: 'clear', fraction: 1, safeFraction: 1, normal: [0, 0, 0], feature: '', part: -1 } };
}
/** Signed distance to a sphere or minimum signed part distance for a compound.
 * Outside a compound this is its exact Euclidean distance. Negative values
 * identify overlap; inside overlapping parts the magnitude is per-part, not a
 * claimed exact distance to the exterior of their union.
 */
export function solidDistance(solid, point, out = makeDistance(), workspace = createSolidWorkspace()) {
  localPoint(solid, point, workspace.point);
  const p = workspace.point, shape = solid.shape;
  if (shape.type === 'sphere') {
    const r = Math.hypot(p[0], p[1], p[2]); out.distance = r - shape.radius;
    out.normal[0] = r ? p[0] / r : 0; out.normal[1] = r ? p[1] / r : 1; out.normal[2] = r ? p[2] / r : 0;
    out.feature = 'sphere'; out.part = -1;
  } else {
    out.distance = Infinity;
    for (let i = 0; i < shape.parts.length; i++) {
      const part=shape.parts[i],sections=part.sections,count=sections?sections.length:1;
      for(let section=0;section<count;section++){
        const d = workspace.partDistance;
        slabDistance(sections?sections[section]:part, p[0], p[1], p[2], d, workspace.scratch);
        if (d.distance < out.distance) {
          out.distance = d.distance; out.normal[0] = d.normal[0]; out.normal[1] = d.normal[1]; out.normal[2] = d.normal[2]; out.feature = d.feature; out.part = i;
        }
      }
    }
    if(shape.terrainGroups)for(let i=0;i<shape.terrainGroups.length;i++){
      const mesh=shape.terrainGroups[i],c=mesh.center;
      if(Math.hypot(p[0]-c[0],p[1]-c[1],p[2]-c[2])-mesh.radius>=out.distance)continue;
      const d=workspace.partDistance;
      if(meshTerrainDistance(mesh,p[0],p[1],p[2],d,workspace.terrain)===false)throw new RangeError(workspace.terrain.reason);
      if(d.distance<out.distance){
        out.distance=d.distance;out.normal[0]=d.normal[0];out.normal[1]=d.normal[1];out.normal[2]=d.normal[2];
        out.feature=d.feature;out.part=shape.parts.length+i;
      }
    }
  }
  worldNormal(solid, out); return out;
}
function siftCandidates(values, root, end, meshes, faces) {
  while (root * 2 + 1 < end) {
    let child = root * 2 + 1;
    if (child + 1 < end && values[child] < values[child + 1]) child++;
    if (values[root] >= values[child]) return;
    const value = values[root]; values[root] = values[child]; values[child] = value;
    if (meshes) {
      const mesh = meshes[root], face = faces[root];meshes[root] = meshes[child];faces[root] = faces[child];meshes[child] = mesh;faces[child] = face;
    }
    root = child;
  }
}
function sortCandidates(w) {
  const values = w.candidates, count = w.candidateCount, meshes = w.pointMode ? w.pointMeshes : null, faces = w.pointFaces;
  // In-place heap sort avoids a native Array.sort temporary backing buffer.
  for (let root = Math.floor(count / 2) - 1; root >= 0; root--) siftCandidates(values, root, count, meshes, faces);
  for (let end = count - 1; end > 0; end--) {
    const value = values[0]; values[0] = values[end]; values[end] = value;
    if (meshes) {
      const mesh = meshes[0], face = faces[0];meshes[0] = meshes[end];faces[0] = faces[end];meshes[end] = mesh;faces[end] = face;
    }
    siftCandidates(values, 0, end, meshes, faces);
  }
}

function polynomial(w, degree, t) {
  if (++w.evaluations > w.maxIterations) throw ROOT_LIMIT;
  const c = w.coefficients[degree]; let result = c[degree];
  for (let i = degree - 1; i >= 0; i--) result = result * t + c[i];
  return result;
}
const ROOT_LIMIT = Symbol('solid root budget');
const CONTACT_DISTANCE_TOLERANCE=1e-6;
// Isolate polynomial roots between derivative roots. Monotonic intervals have
// at most one crossing; even roots are derivative roots and represent tangency.
function polynomialRoots(w, degree) {
  const c = w.coefficients[degree], roots = w.roots[degree]; let count = 0;
  if (degree === 1) {
    if (c[1]) { const t = -c[0] / c[1]; if (t >= 0 && t <= 1) roots[count++] = t; }
    w.rootCounts[degree] = count; return;
  }
  const derivative = w.coefficients[degree - 1];
  for (let i = 1; i <= degree; i++) derivative[i - 1] = c[i] * i;
  polynomialRoots(w, degree - 1);
  const critical = w.roots[degree - 1], criticalCount = w.rootCounts[degree - 1];
  let lo = 0, flo = polynomial(w, degree, 0);
  if (flo === 0) roots[count++] = 0;
  for (let i = 0; i <= criticalCount; i++) {
    const hi = i === criticalCount ? 1 : critical[i], fhi = polynomial(w, degree, hi);
    if (flo * fhi < 0) {
      let a = lo, b = hi, fa = flo;
      for (let j = 0; j < 52 && b - a > 2e-15; j++) {
        const middle = (a + b) / 2, fm = polynomial(w, degree, middle);
        if ((fa < 0) === (fm < 0)) { a = middle; fa = fm; } else b = middle;
      }
      roots[count++] = (a + b) / 2;
    }
    if (fhi === 0) roots[count++] = hi;
    lo = hi; flo = fhi;
  }
  w.rootCounts[degree] = count;
}
function addPolynomial(w, c0, c1, c2, c3 = 0, c4 = 0) {
  const degree = c4 !== 0 ? 4 : c3 !== 0 ? 3 : c2 !== 0 ? 2 : 1, c = w.coefficients[degree];
  c[0] = c0; c[1] = c1; c[2] = c2; c[3] = c3; c[4] = c4;
  polynomialRoots(w, degree);
  const roots = w.roots[degree];
  for (let i = 0; i < w.rootCounts[degree]; i++) {
    const at = w.candidateCount++;w.candidates[at] = roots[i];
    if (w.pointMode) {w.pointMeshes[at] = -1;w.pointFaces[at] = -1;}
  }
}
function pointRoots(w, x, y, z, dx, dy, dz, radius) {
  addPolynomial(w, x * x + y * y + z * z - radius * radius, 2 * (x * dx + y * dy + z * dz), dx * dx + dy * dy + dz * dz);
}
function terrainBoundsIntersect(group, p, d, radius) {
  const center = group.center, x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2];
  const squared = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const t = squared ? Math.max(0, Math.min(1, -(x * d[0] + y * d[1] + z * d[2]) / squared)) : 0;
  // A long chord's closest-point subtraction can lose a few ulps. Expand
  // only this coarse rejection by its arithmetic scale, not the solid.
  const rounding = 32 * Number.EPSILON * Math.max(1, Math.hypot(x, y, z), Math.sqrt(squared));
  return Math.hypot(x + d[0] * t, y + d[1] * t, z + d[2] * t) <= group.radius + radius + rounding;
}
function circleRoots(w, x, y, z, dx, dy, dz, radius, shipRadius) {
  const a = dx * dx + dy * dy + dz * dz, b = 2 * (x * dx + y * dy + z * dz);
  const c = (x * x + z * z - radius * radius) + y * y - shipRadius * shipRadius;
  // Equivalent to the usual torus quartic, factored around rho²-R².
  // Avoid subtracting two O(R⁴) coefficients to resolve an eight-unit lip
  // beside a million-unit ring.
  addPolynomial(w, c * c + 4 * radius * radius * (y * y - shipRadius * shipRadius),
    2 * b * c + 8 * radius * radius * y * dy,
    b * b + 2 * a * c + 4 * radius * radius * dy * dy, 2 * a * b, a * a);
}
function slabRoots(w, part, p, d, radius) {
  const x = p[0], y = p[1], z = p[2], dx = d[0], dy = d[1], dz = d[2];
  // Exterior structural sectors can be hundreds of thousands of units away
  // from this sweep. Reject only by conservative geometric supports, before
  // computing boundary-feature roots. Rounded ship edges remain in the exact
  // slab solver below; neither culling test enlarges the actual solid.
  if (Math.min(y, y + dy) > part.maxY + radius || Math.max(y, y + dy) < part.minY - radius) return;
  if (part.gapHalfAngle > Math.PI * .5) {
    const angle = part.gapCenter + Math.PI, halfAngle = Math.PI - part.gapHalfAngle;
    const middleRadius = (part.innerRadius + part.outerRadius) * .5;
    const cx = Math.cos(angle) * middleRadius, cy = (part.minY + part.maxY) * .5, cz = Math.sin(angle) * middleRadius;
    const radialReach = (part.outerRadius - part.innerRadius) * .5 + part.outerRadius * (1 - Math.cos(halfAngle));
    const support = Math.hypot(radialReach, part.outerRadius * Math.sin(halfAngle), (part.maxY - part.minY) * .5) + radius;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((cx - x) * dx + (cy - y) * dy + (cz - z) * dz) / lengthSquared)) : 0;
    if (Math.hypot(x + dx * t - cx, y + dy * t - cy, z + dz * t - cz) > support) return;
  }
  // Faces, radial cylinders, and their circular cap edges.
  for (let side = 0; side < 2; side++) {
    const yy = side ? part.maxY : part.minY;
    addPolynomial(w, y - yy - radius, dy, 0); addPolynomial(w, y - yy + radius, dy, 0);
    for (let edge = 0; edge < 2; edge++) {
      const rr = edge ? part.outerRadius : part.innerRadius;
      if (!rr) continue;
      circleRoots(w, x, y - yy, z, dx, dy, dz, rr, radius);
    }
  }
  for (let edge = 0; edge < 2; edge++) {
    const rr = edge ? part.outerRadius : part.innerRadius;
    if (!rr) continue;
    pointRoots(w, x, 0, z, dx, 0, dz, rr + radius);
    if (rr >= radius) pointRoots(w, x, 0, z, dx, 0, dz, rr - radius);
  }
  if (part.gapHalfAngle <= 0) return;
  for (let side = -1; side <= 1; side += 2) {
    const angle = part.gapCenter + side * part.gapHalfAngle, c = Math.cos(angle), s = Math.sin(angle);
    const across = -x * s + z * c, da = -dx * s + dz * c;
    addPolynomial(w, across - radius, da, 0); addPolynomial(w, across + radius, da, 0);
    // Infinite lines containing the four edges of each rectangular cut face;
    // actual nearest-distance validation below restricts them to their segments.
    for (let edge = 0; edge < 2; edge++) {
      const rr = edge ? part.outerRadius : part.innerRadius;
      pointRoots(w, x - c * rr, 0, z - s * rr, dx, 0, dz, radius);
      const yy = edge ? part.maxY : part.minY;
      pointRoots(w, across, y - yy, 0, da, dy, 0, radius);
      for (let cap = 0; cap < 2; cap++) pointRoots(w, x - c * rr, y - (cap ? part.maxY : part.minY), z - s * rr, dx, dy, dz, radius);
    }
  }
}
function terrainRoot(t,w,faceIndex=-1){
  if(++w.evaluations>w.maxIterations)throw ROOT_LIMIT;
  const at=w.candidateCount++;w.candidates[at]=t;
  if(w.pruneTerrain&&t<w.terrain.maxFraction){
    const globalT=w.sweepLower+t*w.sweepSpan,p=w.contactPoint;
    for(let axis=0;axis<3;axis++)p[axis]=w.sweepStart[axis]+w.sweepDelta[axis]*globalT;
    const distance=solidDistance(w.sweepSolid,p,w.contactDistance,w.contactWorkspace).distance;
    const tolerance=Math.max(CONTACT_DISTANCE_TOLERANCE,64*Number.EPSILON*Math.max(1,w.sweepRadius,w.sweepSolid.boundsRadius??1));w.contactProofs++;
    // The verified original start is outside, this actual point is strictly
    // inside the authoritative solid+sphere union. Continuity proves contact
    // before this upper time. Never return this interior point as the TOI.
    // All earlier analytic roots, including grazing/other components, remain.
    if(distance<w.sweepRadius-tolerance)w.terrain.maxFraction=Math.min(1,t+2e-14);
  }
  if(w.pointMode){w.pointMeshes[at]=faceIndex<0?-1:w.terrainGroupIndex;w.pointFaces[at]=faceIndex;}

  return true;
}
// A point face root has already passed finite triangle membership. Its
// actual outward plane normal survives even if reconstructing p at that root
// cancels a sub-ULP closest-point component. Sphere sweeps retain their unique
// Minkowski edge/vertex normals from solidDistance without this path.
function pointFaceNormal(solid,mesh,index,out){
  const face=mesh.faces[index],a=mesh.vertices[face[0]],b=mesh.vertices[face[1]],c=mesh.vertices[face[2]],n=out.normal;
  const ax=b[0]-a[0],ay=b[1]-a[1],az=b[2]-a[2],bx=c[0]-a[0],by=c[1]-a[1],bz=c[2]-a[2];
  const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx,length=Math.hypot(nx,ny,nz);
  n[0]=nx/length;n[1]=ny/length;n[2]=nz/length;worldNormal(solid,out);
}
/** Exact boundary-feature roots, then Euclidean-distance/entering validation.
 * The quartics are ray/torus intersections at circular slab lips; quadratics
 * cover straight edges and vertices. No radius/gap enlargement replaces them.
 * A finite root-evaluation budget returns failed at the verified start.
 */
export function sweepSolid(solid, start, end, radius = 8, { maxIterations = 32768 } = {}, out, workspace) {
  if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Solid sweep radius must be finite and nonnegative');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new RangeError('Solid sweep budget must be a positive integer');
  const w = workspace ?? createSolidWorkspace(), result = out ?? w.result;
  result.status = 'clear'; result.fraction = 1; result.safeFraction = 1; result.feature = ''; result.part = -1; result.reason = undefined;
  w.contactProofs=0;w.meshSweepNodes=0;w.meshSweepTests=0;w.meshSweepRoots=0;w.terrain.maxFraction=1;w.pruneTerrain=false;w.evaluations = 0; w.maxIterations = maxIterations; w.candidateCount = 1; w.candidates[0] = 0;
  // Every emitted terrain candidate consumes the global evaluation budget.
  // Its bound avoids rescanning all mesh faces or reserving an entire world's
  // roots in the hot path. Slab linear roots retain their own bound.
  const hasTerrain=solid.shape.type==='compound'&&solid.shape.terrainGroups?.length>0;
  let sectionCount=1;
  if(solid.shape.type!=='sphere'){sectionCount=0;for(const part of solid.shape.parts)sectionCount+=part.sections?part.sections.length:1;}
  const capacity=sectionCount*128+(hasTerrain?maxIterations:0)+1;
  if (capacity > w.candidates.length) w.candidates = new Float64Array(capacity);
  w.pointMode = radius === 0 && hasTerrain;
  if (w.pointMode) {
    if (!w.pointMeshes || w.pointMeshes.length < capacity) {w.pointMeshes = new Int32Array(capacity);w.pointFaces = new Int32Array(capacity);}
    w.pointMeshes[0] = -1;w.pointFaces[0] = -1;
  }
  localPoint(solid, start, w.start); localPoint(solid, end, w.end);
  const p = w.start, d = w.end;
  d[0] -= p[0]; d[1] -= p[1]; d[2] -= p[2];
  let lower = 0, span = 1;
  if (Number.isFinite(solid.boundsRadius)) {
    const a = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    const b = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
    const bound = solid.boundsRadius + radius + 1e-6;
    const c = p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - bound ** 2;
    if (a === 0) return result;
    const discriminant = b * b - a * c;
    if (discriminant <= 0) return result;
    const root = Math.sqrt(discriminant), upper = Math.min(1, (-b + root) / a);
    lower = Math.max(0, (-b - root) / a);
    if (lower > upper) return result;
    span = upper - lower;
    for (let axis = 0; axis < 3; axis++) { p[axis] += d[axis] * lower; d[axis] *= span; }
  }
  if(hasTerrain&&radius>0){
    w.sweepRadius=radius;w.sweepLower=lower;w.sweepSpan=span;
    for(let axis=0;axis<3;axis++){w.sweepStart[axis]=start[axis];w.sweepDelta[axis]=end[axis]-start[axis];}
    const tolerance=Math.max(CONTACT_DISTANCE_TOLERANCE,64*Number.EPSILON*Math.max(1,radius,solid.boundsRadius??1));
    w.pruneTerrain=solidDistance(solid,start,w.contactDistance,w.contactWorkspace).distance>radius+tolerance;
    w.sweepSolid=solid;
  }
  try {
    if (solid.shape.type === 'sphere') pointRoots(w, p[0], p[1], p[2], d[0], d[1], d[2], radius + solid.shape.radius);
    else {
      for (const part of solid.shape.parts) {
        if(part.sections){for(const section of part.sections)slabRoots(w,section,p,d,radius);}
        else slabRoots(w,part,p,d,radius);
      }
      if(solid.shape.terrainGroups)for(let groupIndex=0;groupIndex<solid.shape.terrainGroups.length;groupIndex++){
        const mesh=solid.shape.terrainGroups[groupIndex];w.terrainGroupIndex=groupIndex;
        if(!terrainBoundsIntersect(mesh,p,d,radius))continue;
        if(!visitMeshTerrainSweepRoots(mesh,p,d,radius,w.terrain,terrainRoot,w)){
          result.status='failed';result.reason=w.terrain.reason;result.fraction=0;result.safeFraction=0;return result;
        }
        w.meshSweepNodes+=w.terrain.nodeVisits;w.meshSweepTests+=w.terrain.tests;w.meshSweepRoots+=w.terrain.rootCount;
      }
    }
  } catch (error) {
    if (error !== ROOT_LIMIT) throw error;
    result.status = 'failed'; result.reason = 'solid-root-budget'; result.fraction = 0; result.safeFraction = 0; return result;
  } finally {
    // A reusable query workspace must not retain a retired body's fine mesh.
    w.sweepSolid=null;
  }
  sortCandidates(w);
  const mx = end[0] - start[0], my = end[1] - start[1], mz = end[2] - start[2], travel = Math.hypot(mx, my, mz);
  // Entering at an already touching start is a legitimate zero-time event.
  for (let i = 0; i < w.candidateCount; i++) {
    const t = lower + w.candidates[i] * span;
    let next = i + 1;
    while (next < w.candidateCount && w.candidates[next] <= w.candidates[i] + 2e-15) next++;
    const after = next < w.candidateCount ? lower + w.candidates[next] * span : lower + span;
    if (after > t + 2e-15) {
      // Exact tangencies (including travel along an offset cap) have no open
      // interior interval. Validate the interval, rather than interpreting a
      // rounded double quartic root as an entering contact.
      const middle = (t + after) / 2;
      w.probe[0] = start[0] + mx * middle; w.probe[1] = start[1] + my * middle; w.probe[2] = start[2] + mz * middle;
      const tolerance = 64 * Number.EPSILON * Math.max(1, radius, solid.boundsRadius ?? 1);
      if (solidDistance(solid, w.probe, w.distance, w).distance >= radius - tolerance) continue;
    }
    w.probe[0] = start[0] + mx * t; w.probe[1] = start[1] + my * t; w.probe[2] = start[2] + mz * t;
    const dist = solidDistance(solid, w.probe, w.distance, w);
    let n = dist.normal;
    if (w.pointMode && w.pointFaces[i] >= 0) {
      pointFaceNormal(solid, solid.shape.terrainGroups[w.pointMeshes[i]], w.pointFaces[i], w.pointNormal);n = w.pointNormal.normal;
    }
    const entering = mx * n[0] + my * n[1] + mz * n[2];
    if (Math.abs(dist.distance - radius) > CONTACT_DISTANCE_TOLERANCE) continue;
    const grazing = 1e-10 * Math.max(1, travel);
    // A tangent starting on a concave inner wall enters at second order. Its
    // open interior interval was established above even though the first
    // derivative is zero. This is not the traversable convex tangent case.
    if (entering > grazing || (entering >= -grazing && t > 2e-15)) continue;
    result.status = 'hit'; result.fraction = t;
    // Offset back along the incoming ray by numerical skin, keeping the result
    // on the verified exterior rather than rounding a quartic root inward.
    result.safeFraction = Math.max(0, t - (Math.max(0, radius - dist.distance) + 1e-7) / Math.max(1e-12, -entering));
    result.normal[0] = n[0]; result.normal[1] = n[1]; result.normal[2] = n[2]; result.feature = dist.feature; result.part = dist.part;
    w.probe[0] = start[0] + mx * result.safeFraction; w.probe[1] = start[1] + my * result.safeFraction; w.probe[2] = start[2] + mz * result.safeFraction;
    if (solidDistance(solid, w.probe, w.distance, w).distance < radius - 1e-8) {
      result.status = 'failed'; result.reason = 'solid-root-precision'; result.fraction = 0; result.safeFraction = 0;
    }
    return result;
  }
  return result;
}
