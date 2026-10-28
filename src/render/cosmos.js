import * as THREE from 'three';
import { CELL_SIZE, decodeCell } from '../coordinates.js';
import { randomFromSeed } from '../random.js';
import { createGalaxyHaze } from './galaxy-haze.js';
import { COSMIC_VIEW_FADE_START, COSMIC_VIEW_FAR, COSMIC_MAX_STRUCTURES, COSMIC_DEPTH_GLSL, describeCosmicStructures } from '../cosmic-structures.js';

// Additive scenery has an independent revision from caller-owned bodies and addresses.
export const COSMOS_VERSION = 1;
export const MACRO_CELLS = 16;
export const MACRO_SIZE = CELL_SIZE * MACRO_CELLS;
export const MACRO_PERIOD = 32768 / MACRO_CELLS;
export const COSMOS_FADE_START = 420000;
export const COSMOS_VIEW_FAR = 520000;
export const GALAXY_MAX_RADIUS = MACRO_SIZE * .3;
export const PARTICLES_PER_GALAXY = 4096;
export const COSMOS_QUALITY_COUNTS = Object.freeze({ low: 512, auto: 2048, high: PARTICLES_PER_GALAXY });
export const MAX_COSMOS_PARTICLES = 27 * PARTICLES_PER_GALAXY;
const AXES = ['x', 'y', 'z'];
const WORLD_SIZE = 32768 * CELL_SIZE;
const SAMPLE_CACHE_BYTE_LIMIT = 8 * 1024 * 1024;
const wrap = (n, period) => ((n + period / 2) % period + period) % period - period / 2;
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function cosmosVisibility(distance) {
  return Number.isFinite(distance) ? 1 - smoothstep(COSMOS_FADE_START, COSMOS_VIEW_FAR, distance) : 0;
}

/** A macro coordinate, not an address cell coordinate. Empty macros return null. */
export function describeMacro(coordinate, seed = 'lonelysky') {
  if (typeof seed !== 'string' || !AXES.every(axis => Number.isSafeInteger(coordinate[axis]))) throw new TypeError('Invalid macro coordinate or seed');
  const cell = Object.fromEntries(AXES.map(axis => [axis, wrap(coordinate[axis], MACRO_PERIOD)]));
  const parent = AXES.map(axis => Math.floor(cell[axis] / 2));
  const random = randomFromSeed(`${seed}:cosmos-${COSMOS_VERSION}:parent:${parent}`);
  // One candidate per 2³ block gives a strict resource bound without selecting
  // a changing nearest-N list. Periodic, slowly varying waves leave large voids.
  const selected = [Math.floor(random() * 2), Math.floor(random() * 2), Math.floor(random() * 2)];
  if (!AXES.every((axis, i) => cell[axis] - parent[i] * 2 === selected[i])) return null;
  const phase = randomFromSeed(`${seed}:cosmic-web-v1`)() * Math.PI * 2;
  const wave = Math.sin(parent[0] * Math.PI / 16 + Math.sin(parent[1] * Math.PI / 32) + phase)
    * Math.cos(parent[2] * Math.PI / 32 - parent[1] * Math.PI / 64 + phase);
  const density = .12 + .64 * smoothstep(-.25, .7, wave);
  if (random() > density) return null;
  const id = `cosmos-${COSMOS_VERSION}:${cell.x},${cell.y},${cell.z}`;
  const detail = randomFromSeed(`${seed}:${id}`);
  const roll = detail();
  const morphology = roll < .54 ? 'spiral' : roll < .83 ? 'elliptical' : 'irregular';
  return Object.freeze({ id, revision: COSMOS_VERSION, seed: `${seed}:${id}`, macroCell: Object.freeze(cell),
    offset: Object.freeze(AXES.map(() => (detail() - .5) * MACRO_SIZE * .3)),
    orientation: Object.freeze([detail() * Math.PI * 2, Math.acos(detail() * 2 - 1), detail() * Math.PI * 2]),
    morphology, radius: MACRO_SIZE * (.115 + detail() * .185),
    thickness: morphology === 'spiral' ? .035 + detail() * .045 : morphology === 'elliptical' ? .48 + detail() * .38 : .2 + detail() * .2,
    arms: 2 + Math.floor(detail() * 3), pitch: .22 + detail() * .19,
    bar: detail() < .35, asymmetry: detail(), population: density });
}

