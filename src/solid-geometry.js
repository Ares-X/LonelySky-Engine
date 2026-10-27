/** Distances and finite-feature continuous sweeps for static solid descriptors.
 * frame is an orthonormal world-to-local Matrix3 in Three.js column order.
 */
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
  const qy = Math.max(part.minY, Math.min(part.maxY, y));
  const vertical = y < part.minY ? part.minY - y : y > part.maxY ? y - part.maxY : -Math.min(y - part.minY, part.maxY - y);
  let nx, ny, nz;
  if (horizontal <= 0 && vertical <= 0) {
    if (vertical > horizontal) {
      out.distance = vertical; nx = 0; ny = y - part.minY < part.maxY - y ? -1 : 1; nz = 0; feature = ny < 0 ? 'bottom' : 'top';
    } else {
      out.distance = horizontal; nx = qx - x; ny = 0; nz = qz - z;
      if (nx === 0 && nz === 0) {
        if (feature === 'inner' || feature === 'outer') { const sign = feature === 'inner' ? -1 : 1; nx = sign * (r ? x / r : 1); nz = sign * (r ? z / r : 0); }
        else { const a = part.gapCenter + (feature === 'gap-plus' ? gap : -gap); const sign = feature === 'gap-plus' ? -1 : 1; nx = -Math.sin(a) * sign; nz = Math.cos(a) * sign; }
      }
    }
  } else {
    nx = horizontal > 0 ? x - qx : 0; ny = vertical > 0 ? y - qy : 0; nz = horizontal > 0 ? z - qz : 0;
    out.distance = Math.hypot(nx, ny, nz);
    if (vertical > 0) feature = horizontal > 0 ? capFeatures[feature][y < part.minY ? 0 : 1] : (y < part.minY ? 'bottom' : 'top');
  }
  const size = Math.hypot(nx, ny, nz);
  out.normal[0] = nx / size; out.normal[1] = ny / size; out.normal[2] = nz / size; out.feature = feature;
}
export function createSolidWorkspace() {
  return { point: [0, 0, 0], start: [0, 0, 0], end: [0, 0, 0], probe: [0, 0, 0], scratch: [0, 0],
    distance: makeDistance(), partDistance: makeDistance(), roots: Array.from({ length: 5 }, () => new Float64Array(16)), rootCounts: new Uint8Array(5),
    coefficients: Array.from({ length: 5 }, () => new Float64Array(5)), candidates: new Float64Array(1024), candidateCount: 0, evaluations: 0, maxIterations: 32768,
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
      const d = workspace.partDistance;
      slabDistance(shape.parts[i], p[0], p[1], p[2], d, workspace.scratch);
      if (d.distance < out.distance) {
        out.distance = d.distance; out.normal[0] = d.normal[0]; out.normal[1] = d.normal[1]; out.normal[2] = d.normal[2]; out.feature = d.feature; out.part = i;
      }
    }
  }
  worldNormal(solid, out); return out;
}
function siftCandidates(values, root, end) {
  while (root * 2 + 1 < end) {
    let child = root * 2 + 1;
    if (child + 1 < end && values[child] < values[child + 1]) child++;
    if (values[root] >= values[child]) return;
    const value = values[root]; values[root] = values[child]; values[child] = value; root = child;
  }
}
function sortCandidates(w) {
  const values = w.candidates, count = w.candidateCount;
  // In-place heap sort avoids a native Array.sort temporary backing buffer.
  for (let root = Math.floor(count / 2) - 1; root >= 0; root--) siftCandidates(values, root, count);
  for (let end = count - 1; end > 0; end--) {
    const value = values[0]; values[0] = values[end]; values[end] = value; siftCandidates(values, 0, end);
  }
}

function polynomial(w, degree, t) {
  if (++w.evaluations > w.maxIterations) throw ROOT_LIMIT;
  const c = w.coefficients[degree]; let result = c[degree];
  for (let i = degree - 1; i >= 0; i--) result = result * t + c[i];
  return result;
}
const ROOT_LIMIT = Symbol('solid root budget');
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
  for (let i = 0; i < w.rootCounts[degree]; i++) w.candidates[w.candidateCount++] = roots[i];
}
function pointRoots(w, x, y, z, dx, dy, dz, radius) {
  addPolynomial(w, x * x + y * y + z * z - radius * radius, 2 * (x * dx + y * dy + z * dz), dx * dx + dy * dy + dz * dz);
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
  w.evaluations = 0; w.maxIterations = maxIterations; w.candidateCount = 1; w.candidates[0] = 0;
  const capacity = (solid.shape.type === 'sphere' ? 1 : solid.shape.parts.length) * 128 + 1;
  if (capacity > w.candidates.length) w.candidates = new Float64Array(capacity);
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
  try {
    if (solid.shape.type === 'sphere') pointRoots(w, p[0], p[1], p[2], d[0], d[1], d[2], radius + solid.shape.radius);
    else for (const part of solid.shape.parts) slabRoots(w, part, p, d, radius);
  } catch (error) {
    if (error !== ROOT_LIMIT) throw error;
    result.status = 'failed'; result.reason = 'solid-root-budget'; result.fraction = 0; result.safeFraction = 0; return result;
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
    const dist = solidDistance(solid, w.probe, w.distance, w), n = dist.normal;
    const entering = mx * n[0] + my * n[1] + mz * n[2];
    if (Math.abs(dist.distance - radius) > 1e-6) continue;
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
