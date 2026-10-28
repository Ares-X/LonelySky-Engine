import { randomFromSeed, hashSeed } from './random.js';
import { COSMIC_BODY_GRID_SIZE, cosmicSolidsInBounds } from './cosmic-bodies.js';
import { frameToWorld3 } from './frame.js';

export const COSMIC_SYSTEM_REVISION = 1;
// Includes every solid and finite gravity influence at every orbital phase.
// Smaller than half a macro cell (5.12M); no neighboring system can overlap.
export const COSMIC_SYSTEM_MAX_REACH = 4800000;
const TAU = Math.PI * 2;
function normalize(vector) {
  const inverseLength = 1 / Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
  for (let i = 0; i < 3; i++) vector[i] *= inverseLength;
  return vector;
}
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Fixed hierarchical Kepler satellites and a composite test-particle field.
 * Length is the game's world unit L, time is seconds, mu is L^3/s^2.
 * The primary is fixed; satellites do not perturb it or one another. Their
 * unperturbed orbits use primary mu, independently of the field's range taper.
 * This is neither a full N-body solver nor a long-term stability simulation.
 * The named streams never consume or modify the published primary lottery.
 */
export function describeCosmicSystem(body, seed = 'lonelysky') {
  if (!body || typeof body.id !== 'string' || typeof seed !== 'string') throw new TypeError('A cosmic body and string seed are required');
  const supported = body.kind === 'gas-giant' || body.kind === 'dark-world' || body.kind === 'stellar-giant';
  if (!supported) return freeze({ revision: COSMIC_SYSTEM_REVISION, parentId: body.id, primaryGravity: null,
    satellites: [], planeNormal: null, solidEnvelopeRadius: body.boundsRadius, gravityEnvelopeRadius: 0 });
  if (!(body.radius > 0 && body.radius <= 1200000) || !Array.isArray(body.frame) || body.frame.length !== 9
    || !body.frame.every(Number.isFinite)) throw new RangeError('Cosmic primary radius/frame is outside the supported contract');
  const stream = `${seed}:${body.id}:cosmic-system-v1`;
  const random = randomFromSeed(`${stream}:primary-gravity`);
  const stellar = body.kind === 'stellar-giant', gas = body.kind === 'gas-giant';
  const surfaceGravity = stellar ? 12 + random() * 10 : gas ? 6 + random() * 6 : 3 + random() * 5;
  const mu = surfaceGravity * body.radius ** 2;
  const primaryGravity = { id: body.id, type: stellar ? 'star' : 'planet', radius: body.radius,
    mu, influence: Math.min(COSMIC_SYSTEM_MAX_REACH, body.radius * 4.5), position: [0, 0, 0] };
  const normal = normalize(frameToWorld3(body.frame, [0, 1, 0]));
  const xAxis = normalize(frameToWorld3(body.frame, [1, 0, 0]));
  const zAxis = normalize(frameToWorld3(body.frame, [0, 0, 1]));
  const count = stellar ? 0 : Math.floor(randomFromSeed(`${stream}:satellite-count`)() * (gas ? 6 : 3));
  const satellites = [];
  let solidEnvelopeRadius = body.boundsRadius, gravityEnvelopeRadius = primaryGravity.influence;
  for (let slot = 0; slot < count; slot++) {
    const orbitRandom = randomFromSeed(`${stream}:satellite-${slot}:orbit`);
    const surfaceRandom = randomFromSeed(`${stream}:satellite-${slot}:surface`);
    const radius = body.radius * (.008 + surfaceRandom() * .027);
    const family = surfaceRandom() < .45 ? 'ice' : 'rock';
    // mu ratio = density ratio * radius ratio cubed. Densities are relative
    // design parameters, not claimed SI densities inferred from appearance.
    const densityRatio = gas ? (family === 'ice' ? .9 : 2.4) : (family === 'ice' ? .45 : 1);
    const moonMu = mu * densityRatio * (radius / body.radius) ** 3;
    const a = body.radius * (count === 1 ? 2.5 + orbitRandom() * 1.65
      : 2.55 + slot * 1.55 / (count - 1) + (orbitRandom() - .5) * .06);
    const e = orbitRandom() * .012;
    const periapsis = a * (1 - e), apoapsis = a * (1 + e);
    // A deliberately conservative fluid-aggregate tidal limit. This rejects
    // implausibly close low-density moons; it is not a disruption simulation.
    const rocheLimit=2.44*body.radius*Math.cbrt(1/densityRatio);
    if(periapsis<=rocheLimit)continue;
    const previous = satellites.at(-1);
    if (previous) {
      const hill = (a + previous.orbit.semiMajorAxis) * .5 * Math.cbrt((moonMu + previous.mu) / (3 * mu));
      if (a - previous.orbit.semiMajorAxis < 3.5 * hill
        || periapsis - radius <= previous.boundsRadius) continue;
    }
    const hillRadius = a * Math.cbrt(moonMu / (3 * mu));
    const influence = Math.max(radius * 1.5, hillRadius * .8);
    const solidEnvelope = apoapsis + radius, gravityEnvelope = apoapsis + influence;
    // Reject the whole candidate; never clamp an orbit into a different orbit.
    if (periapsis - radius <= body.radius || gravityEnvelope > COSMIC_SYSTEM_MAX_REACH
      || solidEnvelope >= COSMIC_BODY_GRID_SIZE * .47) continue;
    const tilt = orbitRandom() * .025, node = orbitRandom() * TAU;
    const c = Math.cos(tilt), sx = Math.sin(tilt) * Math.cos(node), sz = Math.sin(tilt) * Math.sin(node);
    const moonNormal = normalize(normal.map((value, i) => value * c + xAxis[i] * sx + zAxis[i] * sz));
    const orbit = { semiMajorAxis: a, eccentricity: e, mu,
      inclination: Math.acos(Math.max(-1, Math.min(1, moonNormal[2]))),
      ascendingNode: Math.atan2(moonNormal[0], -moonNormal[1]),
      argumentOfPeriapsis: orbitRandom() * TAU, meanAnomalyAtEpoch: orbitRandom() * TAU, epochSeconds: 0 };
    const palette = family === 'ice' ? [0x789eaf, 0xd9e9e8] : [0x665e56, 0xb1a496];
    satellites.push({ id: `${body.id}:satellite-v1:${slot}`, parentId: body.id, role: 'satellite', type: 'planet', kind: family, family,
      radius, mu: moonMu, influence, densityRatio, rocheLimit, seed: hashSeed(`${stream}:satellite-${slot}:surface`),
      colorA: palette[0], colorB: palette[1], rings: false, position: [0, 0, 0], orbit,
      shape: { type: 'sphere', radius }, boundsRadius: solidEnvelope });
    solidEnvelopeRadius = Math.max(solidEnvelopeRadius, solidEnvelope);
    gravityEnvelopeRadius = Math.max(gravityEnvelopeRadius, gravityEnvelope);
  }
  return freeze({ revision: COSMIC_SYSTEM_REVISION, parentId: body.id, primaryGravity, satellites,
    planeNormal: normal, solidEnvelopeRadius, gravityEnvelopeRadius });
}

