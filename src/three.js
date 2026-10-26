// Optional Three.js adapter. The data/physics entry point never loads WebGL.
export { createUniverseView } from './render/view.js';
export { createNebula } from './render/nebula.js';
export { createBlackHole } from './render/blackhole.js';
export { createDeepSky, deepSkyUniforms, setDeepSkyEnvironment } from './render/deep-sky.js';
export { planetMaterial, atmosphereMaterial, ringMaterial, starMaterial } from './render/materials.js';
export * from './render/cosmos.js';
export { createGalaxyHaze, galaxyHazeScale } from './render/galaxy-haze.js';
