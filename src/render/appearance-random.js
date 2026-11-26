/** Cold, independent visual identity stream. Does not advance world generation. */
export function createAppearanceRandom(id, seed) {
  const key = JSON.stringify([id, seed]);
  // cyrb128: retain four independently mixed 32-bit channels of the full key.
  let a = 1779033703, b = 3144134277, c = 1013904242, d = 2773480762;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    a = b ^ Math.imul(a ^ ch, 597399067);
    b = c ^ Math.imul(b ^ ch, 2869860233);
    c = d ^ Math.imul(c ^ ch, 951274213);
    d = a ^ Math.imul(d ^ ch, 2716044179);
  }
  a = Math.imul(c ^ a >>> 18, 597399067);
  b = Math.imul(d ^ b >>> 22, 2869860233);
  c = Math.imul(a ^ c >>> 17, 951274213);
  d = Math.imul(b ^ d >>> 19, 2716044179);
  const mixed = (a ^ b ^ c ^ d) >>> 0;
  b = (b ^ a) >>> 0; c = (c ^ a) >>> 0; d = (d ^ a) >>> 0; a = mixed;
  // sfc32: construction-local 128-bit state, never shared between visits/bodies.
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let value = (a + b) | 0;
    a = b ^ b >>> 9;
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    value = (value + d) | 0;
    c = (c + value) | 0;
    return (value >>> 0) / 4294967296;
  };
}
