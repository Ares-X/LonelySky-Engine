import { randomFromSeed } from '../random.js';

/** Astronomically inspired display families, not a radiative-transfer simulation. */
export const NEBULA_APPEARANCE_FAMILIES = Object.freeze(Object.fromEntries([
  ['emission-cloud', '发射星云', '受激气体的暗红微光，沿着尘柱的边缘渐渐显露。', 0x743f46, 0xb17a69, .36, .22, .45, .16, 1],
  ['reflection-dust', '反射尘云', '附近星光照亮蓝灰尘埃，背光处逐渐沉入阴影。', 0x294968, 0x7996ad, .008, .9, 0, .12, 1.15],
  ['dark-cloud', '暗星云', '厚重尘埃遮住背后的星光，只留下极淡的边缘。', 0x141722, 0x292b32, 0, .035, 0, .015, 1.5],
  ['planetary-shell', '行星状星云', '恒星晚期抛出的气体形成空心壳层，冷暖微光沿壳交织。', 0x36746e, 0xa97965, .48, .12, .35, .22, .9],
  ['supernova-remnant', '超新星遗迹', '破碎的气体壳上，稀疏的发光丝缕勾出遥远爆发的余迹。', 0x71504a, 0x789b9c, .42, .12, .55, .42, 1],
].map(([family, name, description, colorA, colorB, emission, scattering, excitation, rimStrength, extinction], index) =>
  [family, Object.freeze({ code: index + 1, name, description, colorA, colorB, emission, scattering, excitation, rimStrength, extinction })])));

const fixedFamily = Object.freeze({ columns: 'emission-cloud', halo: 'planetary-shell', knots: 'reflection-dust', rift: 'dark-cloud', shell: 'supernova-remnant' });

/** Fixed independent stream: appearance never advances universe generation or moves its geometry. */
export function describeNebulaAppearance({ seed = 1, morphology } = {}) {
  if (!Object.hasOwn(fixedFamily, morphology) && morphology !== 'wisps' && morphology !== 'stream') return null;
  const random = randomFromSeed(`${seed}:nebula-appearance-v1`);
  const selection = random();
  const family = fixedFamily[morphology] ?? (selection < .45 ? 'reflection-dust' : selection < .8 ? 'emission-cloud' : 'dark-cloud');
  const profile = NEBULA_APPEARANCE_FAMILIES[family];
  const azimuth = random() * Math.PI * 2, height = random() * 1.4 - .7;
  const radial = Math.sqrt(1 - height * height);
  const lightDirection = Object.freeze([Math.cos(azimuth) * radial, height, Math.sin(azimuth) * radial]);
  return Object.freeze({ revision: 1, family, ...profile, lightDirection, phase: random() * Math.PI * 2 });
}
