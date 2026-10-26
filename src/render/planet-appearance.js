import { randomFromSeed } from '../random.js';

/** Visual approximations, not inferred physical composition or habitability. */
export const PLANET_APPEARANCE_FAMILIES = Object.freeze(Object.fromEntries([
  ['banded-jovian', 'gas', '木星式条带', '宽阔云带与椭圆风暴环绕气态世界。', 0xb19169, 0xe6d4b1],
  ['pale-cloud-giant', 'gas', '浅云巨行星', '淡色云层中，细密的纬向急流逐渐隐入暮色。', 0xa8b5ad, 0xe5e8d9],
  ['blue-ice-giant', 'gas', '蓝色冰巨星', '深蓝大气与稀薄的明亮云丝铺满远方的圆面。', 0x285480, 0x8cbac8],
  ['continental', 'ocean', '大陆与海', '不规则陆块、浅海与薄云，在昼夜边界相遇。', 0x123b55, 0x8e9870],
  ['ocean-world', 'ocean', '无岸海洋', '辽阔海面下有隐约的色泽层次，云系独自在其上回旋。', 0x103956, 0x257c8b],
  ['fractured-ice', 'ice', '裂纹冰壳', '蓝灰色冰壳被交错的长裂隙分割。', 0x789eaf, 0xd9e9e8],
  ['glacial', 'ice', '冰川荒原', '层叠的霜白冰原与暗色岩脊静卧在寒光中。', 0x7c8b97, 0xe4e9e6],
  ['cratered', 'rock', '陨坑荒原', '大小陨坑叠压在古老岩面，留下漫长撞击的痕迹。', 0x665e56, 0xb1a496],
  ['arid-desert', 'rock', '风蚀沙海', '赭色盆地与成片沙脊延伸到弯曲的地平线。', 0x90634b, 0xd1ad7c],
  ['volcanic', 'lava', '熔火裂谷', '暗色凝固地壳间，灼热裂隙在背光处仍有微光。', 0x342b2b, 0xff702d],
].map(([family, kind, name, description, colorA, colorB], index) => [family,
  Object.freeze({ code: index + 1, kind, name, description, colorA, colorB })])));
const byKind = Object.freeze(Object.fromEntries(['gas', 'ocean', 'ice', 'rock', 'lava'].map(kind =>
  [kind, Object.freeze(Object.keys(PLANET_APPEARANCE_FAMILIES).filter(key => PLANET_APPEARANCE_FAMILIES[key].kind === kind))])));

/** Independent per-body appearance stream; never advances body generation or changes its contract. */
export function describePlanetAppearance(body) {
  if (!body || typeof body.id !== 'string' || !body.id || body.homeId || body.home
    || body.texture || body.proceduralSurface || !byKind[body.kind]) return null;
  const random = randomFromSeed(`${body.id ?? ''}:${body.seed ?? 0}:planet-appearance-v1`);
  const families = byKind[body.kind], family = families[Math.floor(random() * families.length)];
  const profile = PLANET_APPEARANCE_FAMILIES[family];
  return Object.freeze({ revision: 1, family, surfaceStyle: profile.code,
    colorA: profile.colorA, colorB: profile.colorB, detailScale: .88 + random() * .24 });
}
