// Optional Three.js adapter. The data/physics entry point never loads WebGL.
export { createUniverseView } from './render/view.js';
export { createNebula } from './render/nebula.js';
export { createBlackHole } from './render/blackhole.js';
export { createDeepSky, deepSkyUniforms, setDeepSkyEnvironment } from './render/deep-sky.js';
export { planetMaterial, atmosphereMaterial, ringMaterial, starMaterial } from './render/materials.js';
export { describePlanetAppearance, PLANET_APPEARANCE_FAMILIES } from './render/planet-appearance.js';
export { describeNebulaAppearance, NEBULA_APPEARANCE_FAMILIES } from './render/nebula-appearance.js';
export { createStellarRemnant } from './render/stellar-remnant.js';
export * from './render/cosmos.js';
export { createGalaxyHaze, galaxyHazeScale } from './render/galaxy-haze.js';
export { describeGalaxyAppearance } from './render/galaxy-appearance.js';
