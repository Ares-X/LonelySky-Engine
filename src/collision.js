import { CELL_SIZE, decodeCell, encodeCell, wrapCell as wrap } from './coordinates.js';

export const COLLISION_CACHE_LIMIT = 128;
const SKIN = 1e-5;
const EPSILON = 1e-8;
const MAX_SWEEP_EVENTS = 64;
const MAX_RECOVERY_STEPS = 64;
const PIECE_LENGTH = CELL_SIZE / 4;
const length = v => Math.hypot(...v);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** Default exclusion envelope around a sphere, in caller-defined world units. */
export function safeRadius(type, radius) {
  if (type === 'black-hole') return radius * 3 + 100;
  if (type === 'star') return radius * 1.6 + 80;
  return radius + Math.max(40, radius * .025);
}

/** Additive solid geometry may widen a body's envelope, never shrink it. */
export function bodyCollisionRadius(body, type = 'planet') {
  const override = body.collisionClearance;
  return Math.max(safeRadius(type, body.radius), Number.isFinite(override) && override > 0 ? override : 0);
}

function removeInward(vector, normal) {
  const inward = dot(vector, normal);
  return inward < 0 ? vector.map((n, i) => n - normal[i] * inward) : vector;
}

function constrained(vector, normals) {
  const normal = normals.at(-1);
  let result = removeInward(vector, normal);
  for (let i = 0; i < normals.length - 1; i += 1) {
    const other = normals[i];
    if (dot(result, other) >= -EPSILON) continue;
    // At two simultaneous contacts, slide along their common tangent. This
    // retains edge motion while preventing alternating sphere corrections.
    const edge = [normal[1] * other[2] - normal[2] * other[1],
      normal[2] * other[0] - normal[0] * other[2], normal[0] * other[1] - normal[1] * other[0]];
    const squared = dot(edge, edge);
    result = squared > EPSILON ? edge.map(n => n * dot(vector, edge) / squared) : [0, 0, 0];
    if (normals.some(n => dot(result, n) < -EPSILON)) return [0, 0, 0];
  }
  return result;
}

