import * as THREE from 'three';
import {CELL_SIZE, decodeCell, encodeCell, wrapCell} from './coordinates.js';
import {randomFromSeed} from './random.js';
import {loadedMacros, galaxyRelativeCenter} from './render/cosmos.js';
import {describeGalaxyAppearance} from './render/galaxy-appearance.js';

// Distant, artistic landmarks use their own stream. They never change a
// caller's planets, home anchors, collision bodies or saved addresses.
export const MEGASTRUCTURE_VERSION = 1;
export const LANDMARK_GRID_CELLS = 128;
export const LANDMARK_GRID_SIZE = LANDMARK_GRID_CELLS * CELL_SIZE;
const PERIOD = 32768 / LANDMARK_GRID_CELLS, WORLD_SIZE = 32768 * CELL_SIZE;
const AXES = ['x', 'y', 'z'];
const wrap = (n, size) => ((n + size / 2) % size + size) % size - size / 2;
const cache = new Map();
const smooth = (a, b, x) => {const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t);};

// Kind order is fixed here so population decisions have one authoritative owner.
// Even ring-friendly old populations leave more than four in five occupied anchors
// to natural-looking giant worlds and stars. Young regions contain no rings.
const KINDS = ['ring', 'gas-giant', 'dark-world', 'stellar-giant'];
export const LANDMARK_THEME_WEIGHTS = Object.freeze(Object.fromEntries(Object.entries({
  'grand-spiral': [7, 62, 17, 14], 'barred-spiral': [7, 60, 15, 18],
  'dust-disk': [18, 54, 22, 6], 'ancient-halo': [18, 8, 44, 30],
  'tidal-islands': [3, 34, 43, 20], 'stellar-nursery': [0, 40, 5, 55],
  'cold-void': [0, 0, 100, 0],
}).map(([theme, weights]) => [theme, Object.freeze(weights)])));

/** Actual finite macro search at the landmark anchor, never at its observer. */
function anchorContext(cell, offset, seed) {
  const sectorCell = Object.fromEntries(AXES.map((axis, i) => [axis, wrapCell(cell[i] * LANDMARK_GRID_CELLS + Math.floor((offset[i] + CELL_SIZE / 2) / CELL_SIZE))]));
  const position = offset.map(n => wrap(n, CELL_SIZE));
  const index = encodeCell(sectorCell);
  let nearest = null, nearestDistance = Infinity;
  for (const galaxy of loadedMacros(index, seed)) {
    const center = galaxyRelativeCenter(galaxy, sectorCell);
    const distance = Math.hypot(...center.map((n, i) => n - position[i]));
    if (distance > 520000) continue;
    if (distance < nearestDistance || (distance === nearestDistance && galaxy.id < nearest.id)) {
      nearest = galaxy; nearestDistance = distance;
    }
  }
  return nearest;
}

/** Artistic distant visual landmarks, not physics bodies or resized planets.
 * Each seeded anchor is mostly empty. Existing celestial generation is untouched.
 */
export function describeDistantLandmark(coordinate, seed = 'lonelysky') {
  if (typeof seed !== 'string' || !AXES.every(axis => Number.isSafeInteger(coordinate?.[axis]))) throw new TypeError('Invalid landmark coordinate or seed');
  const cell = AXES.map(axis => wrap(coordinate[axis], PERIOD));
  const key = `${seed}:distant-landmark-v${MEGASTRUCTURE_VERSION}:${cell}`;
  if (cache.has(key)) return cache.get(key);
  const random = randomFromSeed(`${key}:shape`);
  const offset = AXES.map(() => (random() - .5) * LANDMARK_GRID_SIZE * .06);
  // Reject most anchors before the macro lookup. Context-free space has an
  // additional occupancy reduction, retaining especially long dark intervals.
  const population = randomFromSeed(`${key}:population`);
  let descriptor = null;
  if (population() < .34) {
    const galaxy = anchorContext(cell, offset, seed);
    const family = galaxy ? describeGalaxyAppearance(galaxy).family : null;
    const theme = family ?? 'cold-void';
    if (galaxy || population() < .35) {
      const weights = LANDMARK_THEME_WEIGHTS[theme];
      let roll = population() * weights.reduce((sum, n) => sum + n, 0), selected = 0;
      while (selected < weights.length - 1 && (roll -= weights[selected]) >= 0) selected++;
      const kind = KINDS[selected];
      const orientation = [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2];
      const frame = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...orientation))).transpose().toArray();
      const old = theme === 'ancient-halo' || theme === 'dust-disk';
      const young = theme === 'stellar-nursery';
      const baseTint = kind === 'dark-world' ? [.23, .28, .34]
        : kind === 'stellar-giant' ? young ? [.56, .74, 1] : old ? [1, .43, .19] : [1, .77, .47]
          : old ? [.68, .57, .4] : young ? [.37, .62, .73] : [.51, .62, .61];
      const radii = kind === 'ring' ? [.17, .065] : kind === 'stellar-giant' ? [.15, .07] : [.16, .07];
      descriptor = Object.freeze({id: `distant-landmark-v1:${cell}`, revision: MEGASTRUCTURE_VERSION,
        kind, family, theme, galaxyId: galaxy?.id ?? null,
        cell: Object.freeze(Object.fromEntries(AXES.map((axis, i) => [axis, cell[i]]))),
        offset: Object.freeze(offset), frame: Object.freeze(frame),
        radius: LANDMARK_GRID_SIZE * (radii[0] + random() * radii[1]),
        halfWidth: .035 + random() * .03, thickness: .0045,
        phase: random() * Math.PI * 2, broken: random() < .35,
        light: Object.freeze(new THREE.Vector3(-.6 + random() * 1.2, .25 + random() * .6, kind === 'dark-world' ? -.9 : .4 + random() * .6).normalize().toArray()),
        tint: Object.freeze(baseTint.map(n => n * (.9 + random() * .1))),
        ringed: kind === 'gas-giant' && randomFromSeed(`${key}:rings`)() < .58,
      });
    }
  }
  cache.set(key, descriptor);
  if (cache.size > 128) cache.delete(cache.keys().next().value);
  return descriptor;
}

