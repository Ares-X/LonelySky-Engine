import { CELL_SIZE, decodeCell, encodeCell, wrapCell as wrap } from './coordinates.js';
import { createBodyStateSampler } from './orbits.js';

export const COLLISION_CACHE_LIMIT = 128;
const SKIN = 1e-5;
const EPSILON = 1e-8;
const MAX_SWEEP_EVENTS = 64;
const MAX_RECOVERY_STEPS = 64;
const PIECE_LENGTH = CELL_SIZE / 4;
const MAX_TIME_STEP = 1 / 120;
const MAX_TIME_STEPS = 64;
const length = v => Math.hypot(...v);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const distanceTo = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

class RecoveryFailure extends RangeError {
  constructor(message, code) { super(message); this.code = code; }
}

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

// Closest feasible motion in the intersection of contact half-spaces. In
// three dimensions a projection has at most three independent active planes;
// enumerating those candidates avoids order-dependent alternating corrections.
function constrainedSurfaces(motion, contacts, scale, surfaceFor) {
  const planes = contacts.map(contact => ({ normal: contact.normal,
    floor: dot(surfaceFor(contact), contact.normal) * scale }));
  const tolerance = 32 * Number.EPSILON * Math.max(1, length(motion), ...planes.map(plane => Math.abs(plane.floor)));
  const feasible = candidate => planes.every(({ normal, floor }) => dot(candidate, normal) >= floor - tolerance);
  if (feasible(motion)) return motion;
  let best = null, least = Infinity;
  function consider(candidate) {
    if (!candidate.every(Number.isFinite) || !feasible(candidate)) return;
    const difference = length(subtract(candidate, motion));
    if (difference < least) { best = candidate; least = difference; }
  }
  for (let i = 0; i < planes.length; i++) {
    const a = planes[i], da = a.floor - dot(a.normal, motion);
    consider(motion.map((n, axis) => n + a.normal[axis] * da));
    for (let j = 0; j < i; j++) {
      const b = planes[j], db = b.floor - dot(b.normal, motion);
      const cosine = dot(a.normal, b.normal), determinant = 1 - cosine * cosine;
      if (determinant > 1e-12) {
        const alpha = (da - cosine * db) / determinant, beta = (db - cosine * da) / determinant;
        consider(motion.map((n, axis) => n + alpha * a.normal[axis] + beta * b.normal[axis]));
      }
      for (let k = 0; k < j; k++) {
        const c = planes[k];
        const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const bc = cross(b.normal, c.normal), ca = cross(c.normal, a.normal), ab = cross(a.normal, b.normal);
        const volume = dot(a.normal, bc);
        if (Math.abs(volume) > 1e-12) consider(bc.map((n, axis) =>
          (n * a.floor + ca[axis] * b.floor + ab[axis] * c.floor) / volume));
      }
    }
  }
  return best;
}

