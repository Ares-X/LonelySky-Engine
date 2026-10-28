import * as THREE from 'three';
import { CELL_SIZE, decodeCell } from '../coordinates.js';
import { randomFromSeed } from '../random.js';
import { createGalaxyHaze } from './galaxy-haze.js';
import { COSMIC_VIEW_FADE_START, COSMIC_VIEW_FAR, COSMIC_GRID_CELLS, COSMIC_MAX_STRUCTURES, COSMIC_DEPTH_GLSL, describeCosmicStructures } from '../cosmic-structures.js';

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
  const sampler = createLegacyGalaxySampler(descriptor, count);
  sampler.step(Math.max(1, count));
  return sampler.result;
}

/** A resumable legacy stream. Partial buffers stay private until complete. */
export function createLegacyGalaxySampler(descriptor, count = PARTICLES_PER_GALAXY) {
  if (!Number.isInteger(count) || count < 0 || count > PARTICLES_PER_GALAXY) throw new RangeError('Invalid galaxy sample count');
  const openClusterV3 = descriptor.revision === 3 && descriptor.kind === 'cluster' && descriptor.family === 'open' && descriptor.morphology === 'irregular';
  const random = randomFromSeed(`${descriptor.seed}:particles-v1`);
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...descriptor.orientation));
  const point = new THREE.Vector3(), color = new THREE.Color();
  const youngColor = new THREE.Color(0xa2b4ca);
  const oldColor = new THREE.Color(descriptor.morphology === 'elliptical' ? 0xc8b99d : 0xc5c2b8);
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(random() * Math.PI * 2);
  let cursor = 0;
  const sample = { positions, colors, sizes };
  function step(limit) {
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('Invalid galaxy sample step');
    const end = Math.min(count, cursor + limit);
    for (let i = cursor; i < end; i++) {
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
      point.multiplyScalar(descriptor.radius).applyQuaternion(rotation);
      point.toArray(positions, i * 3);
      color.copy(young ? youngColor : oldColor);
      const luminosityRoll = random();
      color.multiplyScalar(.22 + luminosityRoll * .38); color.toArray(colors, i * 3);
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
    cursor = end;
    return cursor === count;
  }
  return { step, get cursor() { return cursor; }, get complete() { return cursor === count; },
    get result() {
      if (cursor !== count) throw new Error('Galaxy sample is not complete');
      return sample;
    } };
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

/** Fine stars plus bounded analytic emission volumes; generation is unchanged.
 * Opt-in incremental mode prepares one complete exact batch in bounded CPU
 * slices. Hosts must await userData.prepare(frame, { signal }) before revealing
 * a cold scene or discontinuous jump. Ordinary flight may retain the active
 * population only while catalogue-difference supports are still invisible.
 * requestPopulation(frame) prepares ahead without changing the active scene;
 * update(frame) alone publishes a complete batch at the matching actual pose.
 * The budget covers legacy sampling/assembly, not catalogue or haze creation,
 * renderer compilation or GPU upload. Default update remains synchronous.
 */
export function createCosmos({ seed = 'lonelysky', descriptorProvider = describeMacro, gridCells = MACRO_CELLS, structures = false, incremental = false, preparationBudgetMs = 2 } = {}) {
  if (!Number.isInteger(gridCells) || gridCells <= 0 || 32768 % gridCells !== 0 || typeof descriptorProvider !== 'function') throw new TypeError('Invalid cosmos grid or descriptor provider');
  if (typeof incremental !== 'boolean' || !Number.isFinite(preparationBudgetMs) || preparationBudgetMs <= 0) throw new TypeError('Invalid cosmos preparation options');
  const catalogueOptions = { descriptorProvider, gridCells };
  // The canonical catalogue owns the bounded 108-structure support contract.
  // Custom/wrapped providers retain their existing per-sample visibility.
  const supportFade = structures && descriptorProvider === describeCosmicStructures && gridCells === COSMIC_GRID_CELLS;
  let supportVisibility = supportFade ? new Float32Array(COSMIC_MAX_STRUCTURES) : null;
  const fadeStart = structures ? COSMIC_VIEW_FADE_START : COSMOS_FADE_START, viewFar = structures ? COSMIC_VIEW_FAR : COSMOS_VIEW_FAR;
  const group = new THREE.Group(); group.name = 'macrocosmos';
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.ShaderMaterial({
    defines: { FADE_START: `${fadeStart}.`, FADE_FAR: `${viewFar}.`, ...(structures ? { COSMIC_STRUCTURES: 1 } : {}), ...(supportFade ? { COSMIC_SUPPORT_FADE: 1 } : {}) },
    uniforms: { cameraLocal: { value: new THREE.Vector3() }, pixelHeight: { value: 1 }, brightness: { value: 1 }, sampleWeight: { value: 1 }, minimumPointSize: { value: 4 } },
    vertexShader: /* glsl */`
      ${COSMIC_DEPTH_GLSL}
      attribute vec3 color;attribute float pointRadius;
      uniform vec3 cameraLocal;uniform float pixelHeight;uniform float minimumPointSize;
      #ifdef COSMIC_SUPPORT_FADE
        attribute float descriptorIndex;
        uniform vec4 structureWeights[${COSMIC_MAX_STRUCTURES / 4}];
      #endif
      varying vec3 tint;varying float alpha;varying float rasterWeight;
      void main(){
        vec3 relative=position-cameraLocal;float distanceToCamera=length(relative);
        #ifdef COSMIC_SUPPORT_FADE
          int structure=int(descriptorIndex);
          alpha=structureWeights[structure/4][structure-structure/4*4];
        #else
          alpha=1.-smoothstep(FADE_START,FADE_FAR,distanceToCamera);
        #endif
        tint=color;
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
  if (supportFade) material.uniforms.structureWeights = { value: supportVisibility };
  const points = new THREE.Points(geometry, material); points.frustumCulled = false; group.add(points);
  const haze = createGalaxyHaze({ seed, structures, supportVisibility }); group.add(haze);
  // Only these producers guarantee that an ID has the same sampling inputs
  // for this instance's fixed seed. Custom providers may change a shape at
  // the same ID; they retain the uncached path and public snapshot contract.
  const cacheSamples = descriptorProvider === describeMacro || descriptorProvider === describeCosmicStructures;
  const sampleCache = new Map();
  let sampleGeneration = 0;
  let lastCell = '', lastMacro = '', lastCount = 0, lastQuality = 'auto', descriptors = [], samples = [], centers = [], disposed = false;
  let pending = null, failure = null;
  let currentIndex = -1, currentCell, key = '', macroKey = '';
  const hazeFrame = { centers: null, cameraPosition: null, camera: null, quality: 'auto', brightness: 1, home: false };
  const stats = { revision: structures ? 3 : COSMOS_VERSION, galaxies: 0, clusters: 0, nebulae: 0, structures: 0, particles: 0, maxParticles: (structures ? COSMIC_MAX_STRUCTURES * PARTICLES_PER_GALAXY : MAX_COSMOS_PARTICLES), batches: 0, visible: true, rebuilds: 0,
    sampleCacheLimit: cacheSamples ? SAMPLE_CACHE_BYTE_LIMIT : 0, sampleCacheBytes: 0, sampleCacheHits: 0, sampleGenerations: 0 };
  Object.defineProperty(group.userData, 'stats', { get: () => ({ ...stats, sampleCacheEntries: sampleCache.size }) });
  const abortError = message => new DOMException(message, 'AbortError');
  const countFor = quality => COSMOS_QUALITY_COUNTS[quality] ?? COSMOS_QUALITY_COUNTS.auto;
  const macroFor = cell => `${Math.floor(cell.x / gridCells)},${Math.floor(cell.y / gridCells)},${Math.floor(cell.z / gridCells)}`;
  const cellKey = cell => `${cell.x},${cell.y},${cell.z}`;
  const sampleBytes = sample => sample.positions.byteLength + sample.colors.byteLength + sample.sizes.byteLength;
  Object.assign(stats, { activeSampleBytes: 0, activeGeometryBytes: 0, pendingSampleBytes: 0, pendingGeometryBytes: 0,
    preparationStage: 'idle', preparationSlices: 0, preparationWorkMs: 0, maxPreparationSliceMs: 0,
    preparationTotalMs: 0, peakPendingSampleBytes: 0, peakPendingGeometryBytes: 0, requestMs: 0, hazePublishMs: 0, publishMs: 0 });

  function settleJob(job, error, succeeded = false) {
    if (job.timer !== null) { clearTimeout(job.timer); job.timer = null; }
    for (const waiter of job.waiters) {
      if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (succeeded) waiter.resolve(); else waiter.reject(error);
    }
    job.waiters.length = 0;
  }
  function cancelPreparation(reason = abortError('Cosmos preparation cancelled')) {
    if (!pending) return;
    const job = pending; pending = null;
    stats.pendingSampleBytes = stats.pendingGeometryBytes = 0; stats.preparationStage = 'idle';
    settleJob(job, reason);
  }
  function cacheSample(job, descriptor, sample) {
    if (!job.cacheBatch) return;
    const bytes = sampleBytes(sample);
    for (const [oldKey, old] of sampleCache) {
      if (stats.sampleCacheBytes + bytes <= SAMPLE_CACHE_BYTE_LIMIT) break;
      if (old.generation === job.generation) continue;
      sampleCache.delete(oldKey); stats.sampleCacheBytes -= old.bytes;
    }
    sampleCache.set(`${job.count}:${descriptor.id}`, { sample, bytes, generation: job.generation });
    stats.sampleCacheBytes += bytes;
  }
  function requestPopulation({ sectorIndex, quality = 'auto' }) {
    if (disposed) throw new Error('Cosmos has been disposed');
    failure = null;
    const start = performance.now();
    const cell = decodeCell(sectorIndex), macro = macroFor(cell), count = countFor(quality);
    if (pending && pending.macro === macro && pending.count === count) {
      pending.explicit = true;
      return pending;
    }
    cancelPreparation(abortError('Cosmos preparation superseded'));
    if (lastMacro === macro && lastCount === count) return null;
    const next = loadedMacros(sectorIndex, seed, catalogueOptions);
    if (supportFade && next.length > COSMIC_MAX_STRUCTURES) throw new RangeError('Cosmos catalogue exceeds its declared structure capacity');
    const cacheBatch = cacheSamples && next.length * count * 7 * Float32Array.BYTES_PER_ELEMENT <= SAMPLE_CACHE_BYTE_LIMIT;
    const job = { macro, count, quality, descriptors: next, samples: new Array(next.length).fill(null),
      cell, cellKey: cellKey(cell), centers: null, cacheBatch, generation: ++sampleGeneration, explicit: true,
      stage: 'samples', sampleIndex: 0, sampler: null, pointCount: next.length * count,
      sampleBytes: 0, geometryBytes: 0, attributes: null, descriptorIndex: 0, pointIndex: 0, pointOffset: 0,
      createdAt: performance.now(), slices: 0, workMs: 0, maxSliceMs: 0,
      timer: null, waiters: [], prepareFrame: null };
    // Pin every incoming hit before any miss can evict a later descriptor.
    if (cacheBatch) for (const descriptor of next) {
      const entry = sampleCache.get(`${count}:${descriptor.id}`);
      if (entry) entry.generation = job.generation;
    }
    if (cacheBatch) for (let i = 0; i < next.length; i++) {
      const sampleKey = `${count}:${next[i].id}`, entry = sampleCache.get(sampleKey);
      if (!entry) continue;
      job.samples[i] = entry.sample; job.sampleBytes += entry.bytes; stats.sampleCacheHits++;
    }
    pending = job;
    stats.preparationStage = job.stage; stats.pendingSampleBytes = job.sampleBytes;
    stats.peakPendingSampleBytes = job.sampleBytes; stats.peakPendingGeometryBytes = 0;
    stats.requestMs = performance.now() - start;
    stats.pendingGeometryBytes = 0; stats.preparationSlices = stats.preparationWorkMs = stats.maxPreparationSliceMs = 0;
    return job;
  }
  function retargetOrigin(job, cell, nextKey) {
    if (job.cellKey === nextKey) return;
    job.cell = cell; job.cellKey = nextKey;
    if (job.stage === 'positions' || job.stage === 'ready') {
      job.centers = null; job.stage = 'positions';
      job.descriptorIndex = job.pointIndex = job.pointOffset = 0;
    }
  }
  function advanceBatch(job, budgetMs) {
    if (job.stage === 'ready') return;
    const start = performance.now(), deadline = start + budgetMs;
    // A complete point is the indivisible unit. Time is checked after each 64
    // points, including assembly; no descriptor-wide copy hides inside a slice.
    do {
      if (job.stage === 'samples') {
        while (job.sampleIndex < job.descriptors.length) {
          const descriptor = job.descriptors[job.sampleIndex];
          if (!job.samples[job.sampleIndex]) break;
          if (job.cacheBatch) {
            // Touch hits when their original descriptor order is consumed,
            // interleaved with misses just as in the synchronous LRU.
            const sampleKey = `${job.count}:${descriptor.id}`, entry = sampleCache.get(sampleKey);
            sampleCache.delete(sampleKey); sampleCache.set(sampleKey, entry);
          }
          job.sampleIndex++;
        }
        if (job.sampleIndex === job.descriptors.length) { job.stage = 'attributes'; continue; }
        if (!job.sampler) {
          job.sampler = createLegacyGalaxySampler(job.descriptors[job.sampleIndex], job.count);
          job.sampleBytes += job.count * 7 * Float32Array.BYTES_PER_ELEMENT;
        }
        if (job.sampler.step(64)) {
          const sample = job.sampler.result;
          job.samples[job.sampleIndex] = sample;
          cacheSample(job, job.descriptors[job.sampleIndex], sample);
          stats.sampleGenerations++; job.sampler = null; job.sampleIndex++;
        }
      } else if (job.stage === 'attributes') {
        if (!job.attributes) {
          const n = job.pointCount;
          job.attributes = {
            position: new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage),
            color: new THREE.BufferAttribute(new Float32Array(n * 3), 3),
            pointRadius: new THREE.BufferAttribute(new Float32Array(n), 1),
          };
          if (supportFade) job.attributes.descriptorIndex = new THREE.BufferAttribute(new Float32Array(n), 1);
          job.geometryBytes = n * (supportFade ? 8 : 7) * Float32Array.BYTES_PER_ELEMENT;
          continue;
        }
        if (job.descriptorIndex === job.samples.length) {
          job.stage = 'positions'; job.descriptorIndex = job.pointIndex = job.pointOffset = 0; continue;
        }
        const sample = job.samples[job.descriptorIndex], end = Math.min(job.count, job.pointIndex + 64);
        const colors = job.attributes.color.array, sizes = job.attributes.pointRadius.array;
        const indices = job.attributes.descriptorIndex?.array;
        for (let i = job.pointIndex; i < end; i++) {
          const out = job.pointOffset + i, out3 = out * 3, in3 = i * 3;
          colors[out3] = sample.colors[in3]; colors[out3 + 1] = sample.colors[in3 + 1]; colors[out3 + 2] = sample.colors[in3 + 2];
          sizes[out] = sample.sizes[i];
          if (indices) indices[out] = job.descriptorIndex;
        }
        job.pointIndex = end;
        if (end === job.count) { job.pointOffset += job.count; job.descriptorIndex++; job.pointIndex = 0; }
      } else if (job.stage === 'positions') {
        if (!job.centers) job.centers = job.descriptors.map(descriptor => galaxyRelativeCenter(descriptor, job.cell, gridCells));
        if (job.descriptorIndex === job.samples.length) { job.stage = 'ready'; break; }
        const sample = job.samples[job.descriptorIndex], center = job.centers[job.descriptorIndex];
        const end = Math.min(job.count, job.pointIndex + 64), positions = job.attributes.position.array;
        for (let i = job.pointIndex * 3; i < end * 3; i++) positions[job.pointOffset * 3 + i] = sample.positions[i] + center[i % 3];
        job.pointIndex = end;
        if (end === job.count) { job.pointOffset += job.count; job.descriptorIndex++; job.pointIndex = 0; }
      }
    } while (performance.now() < deadline);
    const elapsed = performance.now() - start;
    job.slices++; job.workMs += elapsed; job.maxSliceMs = Math.max(job.maxSliceMs, elapsed);
    stats.preparationSlices = job.slices; stats.preparationWorkMs = job.workMs; stats.maxPreparationSliceMs = job.maxSliceMs;
    stats.preparationStage = job.stage; stats.pendingSampleBytes = job.sampleBytes; stats.pendingGeometryBytes = job.geometryBytes;
    stats.peakPendingSampleBytes = Math.max(stats.peakPendingSampleBytes, job.sampleBytes);
    stats.peakPendingGeometryBytes = Math.max(stats.peakPendingGeometryBytes, job.geometryBytes);
  }
  function failPreparation(error) {
    if (pending) failure = { macro: pending.macro, count: pending.count, error };
    cancelPreparation(error);
  }
  function advancePreparation(budgetMs = preparationBudgetMs) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError('Invalid cosmos preparation budget');
    if (disposed || !pending) return;
    try { advanceBatch(pending, budgetMs); }
    catch (error) { failPreparation(error); throw error; }
  }
  function updateCounts() {
    stats.galaxies = stats.clusters = stats.nebulae = 0; stats.structures = descriptors.length;
    for (const descriptor of descriptors) {
      if (descriptor.kind === 'cluster') stats.clusters++;
      else if (descriptor.kind === 'nebula') stats.nebulae++;
      else stats.galaxies++;
    }
  }
  function publish(job) {
    const start = performance.now(), hazeStart = start;
    // Haze creation is deliberately still measured at its existing owner. It
    // is not included in the sliced legacy sampler/assembly budget.
    if (job.macro !== lastMacro) haze.userData.setDescriptors(job.descriptors);
    stats.hazePublishMs = performance.now() - hazeStart;
    geometry.dispose();
    for (const name in job.attributes) geometry.setAttribute(name, job.attributes[name]);
    geometry.setDrawRange(0, job.pointCount);
    descriptors = job.descriptors; samples = job.samples; centers = job.centers;
    lastMacro = job.macro; lastCount = job.count; lastQuality = job.quality; lastCell = job.cellKey;
    stats.activeSampleBytes = job.sampleBytes; stats.activeGeometryBytes = job.geometryBytes;
    stats.pendingSampleBytes = stats.pendingGeometryBytes = 0; stats.preparationStage = 'idle';
    stats.preparationTotalMs = performance.now() - job.createdAt;
    updateCounts(); stats.rebuilds++; pending = null;
    stats.publishMs = performance.now() - start;
  }
  function isReady({ sectorIndex, quality = 'auto' }) {
    return !disposed && currentIndex === sectorIndex && lastCell === key && lastMacro === macroKey && lastCount === countFor(quality);
  }
  function prepare(frame, { signal } = {}) {
    if (disposed) return Promise.reject(new Error('Cosmos has been disposed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (pending?.prepareFrame && pending.prepareFrame.sectorIndex !== frame.sectorIndex) cancelPreparation(abortError('Cosmos preparation superseded'));
    let job;
    try { job = requestPopulation(frame); }
    catch (error) { return Promise.reject(error); }
    if (!job) { group.userData.update(frame); return Promise.resolve(); }
    const promise = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => { if (pending === job) cancelPreparation(signal.reason); };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      job.waiters.push(waiter);
    });
    if (job.prepareFrame) return promise;
    job.prepareFrame = { ...frame, cameraPosition: frame.cameraPosition.slice() };
    const tick = () => {
      job.timer = null;
      if (disposed || pending !== job) return;
      try { group.userData.update(job.prepareFrame); }
      catch (error) { if (pending === job) cancelPreparation(error); else settleJob(job, error); return; }
      if (pending === job) job.timer = setTimeout(tick, 0);
    };
    // Real host tasks, not a microtask loop: loading must leave input/paint a turn.
    job.timer = setTimeout(tick, 0);
    return promise;
  }
  Object.assign(group.userData, { requestPopulation(frame) { requestPopulation(frame); }, advancePreparation, cancelPreparation, prepare, isReady });
  group.userData.update = ({ sectorIndex, cameraPosition, camera = null, quality = 'auto', quiet = 0, home = false, viewportHeight = 1, pixelRatio = 1 }) => {
    if (disposed) return;
    if (sectorIndex !== currentIndex) {
      currentCell = decodeCell(sectorIndex); currentIndex = sectorIndex;
      key = cellKey(currentCell); macroKey = macroFor(currentCell);
    }
    const cell = currentCell, count = countFor(quality);
    let publishedJob = null;
    if (macroKey !== lastMacro || count !== lastCount) {
      if (!pending || pending.macro !== macroKey || pending.count !== count) {
        if (incremental && failure && failure.macro === macroKey && failure.count === count) throw failure.error;
        requestPopulation({ sectorIndex, quality }); pending.explicit = false;
      }
    } else if (pending && !pending.explicit) cancelPreparation(abortError('Cosmos preparation no longer requested'));
    if (pending) {
      if (pending.macro === macroKey && pending.count === count) retargetOrigin(pending, cell, key);
      try {
        advanceBatch(pending, incremental ? preparationBudgetMs : Infinity);
        if (pending.stage === 'ready' && pending.macro === macroKey && pending.count === count) {
          publishedJob = pending; publish(pending);
        }
      } catch (error) { failPreparation(error); throw error; }
    }
    if (lastCount && key !== lastCell) {
      // Rebase from the retained local templates, never from rounded combined
      // positions. Pending assembly has its own origin and cannot alter active.
      for (let j = 0; j < descriptors.length; j++) {
        const descriptor = descriptors[j], center = centers[j];
        const gridSize = gridCells * CELL_SIZE;
        for (let axis = 0; axis < 3; axis++) center[axis] = wrap(descriptor.macroCell[AXES[axis]] * gridSize + (gridCells - 1) * CELL_SIZE / 2 + descriptor.offset[axis] - cell[AXES[axis]] * CELL_SIZE, WORLD_SIZE);
      }
      const positions = geometry.attributes.position.array;
      let pointOffset = 0;
      for (let j = 0; j < descriptors.length; j++) {
        const sample = samples[j], center = centers[j];
        for (let i = 0; i < lastCount * 3; i++) positions[pointOffset * 3 + i] = sample.positions[i] + center[i % 3];
        pointOffset += lastCount;
      }
      geometry.attributes.position.needsUpdate = true; lastCell = key; stats.rebuilds++;
    }
    if (supportFade) {
      for (let i = 0; i < descriptors.length; i++) {
        const center = centers[i];
        const distance = Math.hypot(center[0] - cameraPosition[0], center[1] - cameraPosition[1], center[2] - cameraPosition[2]);
        supportVisibility[i] = 1 - smoothstep(COSMIC_VIEW_FADE_START, COSMIC_VIEW_FAR, Math.max(0, distance - descriptors[i].radius));
      }
    }
    material.uniforms.cameraLocal.value.fromArray(cameraPosition);
    material.uniforms.pixelHeight.value = Math.max(1, viewportHeight * pixelRatio);
    material.uniforms.sampleWeight.value = COSMOS_QUALITY_COUNTS.auto / (lastCount || count);
    material.uniforms.brightness.value = 1 - Math.max(0, Math.min(1, quiet)) * .52;
    group.visible = !home && lastCount > 0; stats.visible = group.visible;
    hazeFrame.centers = centers; hazeFrame.cameraPosition = cameraPosition; hazeFrame.quality = lastQuality;
    hazeFrame.camera = camera;
    hazeFrame.brightness = material.uniforms.brightness.value; hazeFrame.home = home;
    const volumes = haze.userData.update(hazeFrame);
    const activePoints = lastCount ? geometry.attributes.position.count : 0;
    stats.particles = activePoints;
    stats.batches = home ? 0 : Number(activePoints > 0) + volumes;
    if (publishedJob) settleJob(publishedJob, null, true);
  };
  group.userData.dispose = () => { if (disposed) return; disposed = true; cancelPreparation(abortError('Cosmos disposed')); failure = null; geometry.dispose(); for (const name in geometry.attributes) geometry.deleteAttribute(name); material.dispose(); haze.userData.dispose(); if (supportFade) material.uniforms.structureWeights.value = null; supportVisibility = null; group.clear(); samples = []; descriptors = []; centers = []; sampleCache.clear(); stats.sampleCacheBytes = stats.activeSampleBytes = stats.activeGeometryBytes = 0; stats.visible = false; stats.batches = 0; };
  return group;
}
