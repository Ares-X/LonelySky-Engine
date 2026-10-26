import { CELL_SIZE, decodeCell } from './coordinates.js';
import { hashSeed, randomFromSeed } from './random.js';
import { bodyCollisionRadius } from './collision.js';

/** Increment when deterministic generation rules change. */
export const GENERATOR_VERSION = 1;
const DEFAULT_PALETTE = { colorA: 0x607fa5, colorB: 0xd4b68e, starColor: 0xffe3bd };
const KINDS = ['gas', 'ocean', 'ice', 'rock', 'lava'];
const MORPHOLOGIES = ['columns', 'halo', 'knots', 'rift', 'shell', 'stream', 'wisps'];
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));

/** Project rendering data into independent neutral spheres, preserving body IDs.
 * Ring geometry participates through a conservative spherical clearance.
 */
export function sectorBodies(descriptor) {
  const sphere = (body, type) => ({ id: body.id, type, radius: body.radius,
    position: [...body.position], ...(type === 'planet' && body.rings
      ? { collisionClearance: body.radius * 2.26 } : {}) });
  return [...descriptor.planets.map(body => sphere(body, 'planet')),
    ...descriptor.stars.map(body => sphere(body, 'star')),
    ...(descriptor.blackHole ? [sphere(descriptor.blackHole, 'black-hole')] : [])];
}

/** A dependency-free universe. Each sector has its own versioned random stream.
 * Coordinates are local to its centered cell. Sector zero provides a visible
 * ringed planet and light source when density > 0; density 0 has no local
 * bodies or nebula. Distant renderer backgrounds are outside this setting.
 * Descriptors are fresh JSON data on every call; the universe rules are fixed.
 */
export function createUniverse(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Universe options must be an object');
  const { seed = 'lonelysky', density = .65, palette = DEFAULT_PALETTE } = options;
  if (typeof seed !== 'string') throw new TypeError('Universe seed must be a string');
  if (!Number.isFinite(density) || density < 0 || density > 1) throw new RangeError('Density must be a finite number from 0 to 1');
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)
    || !['colorA', 'colorB', 'starColor'].every(key => Number.isInteger(palette[key]) && palette[key] >= 0 && palette[key] <= 0xffffff)) {
    throw new TypeError('Palette must contain colorA, colorB and starColor unsigned 24-bit colors');
  }
  // Copy caller-owned input before capturing it in the generator closure.
  const colors = { colorA: palette.colorA, colorB: palette.colorB, starColor: palette.starColor };
  function getSector(index) {
    const cell = decodeCell(index);
    const sectorSeed = hashSeed(JSON.stringify([GENERATOR_VERSION, seed, index]));
    const random = randomFromSeed(sectorSeed);
    const between = (min, max) => min + random() * (max - min);
    const pick = values => values[Math.floor(random() * values.length)];
    const id = `sector-${index}-${sectorSeed.toString(36)}`;
    const composition = density === 0 ? 'empty' : index === 0 ? 'rings'
      : random() > density ? 'empty' : pick(['planets', 'star', 'binary', 'nebula', 'black-hole', 'planets']);
    const descriptor = { index, id, cell, planets: [], stars: [],
      nebula: { density: composition === 'empty' ? 0 : (composition === 'nebula' ? .85 : .12) * density,
        colorA: colors.colorA, colorB: colors.colorB, tilt: between(-1, 1) },
      region: { morphology: pick(MORPHOLOGIES),
        scale: between(.7, 1.5), turbulence: between(.2, .8), filamentCount: 3 + Math.floor(random() * 5) },
      composition, generatorVersion: GENERATOR_VERSION };
    const obstacles = [];
    function add(body, type, position) {
      const sphere = { ...body, type, collisionClearance: body.rings ? body.radius * 2.26 : undefined };
      const clearance = bodyCollisionRadius(sphere, type);
      // Bounded rejection keeps every envelope within its cell, separated from
      // other envelopes and a clear arrival sphere around the cell origin.
      for (let attempt = 0; attempt < (position ? 1 : 24); attempt += 1) {
        const candidate = position ?? [between(-6500, 6500), between(-6500, 6500), between(-6500, 6500)];
        if (candidate.some(n => Math.abs(n) + clearance >= CELL_SIZE / 2)
          || distance(candidate, [0, 0, 0]) <= clearance + 1600
          || obstacles.some(other => distance(candidate, other.position) <= clearance + other.clearance + 300)) continue;
        body.position = [...candidate];
        obstacles.push({ position: body.position, clearance });
        if (type === 'planet') descriptor.planets.push(body);
        else if (type === 'star') descriptor.stars.push(body);
        else descriptor.blackHole = body;
        return;
      }
    }
    function planet(kind = pick(KINDS), rings = kind === 'gas' && random() < .5, position) {
      add({ id: `${id}-planet-${descriptor.planets.length}`, kind, seed: Math.floor(random() * 4294967296),
        colorA: colors.colorA, colorB: colors.colorB, radius: between(550, 1100),
        rings, ringTilt: between(-.7, .7), ringColor: colors.colorB, proceduralSurface: true }, 'planet', position);
    }
    function star(position) {
      add({ id: `${id}-star-${descriptor.stars.length}`, type: 'star', color: colors.starColor,
        radius: between(220, 430) }, 'star', position);
    }
    if (composition === 'rings') {
      planet('gas', true, [between(1000, 1600), between(-800, -300), between(-5300, -4800)]);
      star([between(-5500, -4800), between(2800, 3500), between(-4200, -3600)]);
    } else if (composition === 'planets') {
      planet();
      if (random() < .45) planet();
      if (random() < .5) star();
    } else if (composition === 'star' || composition === 'binary') {
      star();
      if (composition === 'binary') star();
    } else if (composition === 'black-hole') {
      add({ id: `${id}-hole`, radius: between(260, 500), seed: sectorSeed }, 'black-hole');
    }
    return descriptor;
  }
  return Object.freeze({ seed, density, revision: 0, getSector, sector: index => sectorBodies(getSector(index)) });
}
