import { hashSeed, randomFromSeed } from './random.js';
import {GALACTIC_SPATIAL_MEDIUM_REVISION, sampleSpatialGalacticMedium, sampleSpatialGalacticStars} from './galactic-spatial-medium.js';

export const GALACTIC_MEDIUM_REVISION = 2;
export const GALACTIC_MEDIUM_MAX_RESOLUTION = 1024;
export const GALACTIC_MEDIUM_MAX_STARS = 16384;
const Y = [.2126, .7152, .0722];
export const GALACTIC_MEDIUM_STELLAR_VOLUME_RESOLUTION = 64;
export const GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION = 128;
const fields = new WeakMap();
const luminance = color => color[0] * Y[0] + color[1] * Y[1] + color[2] * Y[2];
const smooth = (a, b, value) => { const t = Math.min(1, Math.max(0, (value - a) / (b - a))); return t * t * (3 - 2 * t); };
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

function spectrum(value) {
  if (!vector(value) || value.some(n => n < 0) || luminance(value) <= 0) throw new TypeError('Expected a nonnegative luminous RGB spectrum');
  const power = luminance(value);
  return Object.freeze(value.map(n => n / power));
}
function lattice(x, z, seed) {
  let n = Math.imul(x, 0x1f123bb5) ^ Math.imul(z, 0x5f356495) ^ seed;
  n = Math.imul(n ^ n >>> 16, 0x45d9f3b); n = Math.imul(n ^ n >>> 16, 0x45d9f3b);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}
