import {hashSeed, randomFromSeed} from './random.js';

export const GALACTIC_SPATIAL_MEDIUM_REVISION = 3;
export const GALACTIC_SPATIAL_SOURCE_BRICK_RESOLUTION = 32;
export const GALACTIC_SPATIAL_SOURCE_RESOLUTION = 64;
export const GALACTIC_SPATIAL_DUST_RESOLUTION = 128;
const SOURCE_RESOLUTION = GALACTIC_SPATIAL_SOURCE_RESOLUTION, DUST_RESOLUTION = GALACTIC_SPATIAL_DUST_RESOLUTION;
const MAX_SOURCE_KERNELS = 32, MAX_DUST_KERNELS = 24;
const Y = [.2126, .7152, .0722];
const PROFILE_INTEGRAL = 32 * Math.PI / 105;
const fields = new WeakMap();
const smooth = (a, b, value) => {const t = Math.max(0, Math.min(1, (value - a) / (b - a))); return t * t * (3 - 2 * t);};

function vector(value, name, positive = false) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => !Number.isFinite(n) || (positive && n <= 0)))
    throw new TypeError(`Expected three ${positive ? 'positive ' : ''}finite numbers for ${name}`);
  return Object.freeze([...value]);
}
function nonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  return value;
}
function color(value, name, normalize) {
  const rgb = vector(value, name);
  if (rgb.some(n => n < 0)) throw new RangeError(`${name} must be nonnegative`);
  const power = rgb[0] * Y[0] + rgb[1] * Y[1] + rgb[2] * Y[2];
  if (normalize && !(power > 0 && Number.isFinite(power))) throw new RangeError(`${name} must have positive finite luminance`);
  return normalize ? Object.freeze(rgb.map(n => n / power)) : rgb;
}
function frame(center, axes, resolution, name) {
  center = vector(center, `${name} center`); axes = vector(axes, `${name} axes`, true);
  const pixelVolume = (2 / resolution) ** 3 * axes[0] * axes[1] * axes[2];
  if (!(Number.isFinite(pixelVolume) && pixelVolume > 0)
    || axes.some((a, i) => !Number.isFinite(1 / a) || !Number.isFinite(Math.fround(Math.abs(center[i]) + a))))
    throw new RangeError(`${name} frame cannot represent finite voxel positions and volume`);
  return {center, axes, resolution, pixelVolume};
}
function compileKernel(kernel, bounds, index, dust, seed) {
  if (!kernel || typeof kernel !== 'object') throw new TypeError('Expected an ellipsoid kernel');
  const {weight} = kernel;
  if (!(Number.isFinite(weight) && weight > 0)) throw new RangeError('Kernel weight must be positive and finite');
  const center = vector(kernel.center, 'kernel center'), axes = vector(kernel.axes, 'kernel axes', true);
  const rotation = vector(kernel.rotation, 'kernel rotation');
  const cx = Math.cos(rotation[0]), sx = Math.sin(rotation[0]), cy = Math.cos(rotation[1]), sy = Math.sin(rotation[1]), cz = Math.cos(rotation[2]), sz = Math.sin(rotation[2]);
  // Euler XYZ, row-major local-to-body rotation. No rendering dependency.
  const r = [cy * cz, -cy * sz, sy,
    cx * sz + sx * cz * sy, cx * cz - sx * sz * sy, -sx * cy,
    sx * sz - cx * cz * sy, sx * cz + cx * sz * sy, cx * cy];
  const inverse = [r[0] / axes[0], r[3] / axes[0], r[6] / axes[0],
    r[1] / axes[1], r[4] / axes[1], r[7] / axes[1], r[2] / axes[2], r[5] / axes[2], r[8] / axes[2]];
  const lower = [], upper = [];
  for (let i = 0; i < 3; i++) {
    const extent = Math.hypot(r[i * 3] * axes[0], r[i * 3 + 1] * axes[1], r[i * 3 + 2] * axes[2]);
    const step = 2 * bounds.axes[i] / bounds.resolution;
    const tolerance = 16 * Number.EPSILON * (Math.abs(center[i]) + Math.abs(bounds.center[i]) + bounds.axes[i]);
    if (center[i] - extent < bounds.center[i] - bounds.axes[i] + step - tolerance
      || center[i] + extent > bounds.center[i] + bounds.axes[i] - step + tolerance)
      throw new RangeError('Kernel support requires one full voxel of frame-edge padding');
    lower[i] = Math.max(1, Math.floor((center[i] - extent - bounds.center[i] + bounds.axes[i]) / step));
    upper[i] = Math.min(bounds.resolution - 2, Math.floor((center[i] + extent - bounds.center[i] + bounds.axes[i]) / step));
  }
  const volume = PROFILE_INTEGRAL * axes[0] * axes[1] * axes[2];
  if (!(Number.isFinite(volume) && volume > 0) || inverse.some(n => !Number.isFinite(n)))
    throw new RangeError('Kernel axes cannot represent a finite compact profile');
  let component = 0, contrast = 0;
  if (dust) {
    contrast = kernel.contrast;
    if (!(Number.isFinite(contrast) && contrast >= 0 && contrast <= 1)) throw new RangeError('Dust contrast must be within 0–1');
  } else {
    component = kernel.component;
    if (!Number.isInteger(component) || component < 0 || component > 2) throw new RangeError('Source component must be 0, 1 or 2');
  }
  return {center, axes, rotation: r, inverse, lower, upper, component, contrast, weight, volume,
    salt: dust ? hashSeed(`${seed}:galactic-spatial-dust-v3:${index}`) : 0};
}
function compileOptions(options) {
  if (!options || typeof options !== 'object' || typeof options.seed !== 'string') throw new TypeError('Spatial medium requires a string seed');
  const source = frame(options.sourceCenter, options.sourceAxes, SOURCE_RESOLUTION, 'source');
  const dust = frame(options.dustCenter, options.dustAxes, DUST_RESOLUTION, 'dust');
  const luminosities = vector(options.luminosities, 'component luminosities');
  luminosities.forEach(n => nonnegative(n, 'Component luminosity'));
  const totalLuminosity = luminosities[0] + luminosities[1] + luminosities[2];
  if (!(Number.isFinite(totalLuminosity) && totalLuminosity > 0)) throw new RangeError('Total luminosity must be positive and finite');
  if (!Array.isArray(options.colors) || options.colors.length !== 3) throw new TypeError('Expected three source colors');
  const colors = Object.freeze(options.colors.map((c, i) => color(c, `source color ${i}`, true)));
  const extinctionColor = color(options.extinctionColor, 'extinction color', false);
  const dustIntegral = nonnegative(options.dustIntegral, 'Dust integral'), resolvedFraction = options.resolvedFraction;
  if (!(Number.isFinite(resolvedFraction) && resolvedFraction >= 0 && resolvedFraction <= 1)) throw new RangeError('Resolved fraction must be within 0–1');
  if (!Array.isArray(options.sourceKernels) || options.sourceKernels.length > MAX_SOURCE_KERNELS
    || !Array.isArray(options.dustKernels) || options.dustKernels.length > MAX_DUST_KERNELS)
    throw new RangeError('Spatial medium supports at most 32 source and 24 dust kernels');
  const sources = options.sourceKernels.map((k, i) => compileKernel(k, source, i, false, options.seed));
  const dusts = options.dustKernels.map((k, i) => compileKernel(k, dust, i, true, options.seed));
  const weights = [0, 0, 0]; let dustWeight = 0;
  for (const k of sources) weights[k.component] += k.weight;
  for (let p = 0; p < 3; p++) if ((luminosities[p] > 0 && weights[p] === 0) || !Number.isFinite(weights[p]))
    throw new RangeError('Each luminous component requires finite positive kernel weight');
  for (const k of dusts) dustWeight += k.weight;
  if ((dustIntegral > 0 && dustWeight === 0) || !Number.isFinite(dustWeight)) throw new RangeError('Positive dust requires finite positive kernel weight');
  for (const k of sources) k.amplitude = k.weight / weights[k.component] / k.volume;
  for (const k of dusts) k.amplitude = k.weight / dustWeight / k.volume;
  let sourceBrick = null;
  if (options.sourceBrick !== undefined && options.sourceBrick !== null) {
    const b = options.sourceBrick;
    if (typeof b !== 'object' || Array.isArray(b) || !Number.isInteger(b.kernelIndex) || b.kernelIndex < 0 || b.kernelIndex >= sources.length)
      throw new RangeError('Source brick requires one existing source kernel index');
    if (b.profile !== 'coherent-ribbon-v1') throw new RangeError('Unknown source brick profile');
    const macroSpan = vector(b.macroSpan, 'brick macro span', true), fineSpan = vector(b.fineSpan, 'brick fine span', true);
    if (macroSpan.some(v => !Number.isFinite(1 / v)) || fineSpan.some(v => !Number.isFinite(1 / v))) throw new RangeError('Source brick noise spans cannot represent finite coordinates');
    const kernel = sources[b.kernelIndex], n = GALACTIC_SPATIAL_SOURCE_BRICK_RESOLUTION;
    const axes = Object.freeze(kernel.axes.map(a => a * n / (n - 2))), rotation = Object.freeze([...kernel.rotation]);
    const inverse = Object.freeze(kernel.inverse.map(v => v * (n - 2) / n));
    const pixelVolume = (2 / n) ** 3 * axes[0] * axes[1] * axes[2];
    if (!(Number.isFinite(pixelVolume) && pixelVolume > 0)) throw new RangeError('Source brick cannot represent a finite voxel volume');
    sourceBrick = {kernelIndex: b.kernelIndex, profile: b.profile, kernel, center: kernel.center, axes, rotation, inverse,
      resolution: n, pixelVolume, macroSpan, fineSpan, salt: hashSeed(`${options.seed}:galactic-spatial-source-brick-v1:${b.kernelIndex}`)};
  }
  return {seed: options.seed, source, dust, luminosities, totalLuminosity, colors, extinctionColor, dustIntegral, resolvedFraction, sources, dusts, sourceBrick};
}
// Project-owned 12-gradient noise; convex interpolation gives |noise| <= 1.
function gradient(x, y, z, dx, dy, dz, seed) {
  let n = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x6c8e9cf5) ^ Math.imul(z, 0x5f356495) ^ seed;
  n = Math.imul(n ^ n >>> 16, 0x45d9f3b); n = (n ^ n >>> 16) >>> 0;
  const zero = n % 3, a = zero === 0 ? dy : dx, b = zero === 2 ? dy : dz;
  return ((n & 4 ? -a : a) + (n & 8 ? -b : b)) * Math.SQRT1_2;
}
function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), u = x - ix, v = y - iy, w = z - iz;
  const fx = u * u * u * (u * (u * 6 - 15) + 10), fy = v * v * v * (v * (v * 6 - 15) + 10), fz = w * w * w * (w * (w * 6 - 15) + 10);
  const a = gradient(ix, iy, iz, u, v, w, seed), b = gradient(ix + 1, iy, iz, u - 1, v, w, seed);
  const c = gradient(ix, iy + 1, iz, u, v - 1, w, seed), d = gradient(ix + 1, iy + 1, iz, u - 1, v - 1, w, seed);
  const e = gradient(ix, iy, iz + 1, u, v, w - 1, seed), f = gradient(ix + 1, iy, iz + 1, u - 1, v, w - 1, seed);
  const g = gradient(ix, iy + 1, iz + 1, u, v - 1, w - 1, seed), h = gradient(ix + 1, iy + 1, iz + 1, u - 1, v - 1, w - 1, seed);
  const lower = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  const upper = (e + (f - e) * fx) * (1 - fy) + (g + (h - g) * fx) * fy;
  return (lower + (upper - lower) * fz) * Math.SQRT1_2;
}
function profile(kernel, x, y, z, dust) {
  const dx = x - kernel.center[0], dy = y - kernel.center[1], dz = z - kernel.center[2], a = kernel.inverse;
  const qx = a[0] * dx + a[1] * dy + a[2] * dz, qy = a[3] * dx + a[4] * dy + a[5] * dz, qz = a[6] * dx + a[7] * dy + a[8] * dz;
  let r2 = qx * qx + qy * qy + qz * qz;
  if (r2 >= 1) return 0;
  let modulation = 1;
  if (dust && kernel.contrast > 0) {
    const contrast = kernel.contrast, salt = kernel.salt;
    const largeNoise = noise3((.8 * qx + .6 * qz) * 2.7 + 3.7, qy * 2.7 - 6.1, (-.6 * qx + .8 * qz) * 2.7 + 1.9, salt);
    const edge = 1 - .2 * contrast * smooth(.25, .75, .5 + 1.8 * largeNoise);
    r2 /= edge * edge;
    if (r2 >= 1) return 0;
    const large = smooth(.15, .85, .5 + 1.8 * largeNoise);
    const middle = smooth(.15, .85, .5 + 1.8 * noise3(qx * 6.1 - 4.3, (.6 * qy + .8 * qz) * 6.1 + 2.2, (-.8 * qy + .6 * qz) * 6.1 - 9.4, salt + 37));
    const fine = smooth(.15, .85, .5 + 1.8 * noise3((qx - qy) * Math.SQRT1_2 * 12.5 + 8.2, (qx + qy) * Math.SQRT1_2 * 12.5 - 7.6, qz * 12.5 + 5.8, salt + 71));
    const floor = (1 - contrast) ** 3;
    modulation = floor + (1 - floor) * large * (.1 + .9 * middle) * (.15 + .85 * fine);
  }
  return kernel.amplitude * (1 - r2) ** 2 * modulation;
}
function kernelCellAverage(kernel, bounds, x, y, z, dust) {
  const step = 2 / bounds.resolution;
  let value = 0;
  for (let sz = 0; sz < 2; sz++) for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++)
    value += profile(kernel, bounds.center[0] + ((x + (sx + .5) / 2) * step - 1) * bounds.axes[0],
      bounds.center[1] + ((y + (sy + .5) / 2) * step - 1) * bounds.axes[1],
      bounds.center[2] + ((z + (sz + .5) / 2) * step - 1) * bounds.axes[2], dust) / 8;
  return value;
}
function* bakeKernels(kernels, bounds, table, dust, luminosities) {
  const n = bounds.resolution;
  for (const kernel of kernels) {
    if (!dust && luminosities[kernel.component] === 0) continue;
    let kernelIntegral = 0;
    for (let z = kernel.lower[2]; z <= kernel.upper[2]; z++) for (let y = kernel.lower[1]; y <= kernel.upper[1]; y++) {
      yield dust ? 'dust-density-row' : 'source-density-row';
      for (let x = kernel.lower[0]; x <= kernel.upper[0]; x++) {
        const value = kernelCellAverage(kernel, bounds, x, y, z, dust);
        kernelIntegral += value * bounds.pixelVolume;
        const cell = (z * n + y) * n + x;
        if (dust) table[cell] += value;
        else table[cell * 4 + kernel.component] += value;
      }
    }
    if (!(kernelIntegral > 0 && Number.isFinite(kernelIntegral)))
      throw new RangeError(`${dust ? 'Dust' : 'Source'} kernel is unresolved on the fixed spatial grid`);
  }
}
function hatRadius(bounds, x, y, z) {
  const n = bounds.resolution, c = bounds.center, a = bounds.axes;
  const px = c[0] + ((x + .5) * 2 / n - 1) * a[0], py = c[1] + ((y + .5) * 2 / n - 1) * a[1], pz = c[2] + ((z + .5) * 2 / n - 1) * a[2];
  return Math.hypot(Math.abs(px) + 2 * a[0] / n, Math.abs(py) + 2 * a[1] / n, Math.abs(pz) + 2 * a[2] / n);
}
// Measure the removed kernel on the original coarse grid, without allocating
// an old full source field. This is its isolated Float32 coarse contribution.
function* coarseKernelIntegral(kernel, bounds) {
  let integral = 0;
  for (let z = kernel.lower[2]; z <= kernel.upper[2]; z++) for (let y = kernel.lower[1]; y <= kernel.upper[1]; y++) {
    yield 'source-brick-coarse-share-row';
    for (let x = kernel.lower[0]; x <= kernel.upper[0]; x++) integral += Math.fround(kernelCellAverage(kernel, bounds, x, y, z, false)) * bounds.pixelVolume;
  }
  if (!(integral > 0 && Number.isFinite(integral))) throw new RangeError('Selected source kernel is unresolved on the original coarse grid');
  return integral;
}
function ribbonDensity(b, x, y, z) {
  const a = b.kernel.inverse, dx = x - b.center[0], dy = y - b.center[1], dz = z - b.center[2];
  const u = a[0] * dx + a[1] * dy + a[2] * dz, v = a[3] * dx + a[4] * dy + a[5] * dz, w = a[6] * dx + a[7] * dy + a[8] * dz;
  const r2 = u * u + v * v + w * w;
  if (r2 >= 1) return 0;
  const by = .16 * Math.sin(1.4 * Math.PI * u + .6) * (1 - u * u), bz = .28 * Math.sin(Math.PI * u);
  const cross = ((v - by) / .62) ** 2 + ((w - bz) / .55) ** 2;
  const macro = noise3(x / b.macroSpan[0] + 3.1, y / b.macroSpan[1] - 4.7, z / b.macroSpan[2] + 7.3, b.salt);
  const fine = noise3((.8 * x + .6 * z) / b.fineSpan[0] - 2.3, y / b.fineSpan[1] + 6.1, (-.6 * x + .8 * z) / b.fineSpan[2] - 5.9, b.salt + 43);
  const edge = 1 - .25 * smooth(.15, .85, .5 + 2.2 * macro), q2 = cross / (edge * edge);
  if (q2 >= 1) return 0;
  const longitudinal = 1 - smooth(.65, 1, Math.abs(u)), finite = smooth(0, .18, 1 - r2);
  const hierarchy = smooth(.12, .82, .5 + 2.4 * macro) * (.25 + .75 * smooth(.18, .82, .5 + 2.2 * fine));
  return longitudinal * finite * (1 - q2) ** 2 * (.18 + .82 * hierarchy);
}
function* bakeSourceBrick(b, target) {
  yield 'source-brick-allocation';
  const n = b.resolution, texels = new Float32Array(n ** 3), r = b.rotation;
  let rawIntegral = 0;
  if (target > 0) for (let z = 1; z < n - 1; z++) for (let y = 1; y < n - 1; y++) {
    yield 'source-brick-density-row';
    for (let x = 1; x < n - 1; x++) {
      let value = 0;
      for (let sz = 0; sz < 2; sz++) for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const lx = ((x + (sx + .5) / 2) * 2 / n - 1) * b.axes[0], ly = ((y + (sy + .5) / 2) * 2 / n - 1) * b.axes[1], lz = ((z + (sz + .5) / 2) * 2 / n - 1) * b.axes[2];
        value += ribbonDensity(b, b.center[0] + r[0] * lx + r[1] * ly + r[2] * lz,
          b.center[1] + r[3] * lx + r[4] * ly + r[5] * lz, b.center[2] + r[6] * lx + r[7] * ly + r[8] * lz) / 8;
      }
      const i = (z * n + y) * n + x; texels[i] = value; rawIntegral += texels[i] * b.pixelVolume;
    }
  }
  if (target > 0 && !(rawIntegral > 0 && Number.isFinite(rawIntegral))) throw new RangeError('Source ribbon is unresolved on the local 32-cubed grid');
  const normalization = target === 0 ? 0 : target / rawIntegral;
  yield 'source-brick-cdf-allocation';
  const cdf = new Float64Array(n ** 3); let integral = 0, supportRadius = 0, verticalBound = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) {
    yield 'source-brick-normalize-cdf-row';
    for (let x = 0; x < n; x++) {
      const i = (z * n + y) * n + x; texels[i] *= normalization;
      if (!(Number.isFinite(texels[i]) && texels[i] >= 0)) throw new RangeError('Source brick exceeds Float32 density range');
      integral += texels[i] * b.pixelVolume; cdf[i] = integral;
      if (texels[i] === 0) continue;
      // Maximum norm on a rotated tent box is attained at one of its corners.
      for (let sz = -1; sz <= 1; sz += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sx = -1; sx <= 1; sx += 2) {
        const lx = ((x + .5 + sx) * 2 / n - 1) * b.axes[0], ly = ((y + .5 + sy) * 2 / n - 1) * b.axes[1], lz = ((z + .5 + sz) * 2 / n - 1) * b.axes[2];
        const px = b.center[0] + r[0] * lx + r[1] * ly + r[2] * lz, py = b.center[1] + r[3] * lx + r[4] * ly + r[5] * lz, pz = b.center[2] + r[6] * lx + r[7] * ly + r[8] * lz;
        supportRadius = Math.max(supportRadius, Math.hypot(px, py, pz)); verticalBound = Math.max(verticalBound, Math.abs(py));
      }
    }
  }
  if (target > 0 && !(integral > 0 && Number.isFinite(integral))) throw new RangeError('Source brick luminosity is outside Float32 range');
  return {published: Object.freeze({component: b.kernel.component, resolution: n, texels, center: b.center, axes: b.axes,
    inverse: b.inverse, rotation: b.rotation, pixelVolume: b.pixelVolume, integral}), cdf, rawIntegral, normalization, supportRadius, verticalBound};
}
function* finalizeSource(sourceTexels, source, scales = null, validate = false) {
  yield 'source-cdf-allocation';
  const cdfs = [new Float64Array(SOURCE_RESOLUTION ** 3), new Float64Array(SOURCE_RESOLUTION ** 3), new Float64Array(SOURCE_RESOLUTION ** 3)];
  const integrals = [0, 0, 0]; let supportRadius = 0, stellarVerticalBound = 0;
  for (let z = 0; z < SOURCE_RESOLUTION; z++) for (let y = 0; y < SOURCE_RESOLUTION; y++) {
    yield 'source-normalize-cdf-row';
    for (let x = 0; x < SOURCE_RESOLUTION; x++) {
      const cell = (z * SOURCE_RESOLUTION + y) * SOURCE_RESOLUTION + x; let positive = false;
      const edge = x === 0 || y === 0 || z === 0 || x === SOURCE_RESOLUTION - 1 || y === SOURCE_RESOLUTION - 1 || z === SOURCE_RESOLUTION - 1;
      if (validate && sourceTexels[cell * 4 + 3] !== 0) throw new RangeError('Source alpha channel must be zero');
      for (let p = 0; p < 3; p++) {
        const i = cell * 4 + p; if (scales) sourceTexels[i] *= scales[p];
        if (!(Number.isFinite(sourceTexels[i]) && sourceTexels[i] >= 0)) throw new RangeError('Source normalization exceeds Float32 density range');
        if (validate && edge && sourceTexels[i] !== 0) throw new RangeError('Source outer voxel layer must be zero');
        integrals[p] += sourceTexels[i] * source.pixelVolume; cdfs[p][cell] = integrals[p]; positive ||= sourceTexels[i] > 0;
      }
      if (positive) {
        supportRadius = Math.max(supportRadius, hatRadius(source, x, y, z));
        stellarVerticalBound = Math.max(stellarVerticalBound, Math.abs(source.center[1] + ((y + .5) * 2 / SOURCE_RESOLUTION - 1) * source.axes[1]) + 2 * source.axes[1] / SOURCE_RESOLUTION);
      }
    }
  }
  return {cdfs, integrals, supportRadius, stellarVerticalBound};
}

