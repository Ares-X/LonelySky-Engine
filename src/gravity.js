import { CELL_SIZE, decodeCell, encodeCell, wrapCell as wrap } from './coordinates.js';
import { createBodyStateSampler } from './orbits.js';

// Legacy softened attraction or explicit mu in consistent caller-defined units.
// Only the caller-supplied spheres contribute to the field.
export const MAX_GRAVITY = 120;
export const GRAVITY_CACHE_LIMIT = 128;
const profile = {
  planet: { strength: 26, scale: 1, influence: 14500 },
  star: { strength: 75, scale: 2.5, influence: 16000 },
  'black-hole': { strength: 180, scale: 3, influence: 18000 },
};
const settingsFor = type => Object.hasOwn(profile, type) ? profile[type] : profile.planet;
const smooth = t => t * t * (3 - 2 * t);

/** Finite-range gravity: explicit mu uses inverse square outside the surface.
 * Legacy descriptors retain their original softened world-unit field. */
export function bodyGravity(body, position) {
  return bodyGravityInto(body, body.position, position, [0, 0, 0]);
}

function bodyGravityInto(body, center, position, out) {
  const settings = settingsFor(body.type);
  const dx = center[0] - position[0], dy = center[1] - position[1], dz = center[2] - position[2];
  const distance = Math.hypot(dx, dy, dz);
  const effectiveRadius = Math.max(80, body.radius * settings.scale);
  const influence = body.influence ?? settings.influence;
  if (!distance || distance >= influence) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  const taper = distance <= influence * .65 ? 1 : smooth((influence - distance) / (influence * .35));
  if (Number.isFinite(body.mu) && body.mu > 0) {
    const radius = Math.max(Number.EPSILON, body.radius);
    const magnitude = (body.mu / Math.max(distance, radius)) / Math.max(distance, radius) * taper;
    if (!Number.isFinite(magnitude)) throw new RangeError('Gravity acceleration is outside the representable numeric range');
    out[0] = dx / distance * magnitude; out[1] = dy / distance * magnitude; out[2] = dz / distance * magnitude;
  } else {
    const softening = effectiveRadius * .8;
    const force = settings.strength * effectiveRadius ** 2 / (distance ** 2 + softening ** 2) ** 1.5 * taper;
    out[0] = dx * force; out[1] = dy * force; out[2] = dz * force;
  }
  return out;
}

/** Cache generated descriptors and the 27-cell neighborhood until a rebase.
 * world.gravitySourcesInBounds may supply additional large-range spheres in
 * the calling sector's frame. Its candidates must cover the entire cell over
 * every orbital phase, so changing time never needs another spatial query.
 * sample.source identifies the strongest contributor. Its detached position is
 * in the sampled sector's local frame; velocity is evaluated at timeSeconds in
 * the same frame (zero for static bodies), including across wrapped cell seams. */