function noise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = lattice(ix, iz, seed), b = lattice(ix + 1, iz, seed);
  const c = lattice(ix, iz + 1, seed), d = lattice(ix + 1, iz + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function fbm(x, z, seed) {
  return (noise(x, z, seed) * .56 + noise(x * 2.13 + 17.1, z * 2.13 - 8.7, seed + 1) * .28
    + noise(x * 4.51 - 3.8, z * 4.51 + 22.4, seed + 2) * .16);
}
// Seeded 3D gradient field for the finite stellar population, independent of
// the disk value-noise stream. Twelve unit face-diagonal gradients avoid a
// direction table and allocate nothing at a lattice query.
function gradient3(x, y, z, dx, dy, dz, seed) {
  let n = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x6c8e9cf5) ^ Math.imul(z, 0x5f356495) ^ seed;
  n = Math.imul(n ^ n >>> 16, 0x45d9f3b); n = (n ^ n >>> 16) >>> 0;
  const zero = n % 3, a = zero === 0 ? dy : dx, b = zero === 2 ? dy : dz;
  return ((n & 4 ? -a : a) + (n & 8 ? -b : b)) * Math.SQRT1_2;
}
function gradientNoise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), u = x - ix, v = y - iy, w = z - iz;
  const fx = u * u * u * (u * (u * 6 - 15) + 10), fy = v * v * v * (v * (v * 6 - 15) + 10), fz = w * w * w * (w * (w * 6 - 15) + 10);
  const a = gradient3(ix, iy, iz, u, v, w, seed), b = gradient3(ix + 1, iy, iz, u - 1, v, w, seed);
  const c = gradient3(ix, iy + 1, iz, u, v - 1, w, seed), d = gradient3(ix + 1, iy + 1, iz, u - 1, v - 1, w, seed);
  const e = gradient3(ix, iy, iz + 1, u, v, w - 1, seed), f = gradient3(ix + 1, iy, iz + 1, u - 1, v, w - 1, seed);
  const g = gradient3(ix, iy + 1, iz + 1, u, v - 1, w - 1, seed), h = gradient3(ix + 1, iy + 1, iz + 1, u - 1, v - 1, w - 1, seed);
  const lower = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  const upper = (e + (f - e) * fx) * (1 - fy) + (g + (h - g) * fx) * fy;
  return (lower + (upper - lower) * fz) * Math.SQRT1_2;
}
// A bounded, separable Gaussian in parent-radius units. Only mature-star
// column luminosity is filtered. Truncation is 3 sigma per X/Z axis; clipping
// retains the existing r<.9 disk domain. The caller restores the old budget.
// One creation-only scalar buffer; no second runtime field or noise stream.
function* filterOldStellarColumn(texels, n, height) {
  yield 'old-disk-filter-allocation';
  const step = 2 / n, radius = Math.floor(3 * height / step);
  const kernel = new Float64Array(radius * 2 + 1), scratch = new Float64Array(n * n);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const weight = Math.exp(-.5 * (i * step / height) ** 2); kernel[i + radius] = weight; sum += weight; }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  for (let z = 0; z < n; z++) {
    yield 'old-disk-filter-x';
    for (let x = 0; x < n; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++) if (x + k >= 0 && x + k < n) value += texels[(z * n + x + k) * 4] * kernel[k + radius];
      scratch[z * n + x] = value;
    }
  }
  let integrated = 0;
  for (let z = 0; z < n; z++) {
    yield 'old-disk-filter-z';
    for (let x = 0; x < n; x++) {
      let value = 0;
      const px = (x + .5) * step - 1, pz = (z + .5) * step - 1;
      if (x > 0 && x < n - 1 && z > 0 && z < n - 1 && Math.hypot(px, pz) < .9)
        for (let k = -radius; k <= radius; k++) if (z + k >= 0 && z + k < n) value += scratch[(z + k) * n + x] * kernel[k + radius];
      const index = (z * n + x) * 4;
      texels[index] = value; integrated += texels[index] * step * step;
    }
  }
  return integrated;
}
function* createBulgePopulation(seed, axes, center, luminosity, contrast) {
  yield 'stellar-allocation';
  const n = GALACTIC_MEDIUM_STELLAR_VOLUME_RESOLUTION, step = 2 / n, texels = new Float32Array(n ** 3), cdf = new Float64Array(n ** 3);
  const pixelVolume = step ** 3 * axes[0] * axes[1] * axes[2];
  if (!Number.isFinite(pixelVolume) || pixelVolume <= 0) throw new RangeError('Bulge axes cannot represent a finite voxel volume');
  if (luminosity === 0) return {texels, cdf, pixelVolume, tableLuminosity: 0, supportRadius: 0};
  const salt = hashSeed(`${seed}:bulge-population-v1`), floor = (1 - contrast) ** 3;
  let integrated = 0, supportRadius = 0;
  // .94 + sqrt(3)*step < 1: complete trilinear hats remain inside the
  // normalized bulge ellipsoid, including their zero-voxel neighbours.
  const radialSupport = .94;
  for (let iz = 1; iz < n - 1; iz++) for (let iy = 1; iy < n - 1; iy++) {
    yield 'stellar-density';
    for (let ix = 1; ix < n - 1; ix++) {
    const x = (ix + .5) * step - 1, y = (iy + .5) * step - 1, z = (iz + .5) * step - 1;
    const r2 = (x * x + y * y + z * z) / (radialSupport * radialSupport);
    if (r2 >= 1) continue;
    // Three differently oriented frequency bands with lattice frequencies
    // below the nominal voxel Nyquist rate (not a bandlimited-field claim).
    // Their product gives hierarchical 3D stellar complexes.
    const large = smooth(.2, .8, .5 + 1.8 * gradientNoise3((.8 * x + .6 * z) * 2.6 + 17.3, y * 2.6 - 9.7, (-.6 * x + .8 * z) * 2.6 + 3.1, salt));
    const cloud = smooth(.2, .8, .5 + 1.8 * gradientNoise3(x * 6.3 - 5.4, (.6 * y + .8 * z) * 6.3 + 8.2, (-.8 * y + .6 * z) * 6.3 - 13.6, salt + 37));
    const u = (x - y) * Math.SQRT1_2, v = (x + y) * Math.SQRT1_2;
    const fine = smooth(.2, .8, .5 + 1.8 * gradientNoise3((.6 * u + .8 * z) * 13.7 + 4.9, v * 13.7 - 18.2, (-.8 * u + .6 * z) * 13.7 + 11.6, salt + 71));
    const hierarchy = large * (.08 + .92 * cloud) * (.1 + .9 * fine);
    const index = (iz * n + iy) * n + ix;
    texels[index] = (1 - r2) ** 2 * (floor + (1 - floor) * hierarchy);
    integrated += texels[index] * pixelVolume;
    if (texels[index] > 0) {
      // Exact maximum norm at the eight corners of this voxel's hat support.
      const bx = Math.max(Math.abs(center[0] + (x - step) * axes[0]), Math.abs(center[0] + (x + step) * axes[0]));
      const by = Math.max(Math.abs(center[1] + (y - step) * axes[1]), Math.abs(center[1] + (y + step) * axes[1]));
      const bz = Math.max(Math.abs(center[2] + (z - step) * axes[2]), Math.abs(center[2] + (z + step) * axes[2]));
      supportRadius = Math.max(supportRadius, Math.hypot(bx, by, bz));
    }
  }
  }
  if (!Number.isFinite(integrated) || integrated <= 0) throw new RangeError('Bulge population has no finite integrated luminosity');
  const scale = luminosity / integrated;
  let tableLuminosity = 0;
  for (let i = 0; i < cdf.length; i++) {
    if ((i & 1023) === 0) yield 'stellar-cdf';
    texels[i] *= scale;
    if (!Number.isFinite(texels[i])) throw new RangeError('Bulge population exceeds Float32 density range');
    tableLuminosity += texels[i] * pixelVolume;
    cdf[i] = tableLuminosity;
  }
  return {texels, cdf, pixelVolume, tableLuminosity, supportRadius};
}
// Seeded world-space sheets: independent rails, real polygonal notches and
// edge-connected forks. Finite extrusion is artistic geometry, not a fluid.
function* createDustSheets(seed, phase, pitch, arms) {
  yield 'sheet-geometry';
  const random = randomFromSeed(`${seed}:dust-sheets-v1`), vertices = [], faces = [], paths = [], sheets = [];
  const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = value => { const length = Math.hypot(...value); if (!(length > 1e-12)) throw new RangeError('Degenerate seeded sheet frame'); return value.map(n => n / length); };
  const vertex = (p, guide) => { vertices.push({p, guide, h: .006 + random() * .006, amplitude: .85 + random() * .3, normal: [0, 0, 0]}); return vertices.length - 1; };
  const quad = (a, b) => { faces.push({ids: [a.left, a.right, b.right]}, {ids: [a.left, b.right, b.left]}); };
  const sign = random() < .5 ? -1 : 1;
  let railLength = 0;
  for (let branch = 0; branch < 2; branch++) {
    const points = [], bend = random() * Math.PI * 2, lift = sign * (branch === 0 ? 1 : -1);
    const arm = branch === 0 ? 0 : (arms > 1 ? Math.PI * 2 / arms : Math.PI);
    for (let i = 0; i < 7; i++) {
      const t = i / 6, r = .07 + .095 * t, angle = Math.log(r + .07) / pitch + phase + arm + .13 * Math.sin(t * Math.PI * 2 + bend);
      points.push([Math.cos(angle) * r, lift * (.012 + .09 * Math.sin(t * Math.PI * .5)) + .009 * Math.sin(t * Math.PI * 2 + bend), Math.sin(angle) * r]);
      if (i) railLength += Math.hypot(...subtract(points[i], points[i - 1]));
    }
    paths.push(points);
  }
  const mainLength = .47 + random() * .06, spatialScale = mainLength / railLength;
  railLength = mainLength;
  for (let branch = 0; branch < 2; branch++) {
    const points = paths[branch].map(p => p.map(n => n * spatialScale));
    const folds = [random() * 1.4 - .7, random() * 1.4 - .7, random() * 1.4 - .7], rows = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i], tangent = unit(subtract(points[Math.min(i + 1, points.length - 1)], points[Math.max(0, i - 1)]));
      const radial = [p[0], 0, p[2]], across = unit(add(radial, tangent, -dot(radial, tangent)));
      const t = i / (points.length - 1), f = t <= .5 ? folds[0] + (folds[1] - folds[0]) * smooth(0, .5, t) : folds[1] + (folds[2] - folds[1]) * smooth(.5, 1, t);
      const b = add(across.map(n => n * Math.cos(f)), cross(tangent, across), Math.sin(f)), normal = unit(cross(tangent, b));
      const leftWidth = .018 + random() * .037, rightWidth = .012 + random() * .033;
      const leftEnd = i === 0 ? -.012 * random() : i === points.length - 1 ? .018 * random() : 0;
      const rightEnd = i === 0 ? -.006 * random() : i === points.length - 1 ? -.01 * random() : 0;
      rows.push({left: vertex(add(add(p, b, -leftWidth), tangent, leftEnd), normal), right: vertex(add(add(p, b, rightWidth), tangent, rightEnd), normal), tangent, across: b, guide: normal});
    }
    // Insert a V-shaped cut into one rail while leaving the opposite rail in
    // place. Alternating sides prevents a sequence of pinched round beads.
    const cut = 1 + Math.floor(random() * 3), a = rows[cut], b = rows[cut + 1], depth = .4 + random() * .35;
    let left = add(vertices[a.left].p, subtract(vertices[b.left].p, vertices[a.left].p), .5);
    let right = add(vertices[a.right].p, subtract(vertices[b.right].p, vertices[a.right].p), .5);
    const guide = unit(add(a.guide, b.guide));
    if (branch === 0) left = add(left, subtract(right, left), depth); else right = add(right, subtract(left, right), depth);
    rows.splice(cut + 1, 0, {left: vertex(left, guide), right: vertex(right, guide), tangent: unit(add(a.tangent, b.tangent)), across: unit(add(a.across, b.across)), guide});
    for (let i = 0; i < rows.length - 1; i++) if (!(branch === 1 && i === 4)) quad(rows[i], rows[i + 1]);
    sheets.push(rows);
  }
  const forks = random() < .5 ? 1 : 2;
  for (let branch = 0; branch < forks; branch++) {
    const rows = sheets[branch], a = rows[2], b = rows[3], side = branch === 0 ? 1 : -1;
    const leftId = side > 0 ? a.right : b.left, rightId = side > 0 ? b.right : a.left;
    const middle = add(vertices[leftId].p, subtract(vertices[rightId].p, vertices[leftId].p), .5);
    const tangent = unit(add(a.tangent, b.tangent));
    const direction = unit(add(add(a.across.map(n => n * side), tangent, .22), a.guide, .25 + random() * .35));
    const across = unit(add(tangent, direction, -dot(tangent, direction)));
    let guide = unit(cross(direction, across)); if (dot(guide, a.guide) < 0) guide = guide.map(n => -n);
    let previous = {left: leftId, right: rightId};
    const length = .07 + random() * .025; railLength += length;
    for (let i = 1; i <= 2; i++) {
      const t = i / 2, center = add(add(middle, direction, length * t), guide, .008 * t * t);
      const left = add(center, across, -(.012 + random() * .02)), right = add(center, across, .01 + random() * .018);
      const row = {left: vertex(left, guide), right: vertex(i === 2 ? add(right, direction, -.012) : right, guide)};
      quad(previous, row); previous = row;
    }
  }
  const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`, edges = new Map();
  let surfaceArea = 0;
  for (const face of faces) {
    yield 'sheet-geometry';
    const [a, b, c] = face.ids.map(i => vertices[i]);
    let normal = cross(subtract(b.p, a.p), subtract(c.p, a.p));
    const area2 = Math.hypot(...normal); if (!(area2 > 1e-12)) throw new RangeError('Degenerate seeded sheet face');
    if (dot(normal, add(add(a.guide, b.guide), c.guide)) < 0) { [face.ids[1], face.ids[2]] = [face.ids[2], face.ids[1]]; normal = normal.map(n => -n); }
    surfaceArea += area2 * .5;
    for (const i of face.ids) for (let axis = 0; axis < 3; axis++) vertices[i].normal[axis] += normal[axis];
    for (let i = 0; i < 3; i++) { const key = edgeKey(face.ids[i], face.ids[(i + 1) % 3]); edges.set(key, (edges.get(key) ?? 0) + 1); }
  }
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    yield 'sheet-geometry';
    const normal = unit(v.normal); v.bottom = add(v.p, normal, -v.h); v.top = add(v.p, normal, v.h);
    for (let axis = 0; axis < 3; axis++) { minimum[axis] = Math.min(minimum[axis], v.bottom[axis], v.top[axis]); maximum[axis] = Math.max(maximum[axis], v.bottom[axis], v.top[axis]); }
  }
  for (const face of faces) {
    yield 'sheet-geometry';
    // Sorting vertex IDs makes the extrusion diagonal identical on both sides
    // of every shared edge. The thin prisms meet without spherical edge fill.
    face.ids.sort((a, b) => a - b);
    const v = face.ids.map(i => vertices[i]), area2 = Math.hypot(...cross(subtract(v[1].p, v[0].p), subtract(v[2].p, v[0].p)));
    face.edgeFade = face.ids.map((id, i) => edges.get(edgeKey(face.ids[(i + 1) % 3], face.ids[(i + 2) % 3])) === 1 ? Math.min(.003, .2 * area2 / Math.hypot(...subtract(v[(i + 1) % 3].p, v[(i + 2) % 3].p))) : 0);
    face.altitudes = face.ids.map((id, i) => area2 / Math.hypot(...subtract(v[(i + 1) % 3].p, v[(i + 2) % 3].p)));
    const corners = [v[0].bottom, v[1].bottom, v[2].bottom, v[0].top, v[1].top, v[2].top];
    face.tetrahedra = [[0, 1, 2, 5], [0, 1, 4, 5], [0, 3, 4, 5]].map(indices => {
      const p = indices.map(i => corners[i]), e1 = subtract(p[1], p[0]), e2 = subtract(p[2], p[0]), e3 = subtract(p[3], p[0]);
      const c23 = cross(e2, e3), determinant = dot(e1, c23);
      if (Math.abs(determinant) < 1e-15) throw new RangeError('Degenerate seeded sheet extrusion');
      const inverse = [...c23, ...cross(e3, e1), ...cross(e1, e2)].map(n => n / determinant);
      return {origin: p[0], inverse, depths: indices.map(i => i < 3 ? -1 : 1), base: indices.map(i => i % 3), amplitudes: indices.map(i => v[i % 3].amplitude)};
    });
    face.minimum = [0, 1, 2].map(axis => Math.min(...corners.map(p => p[axis])));
    face.maximum = [0, 1, 2].map(axis => Math.max(...corners.map(p => p[axis])));
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) * .5), frameSupport = 1 - 4 / GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION;
  const axes = minimum.map((value, axis) => (maximum[axis] - value) / (2 * frameSupport));
  return {faces, center, axes, railLength, surfaceArea};
}
// The source frame and noise are unscaled. Affine world Y compression applies
// to the complete warped field; its Jacobian enters the sole final D scale.
// Rail length/surface area describe the original authoring mesh, before warp
// and vertical scaling, rather than the final scalar density support.
function* bakeDustSheets(geometry, integral, seed, verticalScale) {
  yield 'dust-setup';
  const n = GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION, step = 2 / n, {faces, center: sourceCenter, axes: sourceAxes} = geometry;
  const random = randomFromSeed(`${seed}:dust-sheet-warp-v1`);
  const warpBound = [0, 1, 2].map(() => .012 + random() * .008);
  const center = sourceCenter, axes = sourceAxes.map((value, axis) => (value + warpBound[axis]) / (1 - 4 / n));
  const pixelVolume = step ** 3 * axes[0] * axes[1] * axes[2];
  const sourcePixelVolume = step ** 3 * sourceAxes[0] * sourceAxes[1] * sourceAxes[2];
  const worldPixelVolume = pixelVolume * verticalScale;
  const worldCenter = verticalScale === 1 ? center : [center[0], center[1] * verticalScale, center[2]];
  const worldAxes = verticalScale === 1 ? axes : [axes[0], axes[1] * verticalScale, axes[2]];
  const worldWarpBound = Object.freeze([warpBound[0], warpBound[1] * verticalScale, warpBound[2]]);
  if (integral === 0) return {texels: new Float32Array(n ** 3), pixelVolume: worldPixelVolume, center: worldCenter, axes: worldAxes, integral: 0, supportRadius: 0, maximumDensity: 0,
    synthesis: {sourceIntegral: 0, warpedIntegral: 0, modulatedIntegral: 0, modulationRetention: 1, sourceOccupiedVoxels: 0, warpedOccupiedVoxels: 0, outputOccupiedVoxels: 0, warpBound: worldWarpBound, temporaryArrayBytes: 0}};
  yield 'dust-source-allocation';
  const sourceTexels = new Float32Array(n ** 3);
  const sourceActive = [];
  for (const face of faces) {
    const x0 = Math.max(1, Math.ceil(((face.minimum[0] - sourceCenter[0]) / sourceAxes[0] + 1) * n * .5 - .5)), x1 = Math.min(n - 2, Math.floor(((face.maximum[0] - sourceCenter[0]) / sourceAxes[0] + 1) * n * .5 - .5));
    const y0 = Math.max(1, Math.ceil(((face.minimum[1] - sourceCenter[1]) / sourceAxes[1] + 1) * n * .5 - .5)), y1 = Math.min(n - 2, Math.floor(((face.maximum[1] - sourceCenter[1]) / sourceAxes[1] + 1) * n * .5 - .5));
    const z0 = Math.max(1, Math.ceil(((face.minimum[2] - sourceCenter[2]) / sourceAxes[2] + 1) * n * .5 - .5)), z1 = Math.min(n - 2, Math.floor(((face.maximum[2] - sourceCenter[2]) / sourceAxes[2] + 1) * n * .5 - .5));
    for (let iz = z0; iz <= z1; iz++) for (let iy = y0; iy <= y1; iy++) {
    yield 'dust-source';
    for (let ix = x0; ix <= x1; ix++) {
      const x = sourceCenter[0] + ((ix + .5) * step - 1) * sourceAxes[0], y = sourceCenter[1] + ((iy + .5) * step - 1) * sourceAxes[1], z = sourceCenter[2] + ((iz + .5) * step - 1) * sourceAxes[2];
      let density = 0;
      for (const t of face.tetrahedra) {
        const dx = x - t.origin[0], dy = y - t.origin[1], dz = z - t.origin[2], m = t.inverse;
        const b1 = m[0] * dx + m[1] * dy + m[2] * dz, b2 = m[3] * dx + m[4] * dy + m[5] * dz, b3 = m[6] * dx + m[7] * dy + m[8] * dz, b0 = 1 - b1 - b2 - b3;
        if (Math.min(b0, b1, b2, b3) < -1e-10) continue;
        const depth = b0 * t.depths[0] + b1 * t.depths[1] + b2 * t.depths[2] + b3 * t.depths[3];
        let taper = 1;
        for (let edge = 0; edge < 3; edge++) if (face.edgeFade[edge] > 0) {
          const lambda = (t.base[0] === edge ? b0 : 0) + (t.base[1] === edge ? b1 : 0) + (t.base[2] === edge ? b2 : 0) + (t.base[3] === edge ? b3 : 0);
          taper *= smooth(0, face.edgeFade[edge], lambda * face.altitudes[edge]);
        }
        const amplitude = b0 * t.amplitudes[0] + b1 * t.amplitudes[1] + b2 * t.amplitudes[2] + b3 * t.amplitudes[3];
        density = Math.max(0, 1 - depth * depth) ** 2 * taper * amplitude;
        break;
      }
      if (density <= 0) continue;
      const index = (iz * n + iy) * n + ix;
      if (sourceTexels[index] === 0) sourceActive.push(index);
      sourceTexels[index] += density;
    }
  }
  }
  let sourceIntegral = 0;
  for (let i = 0; i < sourceActive.length; i++) {
    if ((i & 1023) === 0) yield 'dust-source-integral';
    sourceIntegral += sourceTexels[sourceActive[i]] * sourcePixelVolume;
  }
  // One temporary coarse vector field, evaluated in the seed-fixed object
  // frame from world positions. Every face receives the same deformation.
  // The convex trilinear interpolation preserves each component's bound.
  yield 'dust-warp-allocation';
  const warpSize = 32, warp = new Float32Array(warpSize ** 3 * 3), salt = hashSeed(`${seed}:dust-sheet-warp-v1`);
  for (let iz = 0; iz < warpSize; iz++) for (let iy = 0; iy < warpSize; iy++) {
    yield 'dust-warp';
    for (let ix = 0; ix < warpSize; ix++) {
    const x = (center[0] + ((ix + .5) * 2 / warpSize - 1) * axes[0] - sourceCenter[0]) / (2 * sourceAxes[0]) + .5;
    const y = (center[1] + ((iy + .5) * 2 / warpSize - 1) * axes[1] - sourceCenter[1]) / (2 * sourceAxes[1]) + .5;
    const z = (center[2] + ((iz + .5) * 2 / warpSize - 1) * axes[2] - sourceCenter[2]) / (2 * sourceAxes[2]) + .5;
    for (let channel = 0; channel < 3; channel++) {
      const seedOffset = salt + channel * 101;
      const large = gradientNoise3((.8 * x + .6 * z) * 3.1 + 7.3 + channel * 11, y * 3.1 - 2.7, (-.6 * x + .8 * z) * 3.1 + 11.2, seedOffset);
      const fine = gradientNoise3(x * 7.3 - 8.4, (.6 * y + .8 * z) * 7.3 + 13.1 + channel * 17, (-.8 * y + .6 * z) * 7.3 - 3.6, seedOffset + 43);
      warp[((iz * warpSize + iy) * warpSize + ix) * 3 + channel] = warpBound[channel] * Math.tanh(3 * (.65 * large + .35 * fine));
    }
  }
  }
  yield 'dust-target-allocation';
  const texels = new Float32Array(n ** 3), active = [];
  const densitySalt = hashSeed(`${seed}:dust-sheet-density-v1`);
  const expansion = Math.max(axes[0] / sourceAxes[0], axes[1] / sourceAxes[1], axes[2] / sourceAxes[2]);
  // Source-frame [0,1] coordinates: finest nominal lattice period spans at
  // least four output voxels after the frame expansion, not a screen effect.
  const fineFrequency = Math.min(27, n / (4 * expansion));
  let warpedIntegral = 0, total = 0, warpedOccupiedVoxels = 0, supportRadius = 0;
  for (let iz = 1; iz < n - 1; iz++) for (let iy = 1; iy < n - 1; iy++) {
    yield 'dust-resample';
    for (let ix = 1; ix < n - 1; ix++) {
    const u = (ix + .5) * warpSize / n - .5, v = (iy + .5) * warpSize / n - .5, w = (iz + .5) * warpSize / n - .5;
    const wx = Math.floor(u), wy = Math.floor(v), wz = Math.floor(w), fx = u - wx, fy = v - wy, fz = w - wz;
    let dx = 0, dy = 0, dz = 0;
    for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const cx = Math.max(0, Math.min(warpSize - 1, wx + x)), cy = Math.max(0, Math.min(warpSize - 1, wy + y)), cz = Math.max(0, Math.min(warpSize - 1, wz + z));
      const index = ((cz * warpSize + cy) * warpSize + cx) * 3, weight = (x ? fx : 1 - fx) * (y ? fy : 1 - fy) * (z ? fz : 1 - fz);
      dx += warp[index] * weight; dy += warp[index + 1] * weight; dz += warp[index + 2] * weight;
    }
    const px = center[0] + ((ix + .5) * step - 1) * axes[0], py = center[1] + ((iy + .5) * step - 1) * axes[1], pz = center[2] + ((iz + .5) * step - 1) * axes[2];
    const density = volumeDensity(sourceTexels, n, px + dx, py + dy, pz + dz, sourceCenter, sourceAxes);
    if (density <= 0) continue;
    warpedIntegral += density * pixelVolume; warpedOccupiedVoxels++;
    const x = (px - sourceCenter[0]) / (2 * sourceAxes[0]) + .5, y = (py - sourceCenter[1]) / (2 * sourceAxes[1]) + .5, z = (pz - sourceCenter[2]) / (2 * sourceAxes[2]) + .5;
    const qx = x + dx / (2 * sourceAxes[0]), qy = y + dy / (2 * sourceAxes[1]), qz = z + dz / (2 * sourceAxes[2]);
    const large = smooth(.12, .76, .5 + 1.6 * gradientNoise3((.8 * x + .6 * z) * 3 + 2.3, y * 3 - 5.1, (-.6 * x + .8 * z) * 3 + 8.7, densitySalt));
    const middle = smooth(.18, .82, .5 + 1.6 * gradientNoise3(qx * 11 - 3.4, (.6 * qy + .8 * qz) * 11 + 9.2, (-.8 * qy + .6 * qz) * 11 - 7.6, densitySalt + 47));
    const diagonal = (x - y) * Math.SQRT1_2, across = (x + y) * Math.SQRT1_2;
    const fine = smooth(.15, .85, .5 + 1.6 * gradientNoise3((.6 * diagonal + .8 * z) * fineFrequency + 17.2, across * fineFrequency - 9.3, (-.8 * diagonal + .6 * z) * fineFrequency + 4.8, densitySalt + 89));
    const modulation = large * (.3 + .7 * middle) * (.7 + .3 * fine);
    const index = (iz * n + iy) * n + ix;
    texels[index] = density * modulation;
    if (texels[index] === 0) continue;
    active.push(index); total += texels[index] * pixelVolume;
    supportRadius = Math.max(supportRadius, Math.hypot(Math.max(Math.abs(px - step * axes[0]), Math.abs(px + step * axes[0])), Math.max(Math.abs((py - step * axes[1]) * verticalScale), Math.abs((py + step * axes[1]) * verticalScale)), Math.max(Math.abs(pz - step * axes[2]), Math.abs(pz + step * axes[2]))));
  }
  }
  if (!Number.isFinite(total) || total <= 0) throw new RangeError('Naturalized dust sheets have no finite integrated density');
  // This is the sole normalization. The temporary source is never normalized
  // or retained by the medium. Warp and source arrays end with this creation.
  const scale = integral / (total * verticalScale);
  let actual = 0, maximumDensity = 0;
  for (let i = 0; i < active.length; i++) {
    if ((i & 511) === 0) yield 'dust-normalize';
    const index = active[i];
    texels[index] *= scale;
    if (!Number.isFinite(texels[index])) throw new RangeError('Dust sheets exceed Float32 density range');
    actual += texels[index] * worldPixelVolume; maximumDensity = Math.max(maximumDensity, texels[index]);
  }
  return {texels, pixelVolume: worldPixelVolume, center: worldCenter, axes: worldAxes, integral: actual, supportRadius, maximumDensity,
    synthesis: {sourceIntegral: sourceIntegral * verticalScale, warpedIntegral: warpedIntegral * verticalScale, modulatedIntegral: total * verticalScale, modulationRetention: total / warpedIntegral, sourceOccupiedVoxels: sourceActive.length, warpedOccupiedVoxels, outputOccupiedVoxels: active.length, warpBound: worldWarpBound, fineFrequency, temporaryArrayBytes: sourceTexels.byteLength + warp.byteLength}};
}
function volumeDensity(texels, n, x, y, z, center, axes) {
  const bx = (x - center[0]) / axes[0], by = (y - center[1]) / axes[1], bz = (z - center[2]) / axes[2];
  if (Math.abs(bx) >= 1 || Math.abs(by) >= 1 || Math.abs(bz) >= 1) return 0;
  const u = (bx + 1) * n * .5 - .5, v = (by + 1) * n * .5 - .5, w = (bz + 1) * n * .5 - .5;
  const ix = Math.floor(u), iy = Math.floor(v), iz = Math.floor(w), fx = u - ix, fy = v - iy, fz = w - iz;
  let density = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const cx = Math.max(0, Math.min(n - 1, ix + dx)), cy = Math.max(0, Math.min(n - 1, iy + dy)), cz = Math.max(0, Math.min(n - 1, iz + dz));
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    density += texels[(cz * n + cy) * n + cx] * weight;
  }
  return density;
}
function compact(value, height) {
  const t = value / height;
  return Math.abs(t) < 1 ? (1 - t * t) ** 2 * 15 / (16 * height) : 0;
}
function bounded(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`Invalid galactic medium ${name}`);
}

/** A finite artistic stellar/emitting medium, not an orbit or gas solver.
 * Coordinates and ray lengths are in normalized parent-radius units. Texels
 * are row-major (z,x), sampled at centers of [-1,1]^2 with LINEAR filtering;
 * dustCloudVerticalScale (default 1, range .1–2) scales the complete cloud
 * world Y coordinate, including warp, with inverse-density Jacobian so optical
 * mass remains fixed. It is an artistic aspect ratio, not gas compression.
 * Revision 2 RGBA is (old luminosity column, young luminosity column,
 * zero padding, dust optical depth column). It must not be interpreted as RGB.
 * All four edge rows/columns are zero. The two stellar columns use Y=1
 * oldStellarColor/youngStellarColor and heights stellarHeight/youngStellarHeight.
 * The mature column has a 3-sigma truncated Gaussian XZ low-pass with sigma
 * stellarHeight; both components retain their independently normalized budgets. Dust RGB means relative extinction
 * coefficients, not a black painted layer. The RGBA verticalGeometry table uses
 * the same coordinates: RG is dust offset/height scale; BA is stellar
 * offset/height scale. The two geometries share clouds but can differ.
 * Both are interpolated BEFORE evaluating the normalized vertical profile;
 * each warped/thickened dust column still integrates to A; the two stellar
 * columns integrate to their respective scalar luminosities. dustVerticalBound and stellarVerticalBound are global slabs. The
 * Stellar and dust volume data are independent scalar 3D tables, x-fastest
 * then y then z: stellarVolumeTexels (64^3) uses bulgeCenter/axes;
 * dustVolumeTexels (128^3) uses dustCloudCenter/axes. Each frame maps
 * [-1,1]^3 at texel centers. Pixel
 * volumes include the frame Jacobian. All table edges are zero. dustIntegral
 * is the original A integral, redistributed without adding optical mass.
 *
 * The frozen metadata owns its tables for its lifetime. Typed-array elements
 * cannot be frozen: consumers must treat all four table arrays as read-only, including after
 * upload. No global cache or external resources are created.
 */
function* generateGalacticMedium({ seed, morphology = 'spiral', resolution = 512,
  totalLuminosity = .012, resolvedFraction = .15, arms = 3, pitch = .28,
  stellarHeight = .035, youngStellarHeight = stellarHeight / 4, dustHeight = .009, dustWarp = 0, dustHeightVariation = 0,
  stellarWarp = 0, stellarHeightVariation = 0, bulgeAxes = [.30, .15, .23],
  bulgeCenter, bulgeFraction = .44, bulgeContrast = .6, dustCloudFraction = 0, dustCloudVerticalScale = 1, dustOpticalDepth = 1.3, asymmetry = .45, populationContrast = .6, dustContrast = .6,
  palette = { old: [1, .76, .48], young: [.65, .8, 1], dust: [.72, 1, 1.45] },
}) {
  yield 'validate';
  if (typeof seed !== 'string') throw new TypeError('Galactic medium requires a string seed');
  if (!['spiral', 'barred', 'irregular'].includes(morphology)) throw new RangeError('Unknown galactic morphology');
  if (!Number.isInteger(resolution) || resolution < 32 || resolution > GALACTIC_MEDIUM_MAX_RESOLUTION) throw new RangeError('Galactic resolution must be 32–1024');
  bounded(totalLuminosity, 1e-9, 1e6, 'luminosity'); bounded(resolvedFraction, 0, 1, 'resolved fraction');
  bounded(stellarHeight, .001, .1, 'stellar height'); bounded(youngStellarHeight, .0001, stellarHeight, 'young stellar height'); bounded(dustHeight, .001, .1, 'dust height');
  bounded(stellarWarp, 0, .08, 'stellar warp'); bounded(stellarHeightVariation, 0, .8, 'stellar height variation');
  bounded(dustWarp, 0, .08, 'dust warp'); bounded(dustHeightVariation, 0, .8, 'dust height variation');
  bounded(dustCloudFraction, 0, 1, 'dust cloud fraction');
  bounded(dustCloudVerticalScale, .1, 2, 'dust cloud vertical scale');
  bounded(bulgeContrast, 0, 1, 'bulge contrast');
  bounded(bulgeFraction, 0, 1, 'bulge fraction'); bounded(dustOpticalDepth, 0, 100, 'dust optical depth');
  bounded(populationContrast, 0, 1, 'population contrast');
  bounded(dustContrast, 0, 1, 'dust contrast');
  bounded(asymmetry, 0, 1, 'asymmetry'); bounded(pitch, .12, .65, 'pitch');
  if (!Number.isInteger(arms) || arms < 1 || arms > 6) throw new RangeError('Galactic arms must be 1–6');
  const random = randomFromSeed(`${seed}:medium-v1`), salt = hashSeed(`${seed}:field-v1`);
  const phase = random() * Math.PI * 2, skew = random() * Math.PI * 2;
  const center = bulgeCenter === undefined ? [(random() - .5) * .1, 0, (random() - .5) * .08] : bulgeCenter;
  if (!vector(center) || !vector(bulgeAxes) || bulgeAxes.some(n => n <= 0)
    || Math.hypot(...center) + Math.max(...bulgeAxes) > 1) throw new RangeError('Bulge exceeds normalized finite support');
  const old = spectrum(palette.old), young = spectrum(palette.young);
  if (!vector(palette.dust) || palette.dust.some(n => n < 0)) throw new TypeError('Expected nonnegative dust extinction RGB');
  const extinctionColor = Object.freeze([...palette.dust]);
  yield 'disk-table-allocation';
  const texels = new Float32Array(resolution * resolution * 4);
  yield 'disk-geometry-allocation';
  const verticalGeometry = new Float32Array(resolution * resolution * 4);
  const step = 2 / resolution, pixelArea = step * step;
  for (let i = 0; i < verticalGeometry.length; i += 4) {
    if ((i & 4095) === 0) yield 'disk-geometry-init';
    verticalGeometry[i + 1] = verticalGeometry[i + 3] = 1;
  }
  let integratedOld = 0, integratedYoung = 0, maximumDustColumn = 0;
  const c = Math.cos(skew), s = Math.sin(skew);
  const populationFloor = (1 - populationContrast) ** 3, dustFloor = (1 - dustContrast) ** 2;
  for (let zIndex = 1; zIndex < resolution - 1; zIndex++) {
    yield 'disk-field';
    for (let xIndex = 1; xIndex < resolution - 1; xIndex++) {
    const x = (xIndex + .5) * step - 1, z = (zIndex + .5) * step - 1, radius = Math.hypot(x, z);
    if (radius >= .9) continue;
    const wx = x + (fbm(x * 3.2, z * 3.2, salt + 11) - .5) * .13;
    const wz = z + (fbm(x * 3.2 + 9, z * 3.2, salt + 23) - .5) * .13;
    const r = Math.hypot(wx, wz), angle = Math.atan2(wz, wx);
    const cloud = fbm(wx * 9, wz * 9, salt + 37), fine = fbm(wx * 31, wz * 31, salt + 51);
    const large = fbm(wx * 3 - 4, wz * 3 + 7, salt + 67);
    const winding = angle - Math.log(r + .07) / pitch - phase;
    const ridgePhase = winding * arms;
    const width = .27 + .3 * cloud;
    const ridge = Math.exp(-1 * (Math.sin(ridgePhase * .5) / width) ** 2);
    const branchPhase = ridgePhase + .9 + .9 * Math.sin(r * 13 + phase);
    const branch = Math.exp(-1 * (Math.sin(branchPhase * .5) / (width * .53)) ** 2)
      * smooth(.24, .43, r) * (1 - smooth(.64, .84, r));
    const gaps = smooth(.27, .56, fbm(wx * 6 + 37, wz * 6 - 19, salt + 81));
    const taper = 1 - smooth(.67, .9, radius);
    const lopsided = Math.exp(asymmetry * 1.4 * Math.cos(angle - skew) * smooth(.1, .6, r));
    const bar = Math.exp(-((wx * c + wz * s) ** 2 / .15 + (wz * c - wx * s) ** 2 / .008));
    // Broad complexes contain smaller clouds, which contain fine structure.
    // Multiplication makes real low-density regions at every scale, instead
    // of adding ever more light to a uniform floor. Contrast zero preserves
    // the earlier table formula; the arm and bifurcation geometry stays put.
    const hierarchy = smooth(.28, .7, large) * (.08 + .92 * smooth(.25, .7, cloud))
      * (.1 + .9 * smooth(.22, .76, fine));
    const populationWeight = populationFloor + (1 - populationFloor) * hierarchy;
    const structure = morphology === 'irregular' ? .15 * populationFloor + large * large * 2.8
      : .12 * populationFloor + gaps * (ridge * (.25 + 1.6 * cloud * cloud) + branch * .37) + (morphology === 'barred' ? bar * .7 : 0);
    const youngWeight = Math.min(.85, structure * smooth(.09, .32, r) * .65);
    const emission = taper * Math.exp(-r * 2.8) * lopsided * (.14 * populationFloor + structure)
      * (.32 * populationFloor + fine) * populationWeight;
    // Independent clouds, displaced main lanes and narrow bifurcations keep
    // extinction correlated with large form without tracing luminous tubes.
    const dustRidge = Math.exp(-1 * (Math.sin((ridgePhase + .65 + (large - .5) * 1.6) * .5) / (.42 + cloud * .45)) ** 2);
    const dustBranch = Math.exp(-1 * (Math.sin((branchPhase - .5) * .5) / .18) ** 2);
    const dustCloud = smooth(.26, .64, fbm(wx * 12 - 7, wz * 12 + 13, salt + 103));
    // Dust complexes share the macro form but retain their independently
    // displaced cloud field. Gaps interrupt lanes rather than tinting a whole
    // continuous ridge brown; no extra noise evaluation or table is needed.
    const dustHierarchy = smooth(.2, .65, large) * smooth(.2, .72, dustCloud) * (.15 + .85 * gaps);
    const dustWeight = dustFloor + (1 - dustFloor) * dustHierarchy;
    const dust = taper * dustOpticalDepth * Math.exp(-r * 1.3) * lopsided
      * (morphology === 'irregular' ? .2 * dustFloor + large : .17 * dustFloor + dustRidge + dustBranch * .42)
      * dustCloud * (.25 + fine * 1.7) * smooth(.05, .22, r) * dustWeight;
    const index = (zIndex * resolution + xIndex) * 4;
    // Correlated multiscale cloud geometry, not a screen mask or a single wave.
    // Tapering the deformation as well as the column keeps the outer disk flat.
    const offsetShape = Math.max(-1, Math.min(1, (large - .5) * 3.4 + (cloud - .5) * 1.2 + (fine - .5) * .4));
    const heightShape = Math.max(-1, Math.min(1, (cloud - .5) * 3 + (fine - .5) * 1.1 - (large - .5) * .6));
    verticalGeometry[index] = dustWarp === 0 ? 0 : dustWarp * taper * offsetShape;
    verticalGeometry[index + 1] = 1 + dustHeightVariation * taper * heightShape;
    // The stellar layer follows the same multiscale clouds with a distinct
    // balance: cloud-scale bends and fine-scale thickness need not trace dust.
    const stellarOffsetShape = Math.max(-1, Math.min(1, (large - .5) * 2.2 - (cloud - .5) * 2.4 + (fine - .5) * .8));
    const stellarHeightShape = Math.max(-1, Math.min(1, (cloud - .5) * 1.8 + (fine - .5) * 2.8 + (large - .5) * .5));
    verticalGeometry[index + 2] = stellarWarp === 0 ? 0 : stellarWarp * taper * stellarOffsetShape;
    verticalGeometry[index + 3] = 1 + stellarHeightVariation * taper * stellarHeightShape;
    // Revision 2 stores two scalar luminosity columns, not RGB.
    texels[index] = emission * (1 - youngWeight);
    texels[index + 1] = emission * youngWeight;
    texels[index + 3] = dust;
    maximumDustColumn = Math.max(maximumDustColumn, texels[index + 3]);
    integratedOld += texels[index] * pixelArea; integratedYoung += texels[index + 1] * pixelArea;
  }
  }
  const integrated = integratedOld + integratedYoung;
  if (!Number.isFinite(integrated) || integrated <= 0) throw new RangeError('Population contrast leaves no finite disk luminosity');
  const diskLuminosity = totalLuminosity * (1 - bulgeFraction), bulgeLuminosity = totalLuminosity * bulgeFraction;
  const oldDiskLuminosity = diskLuminosity * integratedOld / integrated, youngDiskLuminosity = diskLuminosity - oldDiskLuminosity;
  const filteredOld = yield* filterOldStellarColumn(texels, resolution, stellarHeight);
  if (!Number.isFinite(filteredOld) || filteredOld <= 0) throw new RangeError('Old stellar filter leaves no finite disk luminosity');
  const oldScale = oldDiskLuminosity / filteredOld, youngScale = integratedYoung > 0 ? youngDiskLuminosity / integratedYoung : 0;
  yield 'disk-cdf-allocation';
  const cdf = new Float64Array(resolution * resolution);
  let tableLuminosity = 0, oldTableLuminosity = 0, youngTableLuminosity = 0, dustIntegral = 0;
  for (let cell = 0; cell < cdf.length; cell++) {
    if ((cell & 1023) === 0) yield 'disk-cdf';
    const index = cell * 4;
    texels[index] *= oldScale; texels[index + 1] *= youngScale;
    oldTableLuminosity += texels[index] * pixelArea; youngTableLuminosity += texels[index + 1] * pixelArea;
    tableLuminosity += (texels[index] + texels[index + 1]) * pixelArea;
    cdf[cell] = tableLuminosity;
    dustIntegral += texels[index + 3] * pixelArea;
    texels[index + 3] *= 1 - dustCloudFraction;
  }
  const bulge = yield* createBulgePopulation(seed, bulgeAxes, center, bulgeLuminosity, bulgeContrast);
  const dustGeometry = yield* createDustSheets(seed, phase, pitch, arms);
  const dustCloud = yield* bakeDustSheets(dustGeometry, dustIntegral * dustCloudFraction, seed, dustCloudVerticalScale);
  const maximumDustDensity = maximumDustColumn * (1 - dustCloudFraction) * 15 / (16 * dustHeight * (1 - dustHeightVariation)) + dustCloud.maximumDensity;
  if (!Number.isFinite(maximumDustDensity * Math.max(...extinctionColor))) throw new RangeError('Dust spectrum cannot represent finite extinction');
  let dustVerticalBound = dustHeight, stellarVerticalBound = stellarHeight;
  for (let i = 0; i < verticalGeometry.length; i += 4) {
    if ((i & 4095) === 0) yield 'vertical-bounds';
    dustVerticalBound = Math.max(dustVerticalBound, Math.abs(verticalGeometry[i]) + dustHeight * verticalGeometry[i + 1]);
    stellarVerticalBound = Math.max(stellarVerticalBound, Math.abs(verticalGeometry[i + 2]) + stellarHeight * verticalGeometry[i + 3]);
  }
  if (dustCloud.integral > 0) dustVerticalBound = Math.max(dustVerticalBound, Math.abs(dustCloud.center[1]) + dustCloud.axes[1]);
  let supportRadius = Math.max(Math.hypot(.9 + Math.SQRT2 * step, stellarHeight), bulge.supportRadius, dustCloud.supportRadius);
  // Each profile's interpolated offset/scale is a convex combination. Bound
  // every active cell using its four geometry corners and planar rectangle;
  // dust-free cells can still emit, so stellar columns and A have separate support tests.
  for (let row = 0; row < resolution - 1; row++) {
    yield 'support-bounds';
    for (let column = 0; column < resolution - 1; column++) {
    let dustActive = false, stellarActive = false, dustBound = 0, stellarBound = 0;
    for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
      const index = ((row + dz) * resolution + column + dx) * 4;
      dustActive = dustActive || texels[index + 3] > 0;
      stellarActive = stellarActive || texels[index] + texels[index + 1] > 0;
      dustBound = Math.max(dustBound, Math.abs(verticalGeometry[index]) + dustHeight * verticalGeometry[index + 1]);
      stellarBound = Math.max(stellarBound, Math.abs(verticalGeometry[index + 2]) + stellarHeight * verticalGeometry[index + 3]);
    }
    if (!dustActive && !stellarActive) continue;
    const heightBound = Math.max(dustActive ? dustBound : 0, stellarActive ? stellarBound : 0);
    const x0 = (column + .5) * step - 1, x1 = x0 + step, z0 = (row + .5) * step - 1, z1 = z0 + step;
    supportRadius = Math.max(supportRadius, Math.sqrt(Math.max(x0 * x0, x1 * x1) + Math.max(z0 * z0, z1 * z1) + heightBound * heightBound));
  }
  }
  yield 'publish';
  if (supportRadius > 1) throw new RangeError('Galactic vertical geometry exceeds normalized finite support');
  const medium = Object.freeze({ revision: GALACTIC_MEDIUM_REVISION, seed, morphology, populationContrast, dustContrast, resolution, texels, verticalGeometry, pixelArea,
    totalLuminosity, diskLuminosity, tableLuminosity, oldDiskLuminosity, youngDiskLuminosity, oldTableLuminosity, youngTableLuminosity, oldStellarColor: old, youngStellarColor: young, bulgeLuminosity, resolvedFraction, stellarHeight, youngStellarHeight, dustHeight, dustWarp, dustHeightVariation, dustVerticalBound, stellarWarp, stellarHeightVariation, stellarVerticalBound,
    bulgeCenter: Object.freeze([...center]), bulgeAxes: Object.freeze([...bulgeAxes]), bulgeColor: old, bulgeContrast,
    stellarVolumeResolution: GALACTIC_MEDIUM_STELLAR_VOLUME_RESOLUTION, stellarVolumeTexels: bulge.texels,
    dustVolumeResolution: GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION, dustVolumeTexels: dustCloud.texels, bulgePixelVolume: bulge.pixelVolume, bulgeTableLuminosity: bulge.tableLuminosity,
    dustCloudFraction, dustCloudVerticalScale, dustIntegral, dustCloudIntegral: dustCloud.integral, dustCloudPixelVolume: dustCloud.pixelVolume,
    dustCloudCenter: Object.freeze(dustCloud.center), dustCloudAxes: Object.freeze(dustCloud.axes),
    dustCloudSynthesis: Object.freeze(dustCloud.synthesis),
    dustSheetRailLength: dustGeometry.railLength, dustSheetSurfaceArea: dustGeometry.surfaceArea, dustSheetTriangleCount: dustGeometry.faces.length,
    extinctionColor, supportRadius });
  fields.set(medium, {diskCdf: cdf, bulgeCdf: bulge.cdf});
  return medium;
}

/** Resumable creation. advance runs synchronously until a checkpoint reaches
 * its positive wall-time budget; the host chooses real task/event-loop yields.
 * Only complete publishes a result and installs its private sampling CDFs.
 * step() advances one checkpoint; advance() returns true at a terminal state.
 * Invalid input throws from the advancing call and is retained in error; failed
 * and cancelled tasks never publish result. cancel() closes nested generators,
 * dropping all partial tables; completed results are retained by their owner.
 * Native allocation, one row and small validation/publication blocks are atomic;
 * the budget is a target, not a scheduler or GC pause guarantee.
 */
export function createGalacticMediumTask(options) {
  // Snapshot the small external descriptor once. No mutable caller array is
  // retained across asynchronous host yields.
  const vectorCopy = value => Array.isArray(value) ? value.slice() : value;
  const descriptor = {...options};
  for (const name of ['bulgeCenter', 'bulgeAxes']) if (name in descriptor) descriptor[name] = vectorCopy(descriptor[name]);
  if (descriptor.palette && typeof descriptor.palette === 'object') descriptor.palette = {old: vectorCopy(descriptor.palette.old), young: vectorCopy(descriptor.palette.young), dust: vectorCopy(descriptor.palette.dust)};
  let iterator = generateGalacticMedium(descriptor), state = 'pending', result, error, stage = 'validate';
  const metrics = {chunks: 0, workMs: 0, maximumChunkMs: 0, maximumChunkStage: null, stages: Object.create(null)};
  function step() {
    if (state !== 'pending') return true;
    const start = performance.now(), previousStage = stage;
    try {
      const next = iterator.next();
      const elapsed = performance.now() - start;
      metrics.chunks++; metrics.workMs += elapsed;
      const entry = metrics.stages[previousStage] ?? (metrics.stages[previousStage] = {chunks: 0, workMs: 0, maximumChunkMs: 0});
      entry.chunks++; entry.workMs += elapsed; entry.maximumChunkMs = Math.max(entry.maximumChunkMs, elapsed);
      if (elapsed > metrics.maximumChunkMs) { metrics.maximumChunkMs = elapsed; metrics.maximumChunkStage = previousStage; }
      if (next.done) { result = next.value; state = 'complete'; stage = 'complete'; iterator = null; }
      else stage = next.value;
      return state !== 'pending';
    } catch (cause) { state = 'failed'; stage = 'failed'; error = cause; iterator = null; throw cause; }
  }
  return Object.freeze({
    advance(budgetMs = 2) {
      if (!(budgetMs > 0) || (!Number.isFinite(budgetMs) && budgetMs !== Infinity)) throw new RangeError('Medium task budget must be positive milliseconds or Infinity');
      const start = performance.now();
      do { if (step()) return true; } while (performance.now() - start < budgetMs);
      return false;
    },
    step,
    cancel() {
      if (state !== 'pending') return false;
      try { iterator.return(); } finally { iterator = null; result = undefined; state = 'cancelled'; stage = 'cancelled'; }
      return true;
    },
    get state() { return state; }, get result() { return state === 'complete' ? result : undefined; },
    get error() { return error; }, get stage() { return stage; }, get metrics() { return metrics; },
  });
}

/** The synchronous API drains exactly the same task implementation. */
export function createGalacticMedium(options) {
  const task = createGalacticMediumTask(options);
  task.advance(Infinity);
  return task.result;
}

/** Caller owns output.emission and output.extinction (three writable numbers
 * each). This hot-path sampler does not allocate, validate, or mutate medium.
 */
export function sampleGalacticMedium(medium, position, output) {
  if (medium.revision === GALACTIC_SPATIAL_MEDIUM_REVISION) return sampleSpatialGalacticMedium(medium, position, output);
  const x = position[0], y = position[1], z = position[2], n = medium.resolution;
  const emission = output.emission, extinction = output.extinction;
  emission[0] = emission[1] = emission[2] = extinction[0] = extinction[1] = extinction[2] = 0;
  if (x > -1 && x < 1 && z > -1 && z < 1 && (Math.abs(y) < medium.stellarVerticalBound || Math.abs(y) < medium.dustVerticalBound)) {
    const u = (x + 1) * n * .5 - .5, v = (z + 1) * n * .5 - .5;
    const ix = Math.floor(u), iz = Math.floor(v), fx = u - ix, fz = v - iz;
    let oldColumn = 0, youngColumn = 0, dustColumn = 0, dustOffset = 0, dustScale = 1, stellarOffset = 0, stellarScale = 1;
    for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
      const column = Math.max(0, Math.min(n - 1, ix + dx)), row = Math.max(0, Math.min(n - 1, iz + dz));
      const index = (row * n + column) * 4, weight = (dx ? fx : 1 - fx) * (dz ? fz : 1 - fz);
      oldColumn += medium.texels[index] * weight; youngColumn += medium.texels[index + 1] * weight;
      dustColumn += medium.texels[index + 3] * weight;
      dustOffset += medium.verticalGeometry[index] * weight;
      dustScale += (medium.verticalGeometry[index + 1] - 1) * weight;
      stellarOffset += medium.verticalGeometry[index + 2] * weight;
      stellarScale += (medium.verticalGeometry[index + 3] - 1) * weight;
    }
    const dustVertical = compact(y - dustOffset, medium.dustHeight * dustScale);
    const oldVertical = compact(y - stellarOffset, medium.stellarHeight * stellarScale);
    const youngVertical = compact(y - stellarOffset, medium.youngStellarHeight * stellarScale);
    for (let axis = 0; axis < 3; axis++) {
      emission[axis] = oldColumn * oldVertical * medium.oldStellarColor[axis] + youngColumn * youngVertical * medium.youngStellarColor[axis];
      extinction[axis] = dustColumn * dustVertical * medium.extinctionColor[axis];
    }
  }
  const bulgeDensity = volumeDensity(medium.stellarVolumeTexels, medium.stellarVolumeResolution, x, y, z, medium.bulgeCenter, medium.bulgeAxes);
  const dustCloudDensity = medium.dustCloudIntegral > 0 ? volumeDensity(medium.dustVolumeTexels, medium.dustVolumeResolution, x, y, z, medium.dustCloudCenter, medium.dustCloudAxes) : 0;
  for (let axis = 0; axis < 3; axis++) {
    emission[axis] += bulgeDensity * medium.bulgeColor[axis];
    extinction[axis] += dustCloudDensity * medium.extinctionColor[axis];
  }
  return output;
}

function verticalQuantile(probability) {
  let lower = -1, upper = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lower + upper) * .5, t2 = t * t;
    if (.5 + 15 / 16 * t * (1 + t2 * (-2 / 3 + t2 / 5)) < probability) lower = t;
    else upper = t;
  }
  return (lower + upper) * .5;
}
/** True 3D proxies sampled from the same luminosity measure. Each count is an
 * exact prefix for a fixed medium/seed. Colors have linear Y=1; raw powers have
 * a bounded bright tail, independent of position. The renderer normalizes the
 * active prefix to resolvedFraction*totalLuminosity and multiplies the field
 * by 1-resolvedFraction, so quality never creates additional luminosity.
 * componentIndices are 0 mature, 1 young and 2 core; revision 2 intentionally
 * owns a new random namespace. The old cosmic catalogue is not sampled here.
 */
export function sampleGalacticStars(medium, seed, count) {
  if (typeof seed !== 'string') throw new TypeError('Galactic stars require a string seed');
  if (!Number.isInteger(count) || count < 0 || count > GALACTIC_MEDIUM_MAX_STARS) throw new RangeError('Galactic star count must be 0–16384');
  if (medium.revision === GALACTIC_SPATIAL_MEDIUM_REVISION) return sampleSpatialGalacticStars(medium, seed, count);
  const random = randomFromSeed(`${seed}:galactic-stars-v2`), {diskCdf: cdf, bulgeCdf} = fields.get(medium), n = medium.resolution;
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3);
  const rawLuminosities = new Float32Array(count), componentIndices = new Uint8Array(count);
  for (let star = 0; star < count; star++) {
    const index = star * 3;
    if (random() * medium.totalLuminosity < medium.diskLuminosity) {
      const target = random() * medium.tableLuminosity;
      let lower = 0, upper = cdf.length - 1;
      while (lower < upper) { const middle = (lower + upper) >>> 1; if (cdf[middle] <= target) lower = middle + 1; else upper = middle; }
      const cell = lower;
      // A mixture of bilinear hat bases exactly matches LINEAR texture density.
      positions[index] = ((cell % n) + .5 + random() - random()) * 2 / n - 1;
      positions[index + 2] = (Math.floor(cell / n) + .5 + random() - random()) * 2 / n - 1;
      // The common conditional profile belongs to the FINAL tent-sampled
      // position, not to the selected texel. Sampling the latter would instead
      // produce a mixture of profiles, a different three-dimensional measure.
      const u = (positions[index] + 1) * n * .5 - .5, v = (positions[index + 2] + 1) * n * .5 - .5;
      const ix = Math.floor(u), iz = Math.floor(v), fx = u - ix, fz = v - iz;
      let oldColumn = 0, youngColumn = 0, stellarOffset = 0, stellarScale = 1;
      for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        const column = Math.max(0, Math.min(n - 1, ix + dx)), row = Math.max(0, Math.min(n - 1, iz + dz));
        const geometryIndex = (row * n + column) * 4, weight = (dx ? fx : 1 - fx) * (dz ? fz : 1 - fz);
        oldColumn += medium.texels[geometryIndex] * weight; youngColumn += medium.texels[geometryIndex + 1] * weight;
        stellarOffset += medium.verticalGeometry[geometryIndex + 2] * weight;
        stellarScale += (medium.verticalGeometry[geometryIndex + 3] - 1) * weight;
      }
      // Posterior component choice at the final Float32 X/Z position.
      // Together with the combined-column CDF this is the same joint measure
      // as the two profiles used by sampleGalacticMedium.
      const isYoung = random() * (oldColumn + youngColumn) >= oldColumn;
      componentIndices[star] = isYoung ? 1 : 0;
      const height = isYoung ? medium.youngStellarHeight : medium.stellarHeight;
      positions[index + 1] = stellarOffset + verticalQuantile(random()) * height * stellarScale;
      const color = isYoung ? medium.youngStellarColor : medium.oldStellarColor;
      for (let axis = 0; axis < 3; axis++) colors[index + axis] = color[axis];
    } else {
      componentIndices[star] = 2;
      const target = random() * medium.bulgeTableLuminosity;
      let lower = 0, upper = bulgeCdf.length - 1;
      while (lower < upper) { const middle = (lower + upper) >>> 1; if (bulgeCdf[middle] <= target) lower = middle + 1; else upper = middle; }
      const size = medium.stellarVolumeResolution, cell = lower;
      positions[index] = medium.bulgeCenter[0] + ((cell % size + .5 + random() - random()) * 2 / size - 1) * medium.bulgeAxes[0];
      positions[index + 1] = medium.bulgeCenter[1] + ((Math.floor(cell / size) % size + .5 + random() - random()) * 2 / size - 1) * medium.bulgeAxes[1];
      positions[index + 2] = medium.bulgeCenter[2] + ((Math.floor(cell / (size * size)) + .5 + random() - random()) * 2 / size - 1) * medium.bulgeAxes[2];
      for (let axis = 0; axis < 3; axis++) colors[index + axis] = medium.bulgeColor[axis];
    }
    rawLuminosities[star] = .2 + .8 * (1 - random() + 1 / 65536) ** -.65;
  }
  return { positions, colors, rawLuminosities, componentIndices };
}