/** Local 3D positions; every quality level is an exact prefix of the same stream. */
export function sampleGalaxy(descriptor, count = PARTICLES_PER_GALAXY) {
  if (!Number.isInteger(count) || count < 0 || count > PARTICLES_PER_GALAXY) throw new RangeError('Invalid galaxy sample count');
  const openClusterV3 = descriptor.revision === 3 && descriptor.kind === 'cluster' && descriptor.family === 'open' && descriptor.morphology === 'irregular';
  const random = randomFromSeed(`${descriptor.seed}:particles-v1`);
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count);
  const rotation = new THREE.Euler(...descriptor.orientation), point = new THREE.Vector3(), color = new THREE.Color();
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(random() * Math.PI * 2);
  for (let i = 0; i < count; i++) {
    const component = random(), angle = random() * Math.PI * 2;
    let x, y, z, young = false;
    if (descriptor.morphology === 'spiral' && component > .18) {
      const radius = .08 + Math.pow(random(), .7) * .9;
      const arm = Math.floor(random() * descriptor.arms);
      const theta = arm * Math.PI * 2 / descriptor.arms + Math.log(radius + .06) / descriptor.pitch + gaussian() * .12;
      x = Math.cos(theta) * radius; z = Math.sin(theta) * radius; y = gaussian() * descriptor.thickness * (.4 + radius);
      if (descriptor.bar && radius < .3) { x *= 1.6; z *= .45; }
      young = random() < .16;
    } else if (descriptor.morphology === 'irregular') {
      const knot = Math.floor(random() * 3), theta = knot * 2.1 + descriptor.asymmetry;
      x = Math.cos(theta) * (.2 + knot * .17) + gaussian() * .17;
      z = Math.sin(theta) * (.2 + knot * .17) + gaussian() * .19;
      y = (knot - 1) * .12 + gaussian() * descriptor.thickness * (openClusterV3 ? 1 / 3 : 1);
      young = random() < .1;
    } else {
      const radius = Math.pow(random(), 1.7) * .95, vertical = random() * 2 - 1;
      const planar = Math.sqrt(1 - vertical * vertical);
      x = Math.cos(angle) * planar * radius; z = Math.sin(angle) * planar * radius * .8;
      y = vertical * radius * (descriptor.morphology === 'spiral' ? .52 : descriptor.thickness);
    }
    // Hard support is required by the stream-coverage proof, including Gaussian tails.
    point.set(x, y, z);
    if (openClusterV3) {
      const r = point.length();
      // Only the outer tail bends; value and first derivative join at .8.
      if (r > .8) { const t = r - .8; point.multiplyScalar((.8 + .18 * t / (.18 + t)) / r); }
    } else if (point.length() > .98) point.setLength(.98);
    point.multiplyScalar(descriptor.radius).applyEuler(rotation);
    positions.set(point.toArray(), i * 3);
    color.set(young ? 0xa2b4ca : descriptor.morphology === 'elliptical' ? 0xc8b99d : 0xc5c2b8);
    const luminosityRoll = random();
    color.multiplyScalar(.22 + luminosityRoll * .38); colors.set(color.toArray(), i * 3);
    sizes[i] = descriptor.radius * (.008 + random() * .008);
    if (descriptor.revision === 3) {
      // Reuse the already-consumed draw: star positions and all following RNG
      // states stay fixed. A small bright tail resolves individual stars among
      // a fainter population rather than lighting every sample equally.
      const luminosity = .35 + 3.4 * luminosityRoll ** 8;
      const exposure = descriptor.kind === 'cluster' ? 2.1 : 1.1;
      const gain = luminosity * exposure / (.22 + luminosityRoll * .38);
      colors[i * 3] *= gain; colors[i * 3 + 1] *= gain; colors[i * 3 + 2] *= gain;
      // Resolved tracers of a diffuse population, never collision bodies. Clouds
      // carry only a sparse embedded population and clusters keep a broad halo.
      if (descriptor.kind === 'nebula') {
        colors[i * 3] *= .12; colors[i * 3 + 1] *= .12; colors[i * 3 + 2] *= .12;
        sizes[i] *= .22;
      } else if (descriptor.kind === 'cluster') sizes[i] *= .6;
    }
  }
  return { positions, colors, sizes };
}

