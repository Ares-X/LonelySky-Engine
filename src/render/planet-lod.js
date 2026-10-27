import * as THREE from 'three';

// Shared unit spheres: only visible screen coverage determines detail. World
// descriptors and collision radii remain untouched.
const SEGMENTS = [[48, 32], [96, 64], [192, 128], [256, 160], [320, 192]];
const THRESHOLDS = [80, 360, 1000, 2000];
const qualityCap = quality => quality === 'low' ? 2 : quality === 'high' ? 4 : 3;

export function projectedPlanetRadius({radius, distance, fov, viewportHeight, pixelRatio = 1}) {
  if (!(radius > 0) || !(viewportHeight > 0) || !(pixelRatio > 0) || !(fov > 0 && fov < 180) || !(distance >= 0)) return 0;
  if (distance <= radius) return Infinity;
  const focalLength = viewportHeight * pixelRatio / (2 * Math.tan(fov * Math.PI / 360));
  return focalLength * radius / Math.sqrt((distance - radius) * (distance + radius));
}

export function selectPlanetLod(projectedRadius, quality = 'auto', previous) {
  const cap = qualityCap(quality);
  let level = Number.isInteger(previous) ? Math.max(0, Math.min(previous, cap)) : 0;
  const hysteresis = Number.isInteger(previous);
  while (level < cap && projectedRadius > THRESHOLDS[level] * (hysteresis ? 1.15 : 1)) level++;
  while (level > 0 && projectedRadius < THRESHOLDS[level - 1] * .85) level--;
  return level;
}

/** One pool per view, borrowed by all planet surfaces and atmospheres. */
export function createPlanetLod() {
  const geometries = new Map();
  let disposed = false;
  function geometry(level = 1) {
    if (disposed) throw new Error('Planet LOD pool has been disposed');
    if (!Number.isInteger(level) || !SEGMENTS[level]) throw new RangeError('Invalid planet LOD level');
    if (!geometries.has(level)) geometries.set(level, new THREE.SphereGeometry(1, ...SEGMENTS[level]));
    return geometries.get(level);
  }
  return {
    geometry,
    update(meshes, options) {
      const level = selectPlanetLod(projectedPlanetRadius(options), options.quality, meshes[0]?.userData.planetLodLevel);
      const selected = geometry(level);
      for (const mesh of meshes) {
        mesh.geometry = selected;
        mesh.userData.planetLodLevel = level;
      }
      return level;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const value of geometries.values()) value.dispose();
      geometries.clear();
    },
  };
}