function* finalizeDust(dustTexels, dust, dustScale = null, validate = false) {
  let dustCloudIntegral = 0, dustVerticalBound = 0, supportRadius = 0;
  for (let z = 0; z < DUST_RESOLUTION; z++) for (let y = 0; y < DUST_RESOLUTION; y++) {
    yield 'dust-normalize-row';
    for (let x = 0; x < DUST_RESOLUTION; x++) {
      const i = (z * DUST_RESOLUTION + y) * DUST_RESOLUTION + x; if (dustScale !== null) dustTexels[i] *= dustScale;
      if (!(Number.isFinite(dustTexels[i]) && dustTexels[i] >= 0)) throw new RangeError('Dust normalization exceeds Float32 density range');
      if (validate && dustTexels[i] !== 0 && (x === 0 || y === 0 || z === 0 || x === DUST_RESOLUTION - 1 || y === DUST_RESOLUTION - 1 || z === DUST_RESOLUTION - 1))
        throw new RangeError('Dust outer voxel layer must be zero');
      dustCloudIntegral += dustTexels[i] * dust.pixelVolume;
      if (dustTexels[i] > 0) {
        supportRadius = Math.max(supportRadius, hatRadius(dust, x, y, z));
        dustVerticalBound = Math.max(dustVerticalBound, Math.abs(dust.center[1] + ((y + .5) * 2 / DUST_RESOLUTION - 1) * dust.axes[1]) + 2 * dust.axes[1] / DUST_RESOLUTION);
      }
    }
  }
  return {dustCloudIntegral, dustVerticalBound, supportRadius};
}