export function distantLandmarkCenter(descriptor, sectorIndex, cameraPosition = [0, 0, 0]) {
  const cell = decodeCell(sectorIndex);
  return AXES.map((axis, i) => wrap(descriptor.cell[axis] * LANDMARK_GRID_SIZE + descriptor.offset[i]
    - cell[axis] * CELL_SIZE - cameraPosition[i], WORLD_SIZE));
}

/** Strictly disjoint support, so there is no nearest-N swap or visible pop.
 * Centres are at least .94 grids apart; each support radius is only .44 grids.
 * A 3³ bounded neighbourhood covers every nonzero contributor, including seams.
 */
export function sampleDistantLandmark({sectorIndex, cameraPosition = [0, 0, 0], seed = 'lonelysky'}) {
  if (!Array.isArray(cameraPosition) || cameraPosition.length !== 3 || !cameraPosition.every(Number.isFinite)) throw new TypeError('Invalid landmark observer position');
  const cell = decodeCell(sectorIndex);
  const node = AXES.map((axis, i) => Math.round((cell[axis] + cameraPosition[i] / CELL_SIZE) / LANDMARK_GRID_CELLS));
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    const landmark = describeDistantLandmark({x: node[0] + x, y: node[1] + y, z: node[2] + z}, seed);
    if (!landmark) continue;
    const center = distantLandmarkCenter(landmark, sectorIndex, cameraPosition);
    const visibility = 1 - smooth(.35 * LANDMARK_GRID_SIZE, .44 * LANDMARK_GRID_SIZE, Math.hypot(...center));
    if (visibility > 0) return {...landmark, center, visibility};
  }
  return null;
}

/** Ordinary revisitable V2 address, not an alternate showcase scene. */
export function distantLandmarkAddress(landmark) {
  const distanceFactor = landmark.kind === 'ring' ? 1.14 : landmark.kind === 'stellar-giant' ? 1.55 : 1.18;
  const inverse = new THREE.Matrix3().fromArray(landmark.frame).transpose();
  const viewOffset = new THREE.Vector3(.12, .3, 1).normalize().multiplyScalar(landmark.radius * distanceFactor).applyMatrix3(inverse).toArray();
  // A grazing composition leaves the limb and surrounding darkness in view;
  // pointing at the centre of an enormous body would hide every scale cue.
  const aimOffset = new THREE.Vector3(landmark.kind === 'ring' ? .12 : .62, 0, 0)
    .multiplyScalar(landmark.radius).applyMatrix3(inverse).toArray();
  const center = AXES.map((axis, i) => landmark.cell[axis] * LANDMARK_GRID_SIZE + landmark.offset[i]);
  const position = center.map((n, i) => n + viewOffset[i]);
  const cell = Object.fromEntries(AXES.map((axis, i) => [axis, wrapCell(Math.floor((position[i] + CELL_SIZE / 2) / CELL_SIZE))]));
  return {sectorIndex: encodeCell(cell), position: position.map((n, i) => wrap(n - cell[AXES[i]] * CELL_SIZE, WORLD_SIZE)),
    target: center.map((n, i) => wrap(n + aimOffset[i] - cell[AXES[i]] * CELL_SIZE, WORLD_SIZE)),
    up: new THREE.Vector3(...(landmark.kind === 'ring' ? [1,.35,0] : [0,1,0])).normalize().applyMatrix3(inverse).toArray(), fov: 65};
}
