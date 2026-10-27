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
  // Independent of the established family, exposure and viewing streams. One
  // population balance changes related structures together instead of giving
  // every coefficient unrelated noise. A second balance controls dispersion.
  const structure = randomFromSeed(`${descriptor.seed}:galaxy-structure-v1`);
  const population = structure(), dispersion = structure();
  if (family === 'grand-spiral' || family === 'barred-spiral') {
    // Young arm-rich disks contrast with older, more concentrated centers.
    const barred = family === 'barred-spiral';
    controls.armStrength = (barred ? 2.7 : 3.1) + population * 1.1;
    controls.coreStrength = (barred ? 2.1 : 1.85) - population * .65;
    controls.youngStrength = (barred ? .24 : .35) + population * .24;
    controls.dustStrength = (barred ? .32 : .2) + population * (barred ? .18 : .12);
    controls.haloStrength = (barred ? .08 : .05) + dispersion * .03;
  } else if (family === 'dust-disk') {
    // More obscured disks have bright banks around a suppressed center, while
    // retaining stronger dust and weaker resolved arms than face-on spirals.
    controls.dustStrength = 1.3 + population * .4;
    controls.coreStrength = 3.9 - population * .8;
    controls.armStrength = 1.35 + population * .45;
    controls.youngStrength = .1 + population * .12;
    controls.haloStrength = .13 + dispersion * .08;
  } else if (family === 'ancient-halo') {
    // Concentrated nuclei trade light with a broader old stellar envelope.
    controls.coreStrength = 3.5 + population * 1.2;
    controls.haloStrength = .64 - population * .22;
  } else if (family === 'tidal-islands') {
    // Diffuse, connected islands versus compact islands with darker gaps.
    controls.knotScale = .64 + dispersion * .16;
    controls.bridgeStrength = .13 + dispersion * .08;
    controls.haloStrength = .035 + dispersion * .035;
    controls.youngStrength = .12 + population * .14;
  } else {
    // Active nurseries resolve into tighter young associations. Keep their
    // envelopes and bridges faint so separate knots never merge into a plate.
    controls.knotScale = .42 - population * .1;
    controls.youngStrength = .65 + population * .4;
    controls.bridgeStrength = .01 + dispersion * .013;
    controls.haloStrength = .02 + dispersion * .025;
  }
  // Modest seeded exposure variation does not change the structural family.
  return Object.freeze({ revision: 1, family, ...controls, emissionStrength: .94 + random() * .12,
    viewing: Object.freeze({ offset: Object.freeze([...offset]), fov }) });
}
