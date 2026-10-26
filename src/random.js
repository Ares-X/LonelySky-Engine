/** Stable UTF-16 FNV-1a hash to an unsigned 32-bit integer. */
export function hashSeed(value) {
  if (typeof value !== 'string') throw new TypeError('Seed must be a string');
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

/** Returns an independent deterministic random stream, never using global state. */
export function randomFromSeed(seed) {
  if (typeof seed === 'string') seed = hashSeed(seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('Random seed must be a string or unsigned 32-bit integer');
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