function* bakeSpatialMedium(config) {
  const {source, dust, luminosities} = config;
  yield 'source-allocation';
  const sourceTexels = new Float32Array(SOURCE_RESOLUTION ** 3 * 4);
  const brickConfig = config.sourceBrick;
  const baseSources = brickConfig ? config.sources.filter((_, i) => i !== brickConfig.kernelIndex) : config.sources;
  yield* bakeKernels(baseSources, source, sourceTexels, false, luminosities);
  const rawIntegrals = [0, 0, 0];
  for (let z = 0; z < SOURCE_RESOLUTION; z++) {
    yield 'source-integrals';
    for (let cell = z * SOURCE_RESOLUTION ** 2; cell < (z + 1) * SOURCE_RESOLUTION ** 2; cell++)
      for (let p = 0; p < 3; p++) rawIntegrals[p] += sourceTexels[cell * 4 + p] * source.pixelVolume;
  }
  const baseTargets = [...luminosities]; let removedCoarseIntegral = 0, brickTarget = 0;
  if (brickConfig && luminosities[brickConfig.kernel.component] > 0) {
    removedCoarseIntegral = yield* coarseKernelIntegral(brickConfig.kernel, source);
    const c = brickConfig.kernel.component;
    brickTarget = luminosities[c] * (removedCoarseIntegral / (removedCoarseIntegral + rawIntegrals[c]));
    baseTargets[c] = luminosities[c] - brickTarget;
  }
  const scales = rawIntegrals.map((v, p) => {
    if (baseTargets[p] > 0 && !(v > 0 && Number.isFinite(v))) throw new RangeError('Positive source component is unresolved on the fixed 64-cubed grid');
    return baseTargets[p] === 0 ? 0 : baseTargets[p] / v;
  });
  const sourceField = yield* finalizeSource(sourceTexels, source, scales);
  const {cdfs, integrals} = sourceField;
  let {supportRadius, stellarVerticalBound} = sourceField;
  for (let p = 0; p < 3; p++) if (baseTargets[p] > 0 && !(integrals[p] > 0 && Number.isFinite(integrals[p])))
    throw new RangeError('Source luminosity is outside the representable Float32 field range');
  const brick = brickConfig ? yield* bakeSourceBrick(brickConfig, brickTarget) : null;
  if (brick) {supportRadius = Math.max(supportRadius, brick.supportRadius); stellarVerticalBound = Math.max(stellarVerticalBound, brick.verticalBound);}
  yield 'dust-allocation';
  const dustTexels = new Float32Array(DUST_RESOLUTION ** 3);
  if (config.dustIntegral > 0) yield* bakeKernels(config.dusts, dust, dustTexels, true, luminosities);
  let rawDustIntegral = 0;
  for (let z = 0; z < DUST_RESOLUTION; z++) {
    yield 'dust-integrals';
    for (let i = z * DUST_RESOLUTION ** 2; i < (z + 1) * DUST_RESOLUTION ** 2; i++) rawDustIntegral += dustTexels[i] * dust.pixelVolume;
  }
  if (config.dustIntegral > 0 && !(rawDustIntegral > 0 && Number.isFinite(rawDustIntegral))) throw new RangeError('Positive dust is unresolved on the fixed 128-cubed grid');
  const dustScale = config.dustIntegral === 0 ? 0 : config.dustIntegral / rawDustIntegral;
  const dustField = yield* finalizeDust(dustTexels, dust, dustScale);
  const {dustCloudIntegral, dustVerticalBound} = dustField;
  supportRadius = Math.max(supportRadius, dustField.supportRadius);
  if (config.dustIntegral > 0 && !(dustCloudIntegral > 0 && Number.isFinite(dustCloudIntegral)))
    throw new RangeError('Dust integral is outside the representable Float32 field range');
  const baseIntegrals = Object.freeze(integrals);
  const synthesis = Object.freeze({kind: 'finite-artistic-ellipsoid-mixture', sourceKernelCount: config.sources.length, dustKernelCount: config.dusts.length,
      sourceBrick: brick ? Object.freeze({kernelIndex: brickConfig.kernelIndex, profile: brickConfig.profile, macroSpan: brickConfig.macroSpan, fineSpan: brickConfig.fineSpan,
        coarseIsolatedIntegral: removedCoarseIntegral, remainingRawIntegral: rawIntegrals[brick.published.component], assignedLuminosity: brickTarget,
        baseComponentIntegrals: baseIntegrals, rawIntegral: brick.rawIntegral, normalization: brick.normalization,
        semantics: 'Seeded artistic ribbon replaces one coarse kernel; J(x), point positions and CDF change'}) : null,
      sourceRawIntegrals: Object.freeze(rawIntegrals), sourceNormalizations: Object.freeze(scales), dustRawIntegral: rawDustIntegral, dustNormalization: dustScale,
      sourceQuadrature: '2x2x2 midpoint cell-volume average', dustQuadrature: '2x2x2 midpoint cell-volume average',
      reconstruction: 'Trilinear tents; finite-grid approximation, not pointwise analytic-profile equivalence',
      ownership: 'Published typed arrays are owned read-only by this medium; no caller mutation',
      semantics: 'Artist luminosity/extinction density in body-radius coordinates, not matter, fluid, orbit or N-body physics'});
  return publishSpatialMedium(config, sourceTexels, dustTexels, {cdfs, integrals, supportRadius, stellarVerticalBound, dustCloudIntegral, dustVerticalBound}, brick, synthesis);
}

