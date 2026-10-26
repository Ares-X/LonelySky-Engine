const TAU = 2 * Math.PI;

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
  return value;
}

function positive(value, name) {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function rates({ semiMajorAxis, mu }) {
  positive(semiMajorAxis, 'semiMajorAxis');
  positive(mu, 'mu');
  // Avoid cubing a, which would overflow at otherwise useful astronomical scales.
  const speed = Math.sqrt(mu) / Math.sqrt(semiMajorAxis);
  const meanMotion = speed / semiMajorAxis;
  const periodSeconds = TAU / meanMotion;
  if (![speed, meanMotion, periodSeconds].every(n => Number.isFinite(n) && n > 0)) {
    throw new RangeError('orbital scale is outside the representable numeric range');
  }
  return { speed, meanMotion, periodSeconds };
}

/** Elliptic two-body period in seconds; a and mu use the same length unit (mu: L³/s²). */
export function orbitalPeriod(elements) {
  return rates(elements).periodSeconds;
}

function signedAngle(value) {
  const angle = value % TAU;
  return angle > Math.PI ? angle - TAU : angle < -Math.PI ? angle + TAU : angle;
}

// E - sin(E), without catastrophic cancellation at high eccentricity near periapsis.
function eccentricRemainder(value) {
  if (Math.abs(value) >= 0.1) return value - Math.sin(value);
  const squared = value * value;
  return value * squared * (1 / 6 - squared * (1 / 120 - squared * (1 / 5040
    - squared * (1 / 362880 - squared / 39916800))));
}

function solveEccentricAnomaly(meanAnomaly, eccentricity) {
  if (meanAnomaly === 0 || eccentricity === 0) return meanAnomaly;
  const sign = Math.sign(meanAnomaly), target = Math.abs(meanAnomaly);
  const gap = 1 - eccentricity;
  let low = 0, high = Math.PI;
  let anomaly = Math.min(high, target / gap, Math.cbrt(6 * target / eccentricity));
  for (let iteration = 0; iteration < 128; iteration++) {
    const residual = gap * anomaly + eccentricity * eccentricRemainder(anomaly) - target;
    if (residual === 0) return sign * anomaly;
    const derivative = gap + 2 * eccentricity * Math.sin(anomaly / 2) ** 2;
    let next = anomaly - residual / derivative;
    if (next === anomaly || Math.abs(next - anomaly) <= 4 * Number.EPSILON * Math.abs(anomaly)) {
      return sign * next;
    }
    if (residual > 0) high = anomaly;
    else low = anomaly;
    if (!(next > low && next < high)) next = low + (high - low) / 2;
    if (next === anomaly) return sign * anomaly;
    anomaly = next;
  }
  throw new RangeError('Kepler solver did not converge within its iteration limit');
}

/**
 * Evaluate an unperturbed elliptic two-body relative orbit at an absolute time.
 *
 * Required elements: semiMajorAxis > 0, mu > 0, 0 <= eccentricity < 1.
 * mu is G * (central mass + orbiting mass), in L³/s². Choose any consistent
 * length unit; position, velocity and acceleration then use L, L/s and L/s².
 * inclination, ascendingNode, argumentOfPeriapsis and meanAnomalyAtEpoch are
 * radians; they and epochSeconds default to zero. The right-handed reference
 * plane is XY, with +Z its normal. Rotation is Rz(node) Rx(i) Rz(periapsis).
 *
 * Output vectors are relative to the other body at the focus, without a world
 * translation. accelerationBound is the periapsis maximum mu/[a(1-e)]² with
 * outward numeric slack, in L/s², valid for every time on this orbit.
 * Anomalies are signed radians in [-pi, pi]. Calls are stateless;
 * huge times are reduced modulo period before subtraction. IEEE-754 input-time
 * precision still limits phase precision; callers should use a nearby epoch.
 * Parabolic/hyperbolic motion, perturbations and collisions are outside this API.
 * Invalid/nonrepresentable scales throw instead of returning a clamped orbit.
 *
 * Physical basis: https://science.nasa.gov/solar-system/orbits-and-keplers-laws/
 * https://science.nasa.gov/learn/basics-of-space-flight/chapter3-3/
 */
export function evaluateOrbit(elements, timeSeconds) {
  const { semiMajorAxis: a, mu, eccentricity: e, inclination = 0, ascendingNode = 0,
    argumentOfPeriapsis = 0, meanAnomalyAtEpoch = 0, epochSeconds = 0 } = elements;
  const { speed, meanMotion, periodSeconds } = rates(elements);
  finite(e, 'eccentricity');
  if (e < 0 || e >= 1) throw new RangeError('eccentricity must be in [0, 1)');
  const periapsisRadius = a * (1 - e);
  // The two-body maximum is mu/r_peri². Small outward slack covers arithmetic
  // and frame-rotation rounding when consumers use it as a conservative bound.
  const accelerationBound = ((mu / periapsisRadius) / periapsisRadius) * (1 + 8 * Number.EPSILON);
  if (!(periapsisRadius > 0) || !(accelerationBound > 0) || !Number.isFinite(accelerationBound)) {
    throw new RangeError('orbital acceleration bound is outside the representable numeric range');
  }
  for (const [name, value] of Object.entries({ inclination, ascendingNode, argumentOfPeriapsis,
    meanAnomalyAtEpoch, epochSeconds, timeSeconds })) finite(value, name);

  const phase = TAU * ((timeSeconds % periodSeconds) / periodSeconds
    - (epochSeconds % periodSeconds) / periodSeconds);
  const meanAnomaly = signedAngle(signedAngle(meanAnomalyAtEpoch) + signedAngle(phase));
  const eccentricAnomaly = solveEccentricAnomaly(meanAnomaly, e);
  const sinE = Math.sin(eccentricAnomaly), cosE = Math.cos(eccentricAnomaly);
  const halfSinSquared = Math.sin(eccentricAnomaly / 2) ** 2;
  const beta = Math.sqrt((1 - e) * (1 + e));
  const radiusFactor = (1 - e) + 2 * e * halfSinSquared;
  const radius = a * radiusFactor;
  const x = a * ((1 - e) - 2 * halfSinSquared), y = a * beta * sinE;
  const vx = -speed * sinE / radiusFactor, vy = speed * beta * cosE / radiusFactor;

  const node = signedAngle(ascendingNode), tilt = signedAngle(inclination);
  const periapsis = signedAngle(argumentOfPeriapsis);
  const cn = Math.cos(node), sn = Math.sin(node), ci = Math.cos(tilt), si = Math.sin(tilt);
  const cp = Math.cos(periapsis), sp = Math.sin(periapsis);
  const p = [cn * cp - sn * sp * ci, sn * cp + cn * sp * ci, sp * si];
  const q = [-cn * sp - sn * cp * ci, -sn * sp + cn * cp * ci, cp * si];
  const position = p.map((value, i) => value * x + q[i] * y);
  const velocity = p.map((value, i) => value * vx + q[i] * vy);
  const accelerationMagnitude = (mu / radius) / radius;
  const acceleration = position.map(value => -accelerationMagnitude * (value / radius));
  if (!(radius > 0) || !(accelerationMagnitude > 0)
    || ![radius, accelerationMagnitude, ...position, ...velocity, ...acceleration].every(Number.isFinite)) {
    throw new RangeError('orbital state is outside the representable numeric range');
  }
  const trueAnomaly = Math.atan2(beta * sinE, (1 - e) - 2 * halfSinSquared);
  return { position, velocity, acceleration, radius, meanAnomaly, eccentricAnomaly,
    trueAnomaly, meanMotion, periodSeconds, accelerationBound };
}

/**
 * Sample a body for rendering, gravity or collision without mutating its descriptor.
 * body.position must be a finite three-number array. For an orbiting body it is
 * the fixed focus/anchor; the orbit's radius remains relative to that focus.
 * Missing/null body.orbit denotes a static body. Time is required in both cases.
 * Every returned vector is detached from the descriptor; velocities and
 * accelerations use the stationary anchor's frame. accelerationBound is zero
 * for static bodies and is preserved from evaluateOrbit for orbiting bodies.
 */
export function evaluateBodyState(body, timeSeconds) {
  finite(timeSeconds, 'timeSeconds');
  if (!Array.isArray(body?.position) || body.position.length !== 3
    || ![0, 1, 2].every(index => Number.isFinite(body.position[index]))) {
    throw new TypeError('body.position must be a finite three-number array');
  }
  if (body.orbit == null) {
    return { position: [...body.position], velocity: [0, 0, 0], acceleration: [0, 0, 0], accelerationBound: 0 };
  }
  const state = evaluateOrbit(body.orbit, timeSeconds);
  const position = state.position.map((value, i) => value + body.position[i]);
  if (!position.every(Number.isFinite)) {
    throw new RangeError('translated orbital position is outside the representable numeric range');
  }
  return { ...state, position };
}
