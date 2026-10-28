import { CELL_SIZE, decodeCell } from './coordinates.js';
import { randomFromSeed } from './random.js';

/** V3 scenery has its own seed stream; addresses and the local body stream stay intact. */
export const COSMIC_STRUCTURE_REVISION = 3;
export const COSMIC_GRID_CELLS = 4096;
export const COSMIC_GRID_SIZE = COSMIC_GRID_CELLS * CELL_SIZE;
export const COSMIC_VIEW_FADE_START = 125000000;
export const COSMIC_VIEW_FAR = 150000000;
export const COSMIC_MAX_RADIUS = 42000000;
export const COSMIC_MAX_STRUCTURES = 27 * 4;
export const COSMIC_THEMES = Object.freeze(['silver-dust', 'blue-nursery', 'old-gold', 'tidal-islands', 'dark-rift']);
const AXES = ['x', 'y', 'z'];
const WORLD_SIZE = 32768 * CELL_SIZE;
const TAU = Math.PI * 2;
export const wrapCosmicDistance = value => ((value + WORLD_SIZE / 2) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE - WORLD_SIZE / 2;
const wrapGrid = value => ((value + 4) % 8 + 8) % 8 - 4;

/** Monotone radial drawing map, shared by points, volumes and large solids.
 * Physical simulation units never change. Below 160k drawing is unmodified.
 */
export function cosmicDrawDistance(distance) {
  return distance <= 160000 ? distance : 160000 + 40000 * (distance - 160000) / (distance - 160000 + 1000000);
}
export function cosmicTrueDistance(distance) {
  return distance <= 160000 ? distance : 160000 + 1000000 * (distance - 160000) / (200000 - distance);
}

/** GLSL counterpart of the CPU radial map, injected by every V3 renderer. */
export const COSMIC_DEPTH_GLSL = /* glsl */`
  float cosmicDrawDistance(float distance){
    return distance<=160000.?distance:160000.+40000.*(distance-160000.)/(distance-160000.+1000000.);
  }
  float cosmicTrueDistance(float distance){
    return distance<=160000.?distance:160000.+1000000.*(distance-160000.)/(200000.-distance);
  }
`;

// Euler XYZ, the same convention used by the renderer. Creation-time only.
function rotate(point, orientation) {
  let [x, y, z] = point;
  const [a, b, c] = orientation, cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b), cz = Math.cos(c), sz = Math.sin(c);
  const rx = cz * x - sz * y, ry = sz * x + cz * y;
  x = cy * rx + sy * z; z = -sy * rx + cy * z;
  return [x, cx * ry - sx * z, sx * ry + cx * z];
}
function freezeDescriptor(value) {
  Object.freeze(value.offset); Object.freeze(value.orientation); Object.freeze(value.macroCell);
  return Object.freeze(value);
}

/** One sparse parent galaxy per 2³ grid block, plus nested child structures.
 * The catalogue is a 3D torus, not a screen arrangement or a solid shell.
 */