function publishSpatialMedium(config, sourceTexels, dustTexels, field, brick, synthesis) {
  const {source, dust, luminosities} = config;
  const {cdfs, integrals, supportRadius, stellarVerticalBound, dustCloudIntegral, dustVerticalBound} = field;
  const baseIntegrals = Object.freeze(integrals);
  const combinedIntegrals = brick ? [...baseIntegrals] : integrals;
  if (brick) combinedIntegrals[brick.published.component] += brick.published.integral;
  const componentIntegrals = Object.freeze(combinedIntegrals);
  const medium = Object.freeze({revision: GALACTIC_SPATIAL_MEDIUM_REVISION, seed: config.seed,
    sourceBrick: brick ? brick.published : null, sourceVolumeResolution: SOURCE_RESOLUTION, sourceVolumeTexels: sourceTexels, sourceVolumeCenter: source.center, sourceVolumeAxes: source.axes,
    dustVolumeResolution: DUST_RESOLUTION, dustVolumeTexels: dustTexels, dustCloudCenter: dust.center, dustCloudAxes: dust.axes,
    sourceComponentIntegrals: componentIntegrals, sourceVolumePixelVolume: source.pixelVolume, dustCloudPixelVolume: dust.pixelVolume,
    dustCloudIntegral, dustIntegral: config.dustIntegral,
    // Include Float32 point-position rounding on top of exact tent corners.
    supportRadius: supportRadius * (1 + 2 ** -23) + 1e-12,
    stellarVerticalBound: stellarVerticalBound * (1 + 2 ** -23) + 1e-12,
    dustVerticalBound: dustVerticalBound === 0 ? 0 : dustVerticalBound * (1 + 2 ** -23) + 1e-12,
    totalLuminosity: config.totalLuminosity, diskLuminosity: luminosities[0] + luminosities[1],
    oldDiskLuminosity: luminosities[0], youngDiskLuminosity: luminosities[1], bulgeLuminosity: luminosities[2],
    oldStellarColor: config.colors[0], youngStellarColor: config.colors[1], bulgeColor: config.colors[2], extinctionColor: config.extinctionColor, resolvedFraction: config.resolvedFraction,
    spatialSynthesis: synthesis});
  fields.set(medium, {cdfs, baseIntegrals, brickCdf: brick ? brick.cdf : null, integrals: componentIntegrals, total: componentIntegrals[0] + componentIntegrals[1] + componentIntegrals[2]});
  return medium;
}

