import { CELL_SIZE, decodeCell, encodeCell, wrapCell as wrap } from './coordinates.js';
import { evaluateBodyState } from './orbits.js';

// Legacy softened attraction or explicit mu in consistent caller-defined units.
// Only the caller-supplied spheres contribute to the field.
export const MAX_GRAVITY = 120;
export const GRAVITY_CACHE_LIMIT = 128;
const profile = {
  planet: { strength: 26, scale: 1, influence: 14500 },
  star: { strength: 75, scale: 2.5, influence: 16000 },
  'black-hole': { strength: 180, scale: 3, influence: 18000 },
};
const smooth = t => t * t * (3 - 2 * t);

/** Finite-range gravity: explicit mu uses inverse square outside the surface.
 * Legacy descriptors retain their original softened world-unit field. */
export function bodyGravity(body, position) {
  const settings = Object.hasOwn(profile, body.type) ? profile[body.type] : profile.planet;
  const delta = body.position.map((n, i) => n - position[i]);
  const distance = Math.hypot(...delta);
  const effectiveRadius = Math.max(80, body.radius * settings.scale);
  const influence = body.influence ?? settings.influence;
  if (!distance || distance >= influence) return [0, 0, 0];
  const taper = distance <= influence * .65 ? 1 : smooth((influence - distance) / (influence * .35));
  if (Number.isFinite(body.mu) && body.mu > 0) {
    const radius = Math.max(Number.EPSILON, body.radius);
    const magnitude = (body.mu / Math.max(distance, radius)) / Math.max(distance, radius) * taper;
    if (!Number.isFinite(magnitude)) throw new RangeError('Gravity acceleration is outside the representable numeric range');
    return delta.map(n => n / distance * magnitude);
  }
  const softening = effectiveRadius * .8;
  const force = settings.strength * effectiveRadius ** 2 / (distance ** 2 + softening ** 2) ** 1.5 * taper;
  return delta.map(n => n * force);
}

/** Cache generated descriptors and the 27-cell neighborhood until a rebase. */
export function createGravityField({ world, sector = world && (index => world.sector(index)) } = {}) {
  if (typeof sector !== 'function') throw new TypeError('A sector sphere provider is required');
  const cache = new Map();
  let neighborhoodIndex = null, sources = [], revision = world?.revision;
  function refresh() {
    if (revision === world?.revision) return;
    revision = world?.revision; cache.clear(); neighborhoodIndex = null; sources = [];
  }
  const descriptors = index => {
    if (cache.has(index)) return cache.get(index);
    const bodies = sector(index).map(body => ({ sectorIndex: index, ...body,
      position: [...body.position], ...(body.orbit == null ? {} : { orbit: { ...body.orbit } }) }));
    cache.set(index, bodies);
    if (cache.size > GRAVITY_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return bodies;
  };
  return {
    sample(sectorIndex, position, timeSeconds = 0) {
      if (!Number.isFinite(timeSeconds)) throw new TypeError('timeSeconds must be finite');
      refresh();
      if (neighborhoodIndex !== sectorIndex) {
        const origin = decodeCell(sectorIndex);
        sources = [];
        for (let x = -1; x <= 1; x += 1) for (let y = -1; y <= 1; y += 1) for (let z = -1; z <= 1; z += 1) {
          const index = encodeCell({ x: wrap(origin.x + x), y: wrap(origin.y + y), z: wrap(origin.z + z) });
          for (const body of descriptors(index)) sources.push({ body, offset: [x, y, z].map(n => n * CELL_SIZE) });
        }
        neighborhoodIndex = sectorIndex;
      }
      let acceleration = [0, 0, 0], strongest = 0, source = null;
      for (const entry of sources) {
        const state = evaluateBodyState(entry.body, timeSeconds);
        const body = { ...entry.body, position: state.position.map((n, i) => n + entry.offset[i]) };
        const pull = bodyGravity(body, position), strength = Math.hypot(...pull);
        acceleration = acceleration.map((n, i) => n + pull[i]);
        if (!acceleration.every(Number.isFinite)) throw new RangeError('Summed gravity is outside the representable numeric range');
        if (strength > strongest) {
          strongest = strength;
          source = { id: body.id, name: body.name, type: body.type, radius: body.radius,
            distance: Math.hypot(...body.position.map((n, i) => n - position[i])), sectorIndex: body.sectorIndex };
        }
      }
      const total = Math.hypot(...acceleration);
      if (total > MAX_GRAVITY) {
        // Normalize before scaling so a large finite mu cannot overflow n*cap.
        const largest = Math.max(...acceleration.map(Math.abs));
        const normalized = acceleration.map(n => n / largest), norm = Math.hypot(...normalized);
        acceleration = normalized.map(n => n / norm * MAX_GRAVITY);
      }
      return { acceleration, magnitude: Math.hypot(...acceleration), source };
    },
    get cacheSize() { return cache.size; },
  };
}