/** Coordinates relative to the caller's floating origin, with toroidal wrapping. */
export function galaxyRelativeCenter(descriptor, cell, gridCells = descriptor.gridCells ?? MACRO_CELLS) {
  const gridSize = gridCells * CELL_SIZE;
  return AXES.map((axis, i) => wrap(descriptor.macroCell[axis] * gridSize + (gridCells - 1) * CELL_SIZE / 2 + descriptor.offset[i] - cell[axis] * CELL_SIZE, WORLD_SIZE));
}

export function loadedMacros(sectorIndex, seed = 'lonelysky', { descriptorProvider = describeMacro, gridCells = MACRO_CELLS } = {}) {
  const cell = decodeCell(sectorIndex), macro = Object.fromEntries(AXES.map(axis => [axis, Math.floor(cell[axis] / gridCells)]));
  const descriptors = [];
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    const descriptor = descriptorProvider({ x: macro.x + x, y: macro.y + y, z: macro.z + z }, seed);
    if (Array.isArray(descriptor)) descriptors.push(...descriptor);
    else if (descriptor) descriptors.push(descriptor);
  }
  return descriptors;
}

/** Fine stars plus bounded analytic emission volumes; generation is unchanged. */
export function createCosmos({ seed = 'lonelysky', descriptorProvider = describeMacro, gridCells = MACRO_CELLS, structures = false } = {}) {
  if (!Number.isInteger(gridCells) || gridCells <= 0 || 32768 % gridCells !== 0 || typeof descriptorProvider !== 'function') throw new TypeError('Invalid cosmos grid or descriptor provider');
  const catalogueOptions = { descriptorProvider, gridCells };
  const fadeStart = structures ? COSMIC_VIEW_FADE_START : COSMOS_FADE_START, viewFar = structures ? COSMIC_VIEW_FAR : COSMOS_VIEW_FAR;
  const group = new THREE.Group(); group.name = 'macrocosmos';
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.ShaderMaterial({
    defines: { FADE_START: `${fadeStart}.`, FADE_FAR: `${viewFar}.`, ...(structures ? { COSMIC_STRUCTURES: 1 } : {}) },
    uniforms: { cameraLocal: { value: new THREE.Vector3() }, pixelHeight: { value: 1 }, brightness: { value: 1 }, sampleWeight: { value: 1 }, minimumPointSize: { value: 4 } },
    vertexShader: /* glsl */`
      ${COSMIC_DEPTH_GLSL}
      attribute vec3 color;attribute float pointRadius;
      uniform vec3 cameraLocal;uniform float pixelHeight;uniform float minimumPointSize;
      varying vec3 tint;varying float alpha;varying float rasterWeight;
      void main(){
        vec3 relative=position-cameraLocal;float distanceToCamera=length(relative);
        alpha=1.-smoothstep(FADE_START,FADE_FAR,distanceToCamera);tint=color;
        if(alpha==0.){gl_Position=vec4(0.,0.,2.,1.);gl_PointSize=1.;return;}
        // Keep all nearby depth relationships. Only distant drawing depth is
        // compressed to fit the existing 220k clip plane; angles stay exact.
        float drawDistance=distanceToCamera<=160000.?distanceToCamera:160000.+40000.*(1.-exp(-(distanceToCamera-160000.)/180000.));
        #ifdef COSMIC_STRUCTURES
          drawDistance=cosmicDrawDistance(distanceToCamera);
        #endif
        vec3 proxy=cameraLocal+relative*(drawDistance/max(distanceToCamera,.001));
        vec4 view=modelViewMatrix*vec4(proxy,1.);
        gl_Position=projectionMatrix*view;
        float angularSize=pointRadius*pixelHeight*projectionMatrix[1][1]/max(distanceToCamera,1.);
        float apparentSize=clamp(angularSize*.45,.7,2.4);
        // Resolve the radial kernel across several physical pixels. Preserve
        // integrated light rather than letting small stars brighten as they grow.
        gl_PointSize=max(apparentSize,minimumPointSize);
        rasterWeight=pow(apparentSize/gl_PointSize,2.);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 tint;varying float alpha;varying float rasterWeight;uniform float brightness;uniform float sampleWeight;
      void main(){float radius=length(gl_PointCoord-.5);
        float glow=exp(-radius*radius*22.)*(1.-smoothstep(.36,.5,radius));
        float opacity=.42*sqrt(sampleWeight);
        gl_FragColor=vec4(tint*brightness,glow*alpha*opacity*rasterWeight);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
  });
  const points = new THREE.Points(geometry, material); points.frustumCulled = false; group.add(points);
  const haze = createGalaxyHaze({ seed, structures }); group.add(haze);
  // Only these producers guarantee that an ID has the same sampling inputs
  // for this instance's fixed seed. Custom providers may change a shape at
  // the same ID; they retain the uncached path and public snapshot contract.
  const cacheSamples = descriptorProvider === describeMacro || descriptorProvider === describeCosmicStructures;
  const sampleCache = new Map();
  let sampleGeneration = 0;
  let lastCell = '', lastMacro = '', lastCount = 0, descriptors = [], samples = [], centers = [], disposed = false;
  let currentIndex = -1, currentCell, key = '', macroKey = '';
  const hazeFrame = { centers: null, cameraPosition: null, quality: 'auto', brightness: 1, home: false };
  const stats = { revision: structures ? 3 : COSMOS_VERSION, galaxies: 0, clusters: 0, nebulae: 0, structures: 0, particles: 0, maxParticles: (structures ? COSMIC_MAX_STRUCTURES * PARTICLES_PER_GALAXY : MAX_COSMOS_PARTICLES), batches: 0, visible: true, rebuilds: 0,
    sampleCacheLimit: cacheSamples ? SAMPLE_CACHE_BYTE_LIMIT : 0, sampleCacheBytes: 0, sampleCacheHits: 0, sampleGenerations: 0 };
  Object.defineProperty(group.userData, 'stats', { get: () => ({ ...stats, sampleCacheEntries: sampleCache.size }) });
  function sampleDescriptors(count) {
    // Each exact-count result owns seven float32 components per point. This
    // ceiling covers cached sample arrays, not active geometry or total RAM.
    // An oversized batch is sampled normally without churning a partial LRU.
    const cacheBatch = cacheSamples && descriptors.length * count * 7 * Float32Array.BYTES_PER_ELEMENT <= SAMPLE_CACHE_BYTE_LIMIT;
    const generation = ++sampleGeneration;
    if (cacheBatch) for (const descriptor of descriptors) {
      const entry = sampleCache.get(`${count}:${descriptor.id}`);
      if (entry) entry.generation = generation;
    }
    return descriptors.map(descriptor => {
      const key = cacheBatch ? `${count}:${descriptor.id}` : null;
      const entry = cacheBatch && sampleCache.get(key);
      if (entry) {
        sampleCache.delete(key); sampleCache.set(key, entry);
        stats.sampleCacheHits++;
        return entry.sample;
      }
      const sample = sampleGalaxy(descriptor, count);
      stats.sampleGenerations++;
      if (cacheBatch) {
        const bytes = sample.positions.byteLength + sample.colors.byteLength + sample.sizes.byteLength;
        // Mark the whole incoming batch before eviction: an early miss must
        // not evict a later hit that this same update still needs.
        for (const [oldKey, old] of sampleCache) {
          if (stats.sampleCacheBytes + bytes <= SAMPLE_CACHE_BYTE_LIMIT) break;
          if (old.generation === generation) continue;
          sampleCache.delete(oldKey); stats.sampleCacheBytes -= old.bytes;
        }
        sampleCache.set(key, { sample, bytes, generation });
        stats.sampleCacheBytes += bytes;
      }
      return sample;
    });
  }
  group.userData.update = ({ sectorIndex, cameraPosition, quality = 'auto', quiet = 0, home = false, viewportHeight = 1, pixelRatio = 1 }) => {
    if (disposed) return;
    if (sectorIndex !== currentIndex) {
      currentCell = decodeCell(sectorIndex); currentIndex = sectorIndex;
      key = `${currentCell.x},${currentCell.y},${currentCell.z}`;
      macroKey = `${Math.floor(currentCell.x / gridCells)},${Math.floor(currentCell.y / gridCells)},${Math.floor(currentCell.z / gridCells)}`;
    }
    const cell = currentCell;
    const count = COSMOS_QUALITY_COUNTS[quality] ?? COSMOS_QUALITY_COUNTS.auto;
    const populationChanged = macroKey !== lastMacro || count !== lastCount;
    if (populationChanged) {
      descriptors = loadedMacros(sectorIndex, seed, catalogueOptions); samples = sampleDescriptors(count);
      if (macroKey !== lastMacro) haze.userData.setDescriptors(descriptors);
      lastCell = '';
    }
    if (key !== lastCell) {
      // A floating-origin rebase translates the same population. Retain its
      // GPU buffers and immutable color/radius attributes until it changes.
      centers = descriptors.map(descriptor => galaxyRelativeCenter(descriptor, cell, gridCells));
      const positions = populationChanged ? new Float32Array(descriptors.length * count * 3) : geometry.attributes.position.array;
      descriptors.forEach((descriptor, j) => {
        const center = centers[j], sample = samples[j];
        for (let i = 0; i < count * 3; i++) positions[j * count * 3 + i] = sample.positions[i] + center[i % 3];
      });
      if (populationChanged) {
        const colors = new Float32Array(positions.length), sizes = new Float32Array(descriptors.length * count);
        samples.forEach((sample, j) => { colors.set(sample.colors, j * count * 3); sizes.set(sample.sizes, j * count); });
        // Attribute counts may change; release old buffers before replacing.
        geometry.dispose();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('pointRadius', new THREE.BufferAttribute(sizes, 1));
        geometry.setDrawRange(0, sizes.length);
      } else geometry.attributes.position.needsUpdate = true;
      stats.galaxies = 0; stats.clusters = 0; stats.nebulae = 0; stats.structures = descriptors.length;
      for (const descriptor of descriptors) {
        if (descriptor.kind === 'cluster') stats.clusters++;
        else if (descriptor.kind === 'nebula') stats.nebulae++;
        else stats.galaxies++;
      }
      stats.particles = positions.length / 3; stats.rebuilds++;
      lastMacro = macroKey; lastCount = count; lastCell = key;
    }
    material.uniforms.cameraLocal.value.fromArray(cameraPosition);
    material.uniforms.pixelHeight.value = Math.max(1, viewportHeight * pixelRatio);
    material.uniforms.sampleWeight.value = COSMOS_QUALITY_COUNTS.auto / count;
    material.uniforms.brightness.value = 1 - Math.max(0, Math.min(1, quiet)) * .52;
    group.visible = !home; stats.visible = group.visible;
    hazeFrame.centers = centers; hazeFrame.cameraPosition = cameraPosition; hazeFrame.quality = quality;
    hazeFrame.brightness = material.uniforms.brightness.value; hazeFrame.home = home;
    const volumes = haze.userData.update(hazeFrame);
    stats.batches = home ? 0 : Number(stats.particles > 0) + volumes;
  };
  group.userData.dispose = () => { if (disposed) return; disposed = true; geometry.dispose(); material.dispose(); haze.userData.dispose(); group.clear(); samples = []; descriptors = []; centers = []; sampleCache.clear(); stats.sampleCacheBytes = 0; stats.visible = false; stats.batches = 0; };
  return group;
}