/** Fixed native volume boundary. Copy both arrays synchronously so later caller
 * writes cannot change cooperative validation, integration, CDFs or queries.
 */
function compileVolumes(options) {
  if (!options || typeof options !== 'object' || typeof options.seed !== 'string') throw new TypeError('Spatial medium requires a string seed');
  const source = frame(options.sourceCenter, options.sourceAxes, SOURCE_RESOLUTION, 'source');
  const dust = frame(options.dustCenter, options.dustAxes, DUST_RESOLUTION, 'dust');
  if (!Array.isArray(options.colors) || options.colors.length !== 3) throw new TypeError('Expected three source colors');
  const colors = Object.freeze(options.colors.map((c, i) => color(c, `source color ${i}`, true)));
  const extinctionColor = color(options.extinctionColor, 'extinction color', false), resolvedFraction = options.resolvedFraction;
  if (!(Number.isFinite(resolvedFraction) && resolvedFraction >= 0 && resolvedFraction <= 1)) throw new RangeError('Resolved fraction must be within 0–1');
  const sourceTexels = options.sourceVolumeTexels, dustTexels = options.dustVolumeTexels;
  if (!(sourceTexels instanceof Float32Array) || sourceTexels.length !== SOURCE_RESOLUTION ** 3 * 4
    || !(dustTexels instanceof Float32Array) || dustTexels.length !== DUST_RESOLUTION ** 3)
    throw new TypeError('Expected Float32Array source 64³ RGBA and dust 128³ scalar volumes');
  if ((typeof SharedArrayBuffer !== 'undefined') && (sourceTexels.buffer instanceof SharedArrayBuffer || dustTexels.buffer instanceof SharedArrayBuffer))
    throw new TypeError('Spatial volume snapshots require non-shared ArrayBuffers');
  return {seed: options.seed, source, dust, colors, extinctionColor, resolvedFraction,
    sourceTexels: sourceTexels.slice(), dustTexels: dustTexels.slice()};
}
function* finalizeVolumes(config) {
  const {sourceTexels, dustTexels} = config;
  const sourceField = yield* finalizeSource(sourceTexels, config.source, null, true);
  const luminosities = sourceField.integrals, totalLuminosity = luminosities[0] + luminosities[1] + luminosities[2];
  if (!(totalLuminosity > 0 && Number.isFinite(totalLuminosity))) throw new RangeError('Actual source integral must be positive and finite');
  const dustField = yield* finalizeDust(dustTexels, config.dust, null, true);
  if (!Number.isFinite(dustField.dustCloudIntegral)) throw new RangeError('Actual dust integral must be finite');
  const actual = {...config, luminosities, totalLuminosity, dustIntegral: dustField.dustCloudIntegral};
  const synthesis = Object.freeze({kind: 'compiled-spatial-volumes',
    sourceRawIntegrals: Object.freeze(luminosities), sourceNormalizations: Object.freeze([1, 1, 1]),
    dustRawIntegral: dustField.dustCloudIntegral, dustNormalization: 1,
    sourceQuadrature: 'Caller-provided cell values', dustQuadrature: 'Caller-provided cell values',
    reconstruction: 'Trilinear tents; finite-grid approximation, not pointwise analytic-profile equivalence',
    ownership: 'Published typed arrays are owned read-only by this medium; detached from caller arrays',
    semantics: 'Artist luminosity/extinction density in body-radius coordinates, not matter, fluid, orbit or N-body physics'});
  return publishSpatialMedium(actual, sourceTexels, dustTexels, {...sourceField, ...dustField,
    supportRadius: Math.max(sourceField.supportRadius, dustField.supportRadius)}, null, synthesis);
}
/** As-is finite Float32 volumes; no target-budget normalization or gain.
 * The atomic input snapshot precedes the cooperative task's row-sized work.
 */
