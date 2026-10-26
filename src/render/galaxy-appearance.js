import { randomFromSeed } from '../random.js';

/** Additive visual character: never consumes the address or particle streams. */
export function describeGalaxyAppearance(descriptor) {
  if (!descriptor || typeof descriptor.seed !== 'string' || !['spiral', 'elliptical', 'irregular'].includes(descriptor.morphology)) {
    throw new TypeError('Galaxy appearance requires a seeded morphology');
  }
  const random = randomFromSeed(`${descriptor.seed}:appearance-v1`);
  const variant = random();
  const family = descriptor.morphology === 'spiral'
    ? descriptor.bar ? 'barred-spiral' : variant < .5 ? 'grand-spiral' : 'dust-disk'
    : descriptor.morphology === 'elliptical' ? 'ancient-halo'
      : variant < .5 ? 'tidal-islands' : 'stellar-nursery';
  const settings = {
    'grand-spiral': { offset: [.16, 2, 1.45], fov: 52, armStrength: 3.6, coreStrength: 1.6, dustStrength: .28, haloStrength: .07, bridgeStrength: 0, knotScale: 1, youngStrength: .48 },
    'barred-spiral': { offset: [.8, 1.5, 1.75], fov: 52, armStrength: 3.1, coreStrength: 1.8, dustStrength: .42, haloStrength: .1, bridgeStrength: 0, knotScale: 1, youngStrength: .36 },
    'dust-disk': { offset: [.23, .17, 2.55], fov: 50, armStrength: 1.6, coreStrength: 3.4, dustStrength: 1.4, haloStrength: .18, bridgeStrength: 0, knotScale: 1, youngStrength: .16 },
    'ancient-halo': { offset: [1.1, .65, 2.4], fov: 50, armStrength: 0, coreStrength: 4.1, dustStrength: 0, haloStrength: .48, bridgeStrength: 0, knotScale: 1, youngStrength: 0 },
    'tidal-islands': { offset: [1.8, .65, 1.8], fov: 54, armStrength: 0, coreStrength: 0, dustStrength: 0, haloStrength: .06, bridgeStrength: .17, knotScale: .68, youngStrength: .18 },
    'stellar-nursery': { offset: [.5, 1.8, 1.9], fov: 52, armStrength: 0, coreStrength: 0, dustStrength: 0, haloStrength: .04, bridgeStrength: .02, knotScale: .42, youngStrength: .8 },
  }[family];
  const { offset, fov, ...controls } = settings;
  // Modest seeded exposure variation does not change the structural family.
  return Object.freeze({ revision: 1, family, ...controls, emissionStrength: .94 + random() * .12,
    viewing: Object.freeze({ offset: Object.freeze([...offset]), fov }) });
}