/** Continuous point sweeps against caller-supplied fixed sphere envelopes. */
export function createCollisionWorld({ world, sector = world && (index => world.sector(index)) } = {}) {
  if (typeof sector !== 'function') throw new TypeError('A sector sphere provider is required');
  const cache = new Map();
  let neighborhoodIndex = null, sources = [], revision = world?.revision;
  function refresh() {
    if (revision === world?.revision) return;
    revision = world?.revision; cache.clear(); neighborhoodIndex = null; sources = [];
  }
  function descriptors(index) {
    if (cache.has(index)) return cache.get(index);
    const bodies = sector(index).map(body => ({ id: body.id, name: body.name,
      type: body.type ?? 'planet', sectorIndex: index, radius: body.radius,
      clearance: bodyCollisionRadius(body, body.type), position: [...body.position] }));
    cache.set(index, bodies);
    if (cache.size > COLLISION_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return bodies;
  }
  function neighborhood(index) {
    refresh();
    if (neighborhoodIndex !== index) {
      const origin = decodeCell(index);
      sources = [];
      for (let x = -1; x <= 1; x += 1) for (let y = -1; y <= 1; y += 1) for (let z = -1; z <= 1; z += 1) {
        const cellIndex = encodeCell({ x: wrap(origin.x + x), y: wrap(origin.y + y), z: wrap(origin.z + z) });
        for (const body of descriptors(cellIndex)) sources.push({ ...body,
          position: [body.position[0] + x * CELL_SIZE, body.position[1] + y * CELL_SIZE, body.position[2] + z * CELL_SIZE] });
      }
      neighborhoodIndex = index;
    }
    return sources;
  }
  // Work in the caller's coordinate frame even while a long sweep crosses cells.
  function nearby(index, position) {
    const origin = decodeCell(index);
    const shift = position.map(n => Math.floor((n + CELL_SIZE / 2) / CELL_SIZE));
    const centered = encodeCell({ x: wrap(origin.x + shift[0]), y: wrap(origin.y + shift[1]), z: wrap(origin.z + shift[2]) });
    return { bodies: neighborhood(centered), offset: shift.map(n => n * CELL_SIZE) };
  }
  const contactFor = (body, normal, offset) => ({ ...body,
    normal: [...normal], position: body.position.map((n, i) => n + offset[i]) });

  function ensureSafe(sectorIndex, initialPosition, initialVelocity) {
    if (!vector(initialPosition) || !vector(initialVelocity)) throw new TypeError('Collision position and velocity must be finite three-dimensional vectors');
    const position = [...initialPosition], velocity = [...initialVelocity];
    const view = nearby(sectorIndex, position), local = subtract(position, view.offset);
    let inside = null, deepest = 0;
    for (const body of view.bodies) {
      const depth = body.clearance - length(subtract(local, body.position));
      if (depth > Math.max(deepest, EPSILON)) { inside = body; deepest = depth; }
    }
    if (!inside) return { position, velocity, contact: null, corrected: false, distance: 0 };
    let direction = subtract(local, inside.position), magnitude = length(direction);
    if (magnitude < EPSILON) {
      // A saved pose at the exact center has no radial direction. Oppose its
      // incoming velocity; a stationary pose has a stable upward escape.
      magnitude = length(velocity);
      direction = magnitude > EPSILON ? velocity.map(n => -n / magnitude) : [0, 1, 0];
    } else direction = direction.map(n => n / magnitude);
    let exit = 0, finalBody = inside, finalOffset = view.offset;
    function extendExit(nextView) {
      const intervals = [], origin = subtract(position, nextView.offset);
      for (const body of nextView.bodies) {
        const relative = subtract(origin, body.position), along = dot(relative, direction);
        const radius = body.clearance + SKIN;
        const discriminant = along * along - dot(relative, relative) + radius * radius;
        if (discriminant < 0) continue;
        const root = Math.sqrt(discriminant), enter = -along - root, end = -along + root;
        if (end >= 0) intervals.push({ enter, exit: end, body });
      }
      intervals.sort((a, b) => a.enter - b.enter || a.exit - b.exit);
      // Retain the initial escape ray and extend its connected union as newly
      // reached cells reveal more overlaps. Never alternate radial corrections.
      for (const interval of intervals) {
        if (interval.enter > exit + EPSILON) break;
        if (interval.exit > exit) {
          exit = interval.exit; finalBody = interval.body; finalOffset = nextView.offset;
        }
      }
    }
    extendExit(view);
    let scanned = 0;
    for (let step = 0; scanned < exit && step < MAX_RECOVERY_STEPS; step += 1) {
      scanned = Math.min(exit, scanned + PIECE_LENGTH);
      const probe = position.map((n, i) => n + direction[i] * scanned);
      extendExit(nearby(sectorIndex, probe));
    }
    if (scanned < exit) throw new RangeError('No clear collision recovery pose within the scan limit');
    for (let i = 0; i < 3; i += 1) position[i] += direction[i] * (exit + SKIN);
    const finalView = nearby(sectorIndex, position), finalLocal = subtract(position, finalView.offset);
    if (finalView.bodies.some(body => body.clearance - length(subtract(finalLocal, body.position)) > EPSILON)) {
      throw new RangeError('Collision recovery did not reach a clear pose');
    }
    const relative = subtract(subtract(position, finalOffset), finalBody.position);
    const distance = length(relative), normal = relative.map(n => n / distance);
    return { position, velocity: removeInward(velocity, normal),
      contact: contactFor(finalBody, normal, finalOffset), corrected: true, distance: 0 };
  }

  function move(sectorIndex, start, end, initialVelocity) {
    if (!vector(end)) throw new TypeError('Collision endpoint must be a finite three-dimensional vector');
    const safe = ensureSafe(sectorIndex, start, initialVelocity);
    let position = safe.position, velocity = safe.velocity, contact = safe.contact;
    // Recovery is a pose correction, not a segment flown toward the old end.
    let remaining = subtract(end, start), distance = 0, corrected = safe.corrected;
    const normals = [];
    for (let event = 0; event < MAX_SWEEP_EVENTS; event += 1) {
      const total = length(remaining);
      if (total < EPSILON) break;
      const segmentLength = Math.min(total, PIECE_LENGTH), direction = remaining.map(n => n / total);
      const view = nearby(sectorIndex, position), local = subtract(position, view.offset);
      let hit = null, first = segmentLength + EPSILON;
      for (const body of view.bodies) {
        const relative = subtract(local, body.position), along = dot(relative, direction);
        if (along >= -EPSILON) continue;
        const radius = body.clearance;
        const discriminant = along * along - dot(relative, relative) + radius * radius;
        // Exact tangency is traversable. Only an entering intersection blocks.
        if (discriminant <= EPSILON) continue;
        const entry = -along - Math.sqrt(discriminant);
        if (entry >= -EPSILON && entry < first) { first = Math.max(0, entry); hit = body; }
      }
      const traveled = hit ? first : segmentLength;
      for (let i = 0; i < 3; i += 1) {
        position[i] += direction[i] * traveled;
        remaining[i] -= direction[i] * traveled;
      }
      distance += traveled;
      if (!hit) continue;
      const relative = subtract(subtract(position, view.offset), hit.position), magnitude = length(relative);
      const normal = relative.map(n => n / magnitude);
      normals.push(normal);
      remaining = constrained(remaining, normals);
      velocity = constrained(velocity, normals);
      contact = contactFor(hit, normal, view.offset); corrected = true;
    }
    // The event bound also bounds exceptional caller-supplied long sweeps.
    // Unprocessed motion is discarded, never teleported past unchecked cells.
    if (length(remaining) >= EPSILON) corrected = true;
    return { position, velocity, contact, distance, corrected };
  }
  return { move, ensureSafe,
    bodies(index) { return neighborhood(index).map(body => ({ ...body, position: [...body.position] })); },
    get cacheSize() { return cache.size; } };
}