export function createSpatialGalacticMediumFromVolumesTask(options) {
  return createMediumTask(finalizeVolumes(compileVolumes(options)));
}
export function createSpatialGalacticMediumFromVolumes(options) {
  const task = createSpatialGalacticMediumFromVolumesTask(options); task.advance(Infinity); return task.result;
}

/** Constructor-boundary validation and detached input snapshot happen once.
 * advance yields at real density rows and normalization/CDF phases. Nothing is
 * published until complete; cancellation releases the generator's WIP arrays.
 */
export function createSpatialGalacticMediumTask(options) {
  return createMediumTask(bakeSpatialMedium(compileOptions(options)));
}
function createMediumTask(iterator) {
  let state = 'pending', result, error, stage = 'pending';
  const metrics = {steps: 0, maximumChunkMs: 0};
  function step() {
    if (state !== 'pending') return true;
    const start = performance.now();
    try {
      const next = iterator.next(); metrics.steps++; metrics.maximumChunkMs = Math.max(metrics.maximumChunkMs, performance.now() - start);
      if (next.done) {result = next.value; iterator = null; state = stage = 'complete';}
      else stage = next.value;
      return state !== 'pending';
    } catch (cause) {
      // V8's lazy stack frames can retain the failed generator's volume arrays.
      // Materialize the original diagnostic before releasing that task owner.
      if (cause instanceof Error) void cause.stack;
      error = cause; iterator = null; state = stage = 'failed'; throw cause;
    }
  }
  return Object.freeze({
    step,
    advance(ms = 2) {
      if (!(ms > 0) || (!Number.isFinite(ms) && ms !== Infinity)) throw new RangeError('Spatial medium task budget must be positive milliseconds or Infinity');
      const start = performance.now();
      do {if (step()) return true;} while (performance.now() - start < ms);
      return false;
    },
    cancel() {
      if (state !== 'pending') return false;
      try {iterator.return();} finally {iterator = null; result = undefined; state = stage = 'cancelled';}
      return true;
    },
    get state() {return state;}, get result() {return state === 'complete' ? result : undefined;},
    get error() {return error;}, get stage() {return stage;}, get metrics() {return metrics;},
  });
}
export function createSpatialGalacticMedium(options) {
  const task = createSpatialGalacticMediumTask(options); task.advance(Infinity); return task.result;
}