/** Continuous point sweeps against static or orbiting sphere envelopes. */
export function createCollisionWorld({ world, sector = world && (index => world.sector(index)) } = {}) {
  if (typeof sector !== 'function') throw new TypeError('A sector sphere provider is required');
  const cache = new Map(), sampledSources = new WeakMap();
  let neighborhoodIndex = null, sources = [], revision = world?.revision;
  let sampledNeighborhood = null, sampledMargins = [], neighborhoodMoving = false, centeredFrame;
  const newState = () => ({ position: [0, 0, 0], velocity: [0, 0, 0], acceleration: [0, 0, 0] });
  function refresh() {
    if (revision === world?.revision) return;
    revision = world?.revision; cache.clear(); neighborhoodIndex = null; sources = [];
  }
  function descriptors(index) {
    if (cache.has(index)) return cache.get(index);
    const bodies = sector(index).map(body => {
      const descriptor = { id: body.id, name: body.name,
        type: body.type ?? 'planet', sectorIndex: index, radius: body.radius,
        clearance: bodyCollisionRadius(body, body.type), position: [...body.position],
        ...(body.orbit == null ? {} : { orbit: { ...body.orbit } }) };
      return { body: descriptor, sample: createBodyStateSampler(descriptor) };
    });
    cache.set(index, bodies);
    if (cache.size > COLLISION_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return bodies;
  }
  function neighborhood(index) {
    refresh();
    if (neighborhoodIndex !== index) {
      const origin = decodeCell(index);
      sources = []; neighborhoodMoving = false;
      for (let x = -1; x <= 1; x += 1) for (let y = -1; y <= 1; y += 1) for (let z = -1; z <= 1; z += 1) {
        const cellIndex = encodeCell({ x: wrap(origin.x + x), y: wrap(origin.y + y), z: wrap(origin.z + z) });
        for (const entry of descriptors(cellIndex)) {
          sources.push({ ...entry, offset: [x * CELL_SIZE, y * CELL_SIZE, z * CELL_SIZE],
            begin: newState(), finish: newState(), actual: newState(), chordVelocity: [0, 0, 0],
            chordTime: undefined, chordDuration: undefined });
          if (entry.body.orbit) neighborhoodMoving = true;
        }
      }
      neighborhoodIndex = index;
    }
    return sources;
  }
  function sampled(index, timeSeconds, marginSpan = 0) {
    const entries = neighborhood(index);
    if (sampledNeighborhood !== entries) {
      sampledNeighborhood = entries; sampledMargins = [];
    }
    let slot;
    for (let i = 0; i < sampledMargins.length; i++) {
      const candidate = sampledMargins[i];
      if (Object.is(candidate.marginSpan, marginSpan)) {
        if (!neighborhoodMoving || Object.is(candidate.timeSeconds, timeSeconds)) return candidate.bodies;
        slot = candidate; break;
      }
    }
    if (!slot) {
      if (sampledMargins.length === 2) slot = sampledMargins.shift();
      else {
        const bodies = [], states = [];
        for (const source of entries) {
          const sampledBody = { ...source.body, position: [0, 0, 0], velocity: [0, 0, 0], sweepMargin: 0 };
          bodies.push(sampledBody);
          states.push({ position: sampledBody.position, velocity: sampledBody.velocity, acceleration: [0, 0, 0] });
          sampledSources.set(sampledBody, source);
        }
        slot = { bodies, states };
      }
      sampledMargins.push(slot);
    }
    for (let i = 0; i < entries.length; i++) {
      const source = entries[i], state = source.sample(timeSeconds, slot.states[i]), body = slot.bodies[i];
      const sweepMargin = marginSpan ? state.accelerationBound * marginSpan ** 2 / 8 : 0;
      if (!Number.isFinite(sweepMargin)) throw new RangeError('Collision curvature margin is not representable');
      for (let axis = 0; axis < 3; axis++) body.position[axis] += source.offset[axis];
      body.clearance = source.body.clearance + sweepMargin; body.sweepMargin = sweepMargin;
    }
    slot.timeSeconds = timeSeconds; slot.marginSpan = marginSpan;
    return slot.bodies;
  }
  function chord(source, timeSeconds, duration) {
    if (Object.is(source.chordTime, timeSeconds) && Object.is(source.chordDuration, duration)) return;
    source.sample(timeSeconds, source.begin);
    source.sample(timeSeconds + duration, source.finish);
    for (let i = 0; i < 3; i++) source.chordVelocity[i] = (source.finish.position[i] - source.begin.position[i]) / duration;
    source.chordTime = timeSeconds; source.chordDuration = duration;
  }
  // Work in the caller's coordinate frame even while a long sweep crosses cells.
  function frame(index, position) {
    const x = Math.floor((position[0] + CELL_SIZE / 2) / CELL_SIZE);
    const y = Math.floor((position[1] + CELL_SIZE / 2) / CELL_SIZE);
    const z = Math.floor((position[2] + CELL_SIZE / 2) / CELL_SIZE);
    if (x === 0 && y === 0 && z === 0) {
      // The common same-cell path needs neither a Morton decode/encode nor a
      // new offset. Replace the frame only at a caller rebase; never mutate an
      // offset retained by recovery/contact calculations.
      if (!centeredFrame || centeredFrame.index !== index) centeredFrame = { index, offset: [0, 0, 0] };
      return centeredFrame;
    }
    const origin = decodeCell(index);
    const centered = encodeCell({ x: wrap(origin.x + x), y: wrap(origin.y + y), z: wrap(origin.z + z) });
    return { index: centered, offset: [x * CELL_SIZE, y * CELL_SIZE, z * CELL_SIZE] };
  }
  function nearby(index, position, timeSeconds = 0, marginSpan = 0) {
    const view = frame(index, position);
    return { bodies: sampled(view.index, timeSeconds, marginSpan), offset: view.offset };
  }
  const contactFor = (body, normal, offset) => ({ ...body,
    normal: [...normal], velocity: [...body.velocity],
    ...(body.orbit ? { orbit: { ...body.orbit } } : {}),
    position: body.position.map((n, i) => n + offset[i]) });

  function recover(sectorIndex, initialPosition, initialVelocity, timeSeconds = 0, marginSpan = 0) {
    if (!Number.isFinite(timeSeconds)) throw new TypeError('timeSeconds must be finite');
    if (!vector(initialPosition) || !vector(initialVelocity)) throw new TypeError('Collision position and velocity must be finite three-dimensional vectors');
    const position = [...initialPosition], velocity = [...initialVelocity];
    const view = nearby(sectorIndex, position, timeSeconds, marginSpan), local = subtract(position, view.offset);
    let inside = null, deepest = 0;
    for (const body of view.bodies) {
      const depth = body.clearance - distanceTo(local, body.position);
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
      extendExit(nearby(sectorIndex, probe, timeSeconds, marginSpan));
    }
    if (scanned < exit) throw new RecoveryFailure('No clear collision recovery pose within the scan limit', 'recovery-scan-limit');
    for (let i = 0; i < 3; i += 1) position[i] += direction[i] * (exit + SKIN);
    const finalView = nearby(sectorIndex, position, timeSeconds, marginSpan), finalLocal = subtract(position, finalView.offset);
    if (finalView.bodies.some(body => body.clearance - distanceTo(finalLocal, body.position) > EPSILON)) {
      throw new RecoveryFailure('Collision recovery did not reach a clear pose', 'recovery-overlap-unresolved');
    }
    const relative = subtract(subtract(position, finalOffset), finalBody.position);
    const distance = length(relative), normal = relative.map(n => n / distance);
    return { position, velocity: removeInward(subtract(velocity, finalBody.velocity), normal)
      .map((n, i) => n + finalBody.velocity[i]),
      contact: contactFor(finalBody, normal, finalOffset), corrected: true, distance: 0 };
  }

  function ensureSafe(sectorIndex, initialPosition, initialVelocity, timeSeconds = 0) {
    return recover(sectorIndex, initialPosition, initialVelocity, timeSeconds);
  }

  function moveStatic(sectorIndex, start, end, initialVelocity, timeSeconds,
    safe = ensureSafe(sectorIndex, start, initialVelocity, timeSeconds)) {
    let position = safe.position, velocity = safe.velocity, contact = safe.contact;
    // Recovery is a pose correction, not a segment flown toward the old end.
    let remaining = subtract(end, start), distance = 0, corrected = safe.corrected;
    const normals = [];
    for (let event = 0; event < MAX_SWEEP_EVENTS; event += 1) {
      const total = length(remaining);
      if (total < EPSILON) break;
      const segmentLength = Math.min(total, PIECE_LENGTH), direction = remaining.map(n => n / total);
      const view = nearby(sectorIndex, position, timeSeconds), local = subtract(position, view.offset);
      let hit = null, first = segmentLength + EPSILON;
      for (const body of view.bodies) {
        const x = local[0] - body.position[0], y = local[1] - body.position[1], z = local[2] - body.position[2];
        const along = x * direction[0] + y * direction[1] + z * direction[2];
        if (along >= -EPSILON) continue;
        const radius = body.clearance;
        const discriminant = along * along - (x * x + y * y + z * z) + radius * radius;
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
      velocity = hit.orbit ? removeInward(subtract(velocity, hit.velocity), normal)
        .map((n, i) => n + hit.velocity[i]) : constrained(velocity, normals);
      contact = contactFor(hit, normal, view.offset); corrected = true;
    }
    // The event bound also bounds exceptional caller-supplied long sweeps.
    // Unprocessed motion is discarded, never teleported past unchecked cells.
    if (length(remaining) >= EPSILON) corrected = true;
    return { position, velocity, contact, distance, corrected };
  }
  function blockedMotion(safe, timeSeconds, failedTimeSeconds, code, message, contacts, cause = new RangeError(message)) {
    return { ...safe, corrected: true, distance: 0,
      failure: { code, message, cause, timeSeconds, failedTimeSeconds, safeAtStart: true,
        contacts: contacts.map(item => ({ id: item.source.body.id, sectorIndex: item.source.body.sectorIndex,
          normal: [...item.normal], surface: [...item.surface] })) } };
  }
  /**
   * Time is the interval's start. Curved paths use chords at <= 1/120 s;
   * a rigorous accelerationBound*h²/8 inflation contains the entire orbit arc.
   * A conservative recovery at each chord start avoids starting inside that
   * envelope. Contacts carry the ship using relative surface motion, so even
   * a stationary caller endpoint is swept against a moving body. Intervals
   * with moving sources above 64/120 s fail explicitly. Short same-cell static
   * sweeps use the static path and do not need temporal subdivision.
   */
  function move(sectorIndex, start, end, initialVelocity, { timeSeconds = 0, deltaTime = 0 } = {}) {
    if (!vector(end)) throw new TypeError('Collision endpoint must be a finite three-dimensional vector');
    if (!Number.isFinite(timeSeconds) || !Number.isFinite(deltaTime)) throw new TypeError('Collision times must be finite');
    if (deltaTime < 0) throw new RangeError('deltaTime must be nonnegative');
    if (!Number.isFinite(timeSeconds + deltaTime)) throw new RangeError('Collision end time must be finite');
    let safe;
    try { safe = ensureSafe(sectorIndex, start, initialVelocity, timeSeconds); }
    catch (cause) {
      if (!(cause instanceof RecoveryFailure)) throw cause;
      // No safe initial pose was found. Preserve the input without calling it
      // a recovered endpoint; the caller must stop time and choose a valid pose.
      return { position: [...start], velocity: [...initialVelocity], contact: null, distance: 0, corrected: false,
        failure: { code: cause.code, message: cause.message, cause, timeSeconds, failedTimeSeconds: timeSeconds,
          safeAtStart: false, contacts: [] } };
    }
    if (!deltaTime) return moveStatic(sectorIndex, start, end, initialVelocity, timeSeconds, safe);
    const reach = length(subtract(end, start)), view = frame(sectorIndex, safe.position);
    // Static contact only shortens the remaining motion. If its entire possible
    // travel ball stays in this cell and all 27 anchor cells are static, reuse
    // the established static sweep. Longer/cell-crossing sweeps keep checking
    // moving sources as their neighborhoods change.
    if (safe.position.every((n, i) => Math.abs(n - view.offset[i]) + reach < CELL_SIZE / 2)
      && !neighborhoodMoving) {
      return moveStatic(sectorIndex, start, end, initialVelocity, timeSeconds, safe);
    }
    const steps = Math.ceil(deltaTime / MAX_TIME_STEP);
    if (steps > MAX_TIME_STEPS) throw new RangeError('Collision interval exceeds 64 time steps; subdivide the caller interval');
    let position = safe.position, velocity = safe.velocity, contact = safe.contact;
    let distance = 0, corrected = safe.corrected;
    const duration = deltaTime / steps;
    // A collision changes subsequent displacement; without one, honor the
    // caller endpoint even when it differs from velocity * deltaTime.
    let travelVelocity = subtract(end, start).map(n => n / deltaTime);
    for (let step = 0; step < steps; step++) {
      const intervalStart = timeSeconds + step * duration;
      let recovered;
      try { recovered = recover(sectorIndex, position, velocity, intervalStart, duration); }
      catch (cause) {
        if (!(cause instanceof RecoveryFailure)) throw cause;
        return blockedMotion(safe, timeSeconds, intervalStart, cause.code, cause.message, [], cause);
      }
      position = recovered.position; velocity = recovered.velocity;
      if (recovered.corrected) {
        corrected = true; contact = recovered.contact;
        travelVelocity = removeInward(subtract(travelVelocity, contact.velocity), contact.normal)
          .map((n, i) => n + contact.velocity[i]);
      }
      const contacts = [];
      let elapsed = 0, remaining = travelVelocity.map(n => n * duration);
      for (let event = 0; event < MAX_SWEEP_EVENTS && elapsed < duration; event++) {
        const span = duration - elapsed, now = intervalStart + elapsed;
        const total = length(remaining);
        // Spatial subdivision preserves neighborhood/cell-crossing bounds.
        const fraction = total > PIECE_LENGTH ? PIECE_LENGTH / total : 1;
        const h = span * fraction, motion = remaining.map(n => n * fraction);
        const view = nearby(sectorIndex, position, now), local = subtract(position, view.offset);
        let hit = null, first = 1 + EPSILON;
        for (const body of view.bodies) {
          const source = sampledSources.get(body);
          chord(source, intervalStart, duration);
          const begin = source.begin, chordVelocity = source.chordVelocity;
          const cx = begin.position[0] + source.offset[0] + chordVelocity[0] * elapsed;
          const cy = begin.position[1] + source.offset[1] + chordVelocity[1] * elapsed;
          const cz = begin.position[2] + source.offset[2] + chordVelocity[2] * elapsed;
          const mx = chordVelocity[0] * h, my = chordVelocity[1] * h, mz = chordVelocity[2] * h;
          const rx = local[0] - cx, ry = local[1] - cy, rz = local[2] - cz;
          const sx = motion[0] - mx, sy = motion[1] - my, sz = motion[2] - mz;
          const squared = sx * sx + sy * sy + sz * sz, along = rx * sx + ry * sy + rz * sz;
          if (squared < EPSILON ** 2 || along >= -EPSILON) continue;
          const margin = begin.accelerationBound * duration ** 2 / 8;
          const radius = body.clearance + margin, relativeSquared = rx * rx + ry * ry + rz * rz;
          const discriminant = along * along - squared * (relativeSquared - radius * radius);
          if (discriminant <= EPSILON * squared) continue;
          const root = (-along - Math.sqrt(discriminant)) / squared;
          const entryFraction = relativeSquared <= radius * radius ? 0 : root;
          if (entryFraction >= -EPSILON && entryFraction < first) {
            first = Math.min(1, Math.max(0, entryFraction));
            hit = { body: { ...body, position: [cx, cy, cz] }, bodyMotion: [mx, my, mz], source };
          }
        }
        const used = hit ? first : 1;
        const traveled = motion.map(n => n * used);
        position = position.map((n, i) => n + traveled[i]);
        distance += length(traveled);
        remaining = remaining.map((n, i) => n - traveled[i]);
        elapsed += h * used;
        if (!hit) continue;
        const center = hit.body.position.map((n, i) => n + hit.bodyMotion[i] * used);
        const relative = subtract(subtract(position, view.offset), center), magnitude = length(relative);
        const normal = relative.map(n => n / magnitude);
        const surface = hit.bodyMotion.map(n => n / h);
        const timeLeft = duration - elapsed;
        const prior = contacts.findIndex(item => item.source.body === hit.source.body
          && item.source.offset.every((n, i) => n === hit.source.offset[i]));
        const constraint = { normal, surface, source: hit.source };
        if (prior < 0) contacts.push(constraint);
        else contacts[prior] = constraint;
        remaining = constrainedSurfaces(remaining, contacts, timeLeft, item => item.surface);
        if (!remaining) return blockedMotion(safe, timeSeconds, intervalStart + elapsed, 'infeasible-moving-contact',
          'Moving collision contact constraints have no feasible motion', contacts);
        const actualState = hit.source.sample(intervalStart + elapsed, hit.source.actual);
        velocity = constrainedSurfaces(velocity, contacts, 1,
          item => item.source.sample(intervalStart + elapsed, item.source.actual).velocity);
        if (!velocity) return blockedMotion(safe, timeSeconds, intervalStart + elapsed, 'infeasible-moving-contact',
          'Moving collision contact constraints have no feasible velocity', contacts);
        contact = contactFor({ ...hit.body, position: center, velocity: actualState.velocity }, normal, view.offset);
        corrected = true;
        if (timeLeft > 0) travelVelocity = remaining.map(n => n / timeLeft);
      }
      if (elapsed < duration - EPSILON) return blockedMotion(safe, timeSeconds, intervalStart + elapsed, 'moving-sweep-event-limit',
        'Moving collision sweep exceeded its event limit', contacts);
    }
    return { position, velocity, contact, distance, corrected };
  }
  return { move, ensureSafe,
    bodies(index, timeSeconds = 0) {
      if (!Number.isFinite(timeSeconds)) throw new TypeError('timeSeconds must be finite');
      return sampled(index, timeSeconds).map(body => ({ ...body,
        position: [...body.position], velocity: [...body.velocity],
        ...(body.orbit ? { orbit: { ...body.orbit } } : {}) }));
    },
    get cacheSize() { return cache.size; } };
}