function intersects(position, radius, bounds) {
  let squared = 0;
  for (let i = 0; i < 3; i++) {
    const distance = Math.max(bounds.min[i] - position[i], 0, position[i] - bounds.max[i]);
    squared += distance * distance;
  }
  return squared <= radius * radius;
}

function orbitOccupancy(satellite, position) {
  const orbit = satellite.orbit, node = orbit.ascendingNode, tilt = orbit.inclination;
  const cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(tilt), si = Math.sin(tilt);
  // The full annulus is invariant under argumentOfPeriapsis. Its local X is
  // the ascending node, local Y the very same orbit normal used by Kepler,
  // and local Z = X cross Y. Matrix3 arrays use Three.js column order.
  const frame = [cn, sn * si, sn * ci, sn, -cn * si, -cn * ci, 0, ci, -si];
  // Cover rounding in orbital rotation and translated million-unit centers.
  const slack = 1e-6 + 128 * Number.EPSILON * orbit.semiMajorAxis;
  const halfHeight = satellite.radius + slack;
  const innerRadius = orbit.semiMajorAxis * (1 - orbit.eccentricity) - halfHeight;
  const outerRadius = orbit.semiMajorAxis * (1 + orbit.eccentricity) + halfHeight;
  return { id: `${satellite.id}:orbit-occupancy`, parentId: satellite.parentId,
    satelliteId: satellite.id, role: 'placement-reservation', position: [...position], frame,
    boundsRadius: Math.hypot(outerRadius, halfHeight),
    shape: { type: 'compound', parts: [{ type: 'annular-sector-slab', innerRadius, outerRadius,
      minY: -halfHeight, maxY: halfHeight, gapCenter: 0, gapHalfAngle: 0 }] } };
}

function querySystems({ sectorIndex, bounds, seed = 'lonelysky' }, mode) {
  if (!bounds || !Array.isArray(bounds.min) || bounds.min.length !== 3 || !bounds.min.every(Number.isFinite)
    || !Array.isArray(bounds.max) || bounds.max.length !== 3 || !bounds.max.every(Number.isFinite)) throw new TypeError('Invalid cosmic system query bounds');
  if (bounds.min[0] > bounds.max[0] || bounds.min[1] > bounds.max[1] || bounds.min[2] > bounds.max[2]) throw new RangeError('Inverted cosmic system query bounds');
  // Parent surfaces need not touch the query. Search by the greatest supported
  // orbital/influence reach, then test each family's full phase envelope.
  const expanded = { min: bounds.min.map(n => n - COSMIC_SYSTEM_MAX_REACH), max: bounds.max.map(n => n + COSMIC_SYSTEM_MAX_REACH) };
  const result = [];
  for (const parent of cosmicSolidsInBounds({ sectorIndex, bounds: expanded, seed })) {
    const system = describeCosmicSystem(parent, seed), position = parent.position;
    if (mode === 'gravity' && system.primaryGravity && intersects(position, system.primaryGravity.influence, bounds)) {
      result.push({ ...system.primaryGravity, position: [...position] });
    }
    for (const satellite of system.satellites) {
      if (mode === 'occupancy') {
        const reservation = orbitOccupancy(satellite, position);
        if (intersects(position, reservation.boundsRadius, bounds)) result.push(reservation);
      } else {
        const envelope = mode === 'gravity' ? satellite.orbit.semiMajorAxis * (1 + satellite.orbit.eccentricity) + satellite.influence : satellite.boundsRadius;
        if (intersects(position, envelope, bounds)) result.push({ ...satellite, position: [...position] });
      }
    }
  }
  return result;
}

/** Sphere descriptors anchored in the calling sector frame, for every phase. */
export function cosmicSystemBodiesInBounds(options) { return querySystems(options, 'bodies'); }

/** Primary and satellite finite-field candidates, independent of rendering. */
export function cosmicGravitySourcesInBounds(options) { return querySystems(options, 'gravity'); }

/**
 * Placement-only full-phase annular reservations. The central hole and space
 * above/below each orbital plane remain available to small local bodies.
 * These are never physical colliders: collision/gravity sample the actual
 * satellite spheres returned by their respective providers at simulation time.
 */
export function cosmicSystemOccupancyInBounds(options) { return querySystems(options, 'occupancy'); }