function scalarVolume(table, n, center, axes, x, y, z) {
  const bx = (x - center[0]) / axes[0], by = (y - center[1]) / axes[1], bz = (z - center[2]) / axes[2];
  return normalizedScalarVolume(table, n, bx, by, bz);
}
function normalizedScalarVolume(table, n, bx, by, bz) {
  if (Math.abs(bx) >= 1 || Math.abs(by) >= 1 || Math.abs(bz) >= 1) return 0;
  const u = (bx + 1) * n * .5 - .5, v = (by + 1) * n * .5 - .5, w = (bz + 1) * n * .5 - .5;
  const ix = Math.floor(u), iy = Math.floor(v), iz = Math.floor(w), fx = u - ix, fy = v - iy, fz = w - iz; let value = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const cx = Math.max(0, Math.min(n - 1, ix + dx)), cy = Math.max(0, Math.min(n - 1, iy + dy)), cz = Math.max(0, Math.min(n - 1, iz + dz));
    value += table[(cz * n + cy) * n + cx] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
  }
  return value;
}
/** Trusted stationary sampler. Reuses caller-owned output and allocates no
 * arrays, vectors, objects or closures; source and dust read the baked fields.
 */
export function sampleSpatialGalacticMedium(medium, position, output) {
  const emission = output.emission, extinction = output.extinction;
  emission[0] = emission[1] = emission[2] = 0;
  const n = medium.sourceVolumeResolution, center = medium.sourceVolumeCenter, axes = medium.sourceVolumeAxes;
  const bx = (position[0] - center[0]) / axes[0], by = (position[1] - center[1]) / axes[1], bz = (position[2] - center[2]) / axes[2];
  if (Math.abs(bx) < 1 && Math.abs(by) < 1 && Math.abs(bz) < 1) {
    const u = (bx + 1) * n * .5 - .5, v = (by + 1) * n * .5 - .5, w = (bz + 1) * n * .5 - .5;
    const ix = Math.floor(u), iy = Math.floor(v), iz = Math.floor(w), fx = u - ix, fy = v - iy, fz = w - iz, table = medium.sourceVolumeTexels;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const cx = Math.max(0, Math.min(n - 1, ix + dx)), cy = Math.max(0, Math.min(n - 1, iy + dy)), cz = Math.max(0, Math.min(n - 1, iz + dz));
      const i = ((cz * n + cy) * n + cx) * 4, weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
      for (let c = 0; c < 3; c++) emission[c] += weight * (table[i] * medium.oldStellarColor[c] + table[i + 1] * medium.youngStellarColor[c] + table[i + 2] * medium.bulgeColor[c]);
    }
  }
  const brick = medium.sourceBrick;
  if (brick && brick.integral > 0) {
    const a = brick.inverse, x = position[0] - brick.center[0], y = position[1] - brick.center[1], z = position[2] - brick.center[2];
    const density = normalizedScalarVolume(brick.texels, brick.resolution, a[0] * x + a[1] * y + a[2] * z, a[3] * x + a[4] * y + a[5] * z, a[6] * x + a[7] * y + a[8] * z);
    const color = brick.component === 0 ? medium.oldStellarColor : brick.component === 1 ? medium.youngStellarColor : medium.bulgeColor;
    for (let c = 0; c < 3; c++) emission[c] += density * color[c];
  }
  const dust = scalarVolume(medium.dustVolumeTexels, medium.dustVolumeResolution, medium.dustCloudCenter, medium.dustCloudAxes, position[0], position[1], position[2]);
  for (let c = 0; c < 3; c++) extinction[c] = dust * medium.extinctionColor[c];
  return output;
}

