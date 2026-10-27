/** Centered local cell size in caller-defined world units. */
export const CELL_SIZE = 20000;
/** Largest Morton address: 15 signed bits for each of three axes. */
export const MAX_SECTOR = 2 ** 45 - 1;

/** Wrap an integer cell coordinate across the toroidal address boundary. */
export const wrapCell = n => ((n + 16384) % 32768 + 32768) % 32768 - 16384;

export function encodeCell({ x, y, z }) {
  if (!Number.isInteger(x) || x < -16384 || x > 16383
    || !Number.isInteger(y) || y < -16384 || y > 16383
    || !Number.isInteger(z) || z < -16384 || z > 16383) {
    throw new RangeError('Cell coordinates must be integers from -16384 to 16383');
  }
  let ix = x < 0 ? -x * 2 - 1 : x * 2;
  let iy = y < 0 ? -y * 2 - 1 : y * 2;
  let iz = z < 0 ? -z * 2 - 1 : z * 2;
  let value = 0, place = 1;
  // Each Morton digit contains one bit from each 15-bit coordinate. Summing
  // base-eight digits stays below 2^45, exactly inside Number's integer range;
  // bitwise operations only touch the individual 15-bit coordinates.
  for (let bit = 0; bit < 15; bit += 1) {
    value += ((ix & 1) | ((iy & 1) << 1) | ((iz & 1) << 2)) * place;
    ix >>>= 1; iy >>>= 1; iz >>>= 1;
    place *= 8;
  }
  return value;
}

export function decodeCell(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_SECTOR) throw new RangeError('Cell index is outside the address space');
  let value = index, x = 0, y = 0, z = 0;
  for (let bit = 0; bit < 15; bit += 1) {
    const digit = value % 8;
    x |= (digit & 1) << bit;
    y |= ((digit >> 1) & 1) << bit;
    z |= ((digit >> 2) & 1) << bit;
    value = Math.floor(value / 8);
  }
  return { x: x & 1 ? -(x + 1) / 2 : x / 2,
    y: y & 1 ? -(y + 1) / 2 : y / 2,
    z: z & 1 ? -(z + 1) / 2 : z / 2 };
}
