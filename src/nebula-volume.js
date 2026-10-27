/** Existing V2 cloud geometry. Shared by rendering and scenic navigation. */
export const NEBULA_VOLUME = Object.freeze({
  center: Object.freeze([1500, -500, -12500]),
  halfExtents: Object.freeze([7500, 6200, 3800]),
  focusRadius: 3000,
});

/** Sector-local bounds after the cloud's authored tilt, without changing its seed. */
export function describeNebulaVolume({ tilt = 0 } = {}) {
  const rotationZ = Number.isFinite(tilt) ? tilt * .5 : 0;
  const c = Math.cos(rotationZ), s = Math.sin(rotationZ);
  const [x, y, z] = NEBULA_VOLUME.center;
  return {
    center: [x * c - y * s, x * s + y * c, z],
    halfExtents: [...NEBULA_VOLUME.halfExtents], rotationZ,
    radius: Math.hypot(...NEBULA_VOLUME.halfExtents),
    focusRadius: NEBULA_VOLUME.focusRadius,
  };
}

/** Bounded fade measured from the volume surface, with a continuous derivative. */
export function nebulaVisibility(distance) {
  if (typeof distance !== 'number' || Number.isNaN(distance)) return 0;
  // The authored entrance is 8700 units from the nearest surface. Preserve
  // that vista, then fade before the existing 36000-unit streaming horizon.
  const t = Math.max(0, Math.min(1, (distance - 9000) / 7000));
  return 1 - t * t * (3 - 2 * t);
}