/** Public wrapper owns seed/count validation. Independent returned snapshots;
 * component-conditioned 3D tent mixtures exactly follow the same Float32
 * source-volume measure, up to returned Float32 coordinate rounding.
 */
export function sampleSpatialGalacticStars(medium, seed, count) {
  const random = randomFromSeed(`${seed}:galactic-spatial-stars-v3`), field = fields.get(medium), n = medium.sourceVolumeResolution;
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), rawLuminosities = new Float32Array(count), componentIndices = new Uint8Array(count);
  for (let star = 0; star < count; star++) {
    const choice = random() * field.total;
    const component = choice < field.integrals[0] ? 0 : choice < field.integrals[0] + field.integrals[1] ? 1 : 2;
    let cdf = field.cdfs[component], target = random() * field.integrals[component];
    const brick = medium.sourceBrick, inBrick = brick && brick.component === component && target >= field.baseIntegrals[component];
    if (inBrick) {cdf = field.brickCdf; target -= field.baseIntegrals[component];}
    let lower = 0, upper = cdf.length - 1;
    while (lower < upper) {const middle = (lower + upper) >>> 1; if (cdf[middle] <= target) lower = middle + 1; else upper = middle;}
    const cell = lower, index = star * 3;
    if (inBrick) {
      const size = brick.resolution, r = brick.rotation;
      const x = ((cell % size + .5 + random() - random()) * 2 / size - 1) * brick.axes[0];
      const y = ((Math.floor(cell / size) % size + .5 + random() - random()) * 2 / size - 1) * brick.axes[1];
      const z = ((Math.floor(cell / (size * size)) + .5 + random() - random()) * 2 / size - 1) * brick.axes[2];
      positions[index] = brick.center[0] + r[0] * x + r[1] * y + r[2] * z;
      positions[index + 1] = brick.center[1] + r[3] * x + r[4] * y + r[5] * z;
      positions[index + 2] = brick.center[2] + r[6] * x + r[7] * y + r[8] * z;
    } else {
      positions[index] = medium.sourceVolumeCenter[0] + (((cell % n) + .5 + random() - random()) * 2 / n - 1) * medium.sourceVolumeAxes[0];
      positions[index + 1] = medium.sourceVolumeCenter[1] + (((Math.floor(cell / n) % n) + .5 + random() - random()) * 2 / n - 1) * medium.sourceVolumeAxes[1];
      positions[index + 2] = medium.sourceVolumeCenter[2] + ((Math.floor(cell / (n * n)) + .5 + random() - random()) * 2 / n - 1) * medium.sourceVolumeAxes[2];
    }
    componentIndices[star] = component;
    const color = component === 0 ? medium.oldStellarColor : component === 1 ? medium.youngStellarColor : medium.bulgeColor;
    for (let c = 0; c < 3; c++) colors[index + c] = color[c];
    rawLuminosities[star] = .2 + .8 * (1 - random() + 1 / 65536) ** -.65;
  }
  return {positions, colors, rawLuminosities, componentIndices};
}