export function describeCosmicStructures(coordinate, seed = 'lonelysky') {
  if (typeof seed !== 'string' || !AXES.every(axis => Number.isSafeInteger(coordinate[axis]))) throw new TypeError('Invalid cosmic grid coordinate or seed');
  const macroCell = Object.fromEntries(AXES.map(axis => [axis, wrapGrid(coordinate[axis])]));
  const block = AXES.map(axis => Math.floor(macroCell[axis] / 2));
  const select = randomFromSeed(`${seed}:cosmic-structures-v3:block:${block}`);
  const candidate = AXES.map(() => Math.floor(select() * 2));
  if (!AXES.every((axis, i) => macroCell[axis] - block[i] * 2 === candidate[i])) return [];
  // Fixed large voids and a non-uniform population; never fill empty space to
  // satisfy a changing nearest-N render list.
  const density = .42 + .3 * Math.sin((block[0] + block[2]) * Math.PI / 2 + .7) ** 2;
  if (select() > density) return [];
  const id = `cosmic-v3:${macroCell.x},${macroCell.y},${macroCell.z}`;
  const random = randomFromSeed(`${seed}:${id}`), roll = random();
  const morphology = roll < .58 ? 'spiral' : roll < .82 ? 'elliptical' : 'irregular';
  const theme = COSMIC_THEMES[Math.floor(random() * COSMIC_THEMES.length)];
  const radius = 20000000 + random() * 22000000;
  const orientation = [random() * TAU, Math.acos(random() * 2 - 1), random() * TAU];
  const galaxy = freezeDescriptor({ id, revision: 3, kind: 'galaxy', family: morphology, theme, seed: `${seed}:${id}`, gridCells: COSMIC_GRID_CELLS,
    macroCell, offset: AXES.map(() => (random() - .5) * COSMIC_GRID_SIZE * .12), orientation,
    morphology, radius, thickness: morphology === 'spiral' ? .045 + random() * .04 : morphology === 'elliptical' ? .6 + random() * .25 : .28,
    arms: 2 + Math.floor(random() * 3), pitch: .25 + random() * .14, bar: random() < .3, asymmetry: random(), population: density });
  const result = [galaxy];
  for (let i = 0; i < 3; i++) {
    const kind = i === 2 ? 'nebula' : 'cluster';
    const childRadius = kind === 'nebula' ? 5000000 + random() * 8000000 : 3000000 + random() * 4500000;
    const orbitRadius = Math.min(radius * (.35 + random() * .23), radius - childRadius * 1.05);
    const theta = i * TAU / 3 + random() * .7;
    const offset = rotate([Math.cos(theta) * orbitRadius, (random() - .5) * radius * .08, Math.sin(theta) * orbitRadius], orientation);
    result.push(freezeDescriptor({ ...galaxy, id: `${id}:${kind}-${i}`, parentId: id, kind, family: kind === 'cluster' ? (i === 0 ? 'globular' : 'open') : 'dust-complex',
      seed: `${galaxy.seed}:${kind}-${i}`, macroCell: { ...macroCell }, offset: offset.map((n, axis) => n + galaxy.offset[axis]), orientation: [...orientation],
      radius: childRadius, morphology: kind === 'cluster' ? (i === 0 ? 'elliptical' : 'irregular') : 'irregular',
      thickness: kind === 'cluster' ? .8 : .42, bar: false, asymmetry: random(), population: galaxy.population }));
  }
  return result;
}

export function cosmicStructureRelativeCenter(descriptor, cell, output = [0, 0, 0]) {
  const gridCells = descriptor.gridCells;
  for(let i=0;i<3;i++)output[i]=wrapCosmicDistance(descriptor.macroCell[AXES[i]] * gridCells * CELL_SIZE + (gridCells - 1) * CELL_SIZE / 2 + descriptor.offset[i] - cell[AXES[i]] * CELL_SIZE);
  return output;
}

/** Fixed 5³ neighborhood on the eight-cell torus. An omitted parent support is
 * at least (2.5 - .06) * GRID_SIZE - MAX_RADIUS - CELL_SIZE / 2 = 157.8748M
 * away, including a camera at its cell edge. Children stay inside their parent.
 * The 150M fade therefore ends before catalogue changes, including torus seams.
 */
export function loadedCosmicStructures(sectorIndex, seed = 'lonelysky') {
  const cell = decodeCell(sectorIndex), macro = AXES.map(axis => Math.floor(cell[axis] / COSMIC_GRID_CELLS));
  const result = [];
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    result.push(...describeCosmicStructures({ x: macro[0] + x, y: macro[1] + y, z: macro[2] + z }, seed));
  }
  return result;
}

/** Semantic region context for body generation. No game names or content. */
export function cosmicStructureContext({ sectorIndex, cameraPosition = [0, 0, 0], seed = 'lonelysky' }) {
  const cell = decodeCell(sectorIndex), macro = AXES.map(axis => Math.floor(cell[axis] / COSMIC_GRID_CELLS));
  let nearest = null, nearestMetric = 1;
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    const descriptors = describeCosmicStructures({ x: macro[0] + x, y: macro[1] + y, z: macro[2] + z }, seed);
    for (const descriptor of descriptors) {
      if (descriptor.kind !== 'galaxy') continue;
      const relative = cosmicStructureRelativeCenter(descriptor, cell).map((n, i) => n - cameraPosition[i]);
      // A parent context uses its support radius, so entities share the parent
      // theme through sparse arms and their interior black gaps as well.
      const metric = Math.hypot(...relative) / descriptor.radius;
      if (metric < nearestMetric) { nearestMetric = metric; nearest = descriptor; }
    }
  }
  return nearest ? { id: nearest.id, family: nearest.family, theme: nearest.theme } : null;
}