export function createGravityField({ world, sector = world && (index => world.sector(index)) } = {}) {
  if (typeof sector !== 'function') throw new TypeError('A sector sphere provider is required');
  const cache = new Map(), sampleStorage = new WeakMap();
  const state = { position: [0, 0, 0], velocity: [0, 0, 0], acceleration: [0, 0, 0] }, pull = [0, 0, 0];
  const queryBounds = { min: [-CELL_SIZE / 2, -CELL_SIZE / 2, -CELL_SIZE / 2], max: [CELL_SIZE / 2, CELL_SIZE / 2, CELL_SIZE / 2] };
  const extendedIds = new Set(), zeroOffset = [0, 0, 0];
  let neighborhoodIndex = null, sources = [], revision = world?.revision;
  function refresh() {
    if (revision === world?.revision) return;
    revision = world?.revision; cache.clear(); neighborhoodIndex = null; sources = [];
  }
  const descriptors = index => {
    if (cache.has(index)) return cache.get(index);
    const bodies = sector(index).map(body => {
      const descriptor = { sectorIndex: index, ...body, position: [...body.position],
        ...(body.orbit == null ? {} : { orbit: { ...body.orbit } }) };
      return { body: descriptor, sample: createBodyStateSampler(descriptor),
        influence: descriptor.influence ?? settingsFor(descriptor.type).influence };
    });
    cache.set(index, bodies);
    if (cache.size > GRAVITY_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return bodies;
  };
  function sourceRecord() {
    return { id: undefined, name: undefined, type: undefined, radius: 0, distance: 0,
      sectorIndex: 0, position: [0, 0, 0], velocity: [0, 0, 0] };
  }
  function sampleTo(sectorIndex, position, timeSeconds, out, source) {
    if (!Number.isFinite(timeSeconds)) throw new TypeError('timeSeconds must be finite');
    if (!Array.isArray(position) || position.length !== 3 || !Number.isFinite(position[0])
      || !Number.isFinite(position[1]) || !Number.isFinite(position[2])) throw new TypeError('Gravity position must be a finite three-dimensional vector');
    refresh();
    if (neighborhoodIndex !== sectorIndex) {
      const origin = decodeCell(sectorIndex);
      sources = [];
      extendedIds.clear();
      if (world?.gravitySourcesInBounds) {
        for (const body of world.gravitySourcesInBounds(sectorIndex, queryBounds)) {
          if (typeof body.id !== 'string' || !body.id.length) throw new TypeError('Gravity bounds sources require a stable string id');
          if (extendedIds.has(body.id)) continue;
          if (!(body.radius > 0) || !Number.isFinite(body.radius)
            || !(body.mu > 0) || !Number.isFinite(body.mu)
            || !(body.influence > 0) || !Number.isFinite(body.influence)) {
            throw new RangeError('Gravity bounds sources require positive finite radius, mu and influence');
          }
          const descriptor = { ...body, sectorIndex, position: [...body.position],
            ...(body.orbit == null ? {} : { orbit: { ...body.orbit } }) };
          sources.push({ body: descriptor, sample: createBodyStateSampler(descriptor), influence: descriptor.influence, offset: zeroOffset });
          extendedIds.add(body.id);
        }
      }
      for (let x = -1; x <= 1; x += 1) for (let y = -1; y <= 1; y += 1) for (let z = -1; z <= 1; z += 1) {
        const index = encodeCell({ x: wrap(origin.x + x), y: wrap(origin.y + y), z: wrap(origin.z + z) });
        for (const entry of descriptors(index)) {
          if (!extendedIds.has(entry.body.id)) sources.push({ ...entry, offset: [x * CELL_SIZE, y * CELL_SIZE, z * CELL_SIZE] });
        }
      }
      neighborhoodIndex = sectorIndex;
    }
    const acceleration = out.acceleration;
    acceleration[0] = 0; acceleration[1] = 0; acceleration[2] = 0;
    let strongest = 0;
    out.source = null;
    for (const entry of sources) {
      entry.sample(timeSeconds, state);
      for (let i = 0; i < 3; i++) state.position[i] += entry.offset[i];
      // A component outside the cutoff cannot contribute. Keep the exact norm
      // and force calculation for remaining sources; no squared-distance overflow.
      if (Math.abs(state.position[0] - position[0]) >= entry.influence
        || Math.abs(state.position[1] - position[1]) >= entry.influence
        || Math.abs(state.position[2] - position[2]) >= entry.influence) continue;
      bodyGravityInto(entry.body, state.position, position, pull);
      const strength = Math.hypot(pull[0], pull[1], pull[2]);
      for (let i = 0; i < 3; i++) {
        acceleration[i] += pull[i];
        if (!Number.isFinite(acceleration[i])) throw new RangeError('Summed gravity is outside the representable numeric range');
      }
      if (strength > strongest) {
        strongest = strength; out.source = source;
        const body = entry.body;
        source.id = body.id; source.name = body.name; source.type = body.type; source.radius = body.radius;
        source.distance = Math.hypot(state.position[0] - position[0], state.position[1] - position[1], state.position[2] - position[2]);
        source.sectorIndex = body.sectorIndex;
        for (let i = 0; i < 3; i++) { source.position[i] = state.position[i]; source.velocity[i] = state.velocity[i]; }
      }
    }
    const total = Math.hypot(acceleration[0], acceleration[1], acceleration[2]);
    if (total > MAX_GRAVITY) {
      // Normalize before scaling so a large finite mu cannot overflow n*cap.
      const largest = Math.max(Math.abs(acceleration[0]), Math.abs(acceleration[1]), Math.abs(acceleration[2]));
      const x = acceleration[0] / largest, y = acceleration[1] / largest, z = acceleration[2] / largest;
      const norm = Math.hypot(x, y, z);
      acceleration[0] = x / norm * MAX_GRAVITY; acceleration[1] = y / norm * MAX_GRAVITY; acceleration[2] = z / norm * MAX_GRAVITY;
    }
    out.magnitude = Math.hypot(acceleration[0], acceleration[1], acceleration[2]);
    return out;
  }
  return {
    sample(sectorIndex, position, timeSeconds = 0) {
      return sampleTo(sectorIndex, position, timeSeconds, { acceleration: [0, 0, 0], magnitude: 0, source: null }, sourceRecord());
    },
    /** Allocate one reusable output per consumer. sampleInto overwrites its
     * vectors/source on the next call; ordinary sample remains a snapshot. */
    createSample() {
      const out = { acceleration: [0, 0, 0], magnitude: 0, source: null };
      sampleStorage.set(out, sourceRecord());
      return out;
    },
    sampleInto(sectorIndex, position, timeSeconds, out) {
      const source = sampleStorage.get(out);
      if (!source) throw new TypeError('sampleInto output must come from this field.createSample()');
      return sampleTo(sectorIndex, position, timeSeconds, out, source);
    },
    get cacheSize() { return cache.size; },
  };
}
