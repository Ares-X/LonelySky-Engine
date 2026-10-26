/** Centered local cell size in caller-defined world units. */
export const CELL_SIZE = 20000;
/** Largest Morton address: 15 signed bits for each of three axes. */
export const MAX_SECTOR = 2 ** 45 - 1;

/** Wrap an integer cell coordinate across the toroidal address boundary. */
export const wrapCell = n => ((n + 16384) % 32768 + 32768) % 32768 - 16384;

export function encodeCell({ x, y, z }) {
  const coordinates = [x, y, z];
  if (!coordinates.every((n) => Number.isInteger(n) && n >= -16384 && n <= 16383)) {
    throw new RangeError('Cell coordinates must be integers from -16384 to 16383');
  }
  const zigzag = coordinates.map((n) => BigInt(n < 0 ? -n * 2 - 1 : n * 2));
  let value = 0n;
  for (let bit = 0n; bit < 15n; bit += 1n) {
    for (let axis = 0n; axis < 3n; axis += 1n) value |= ((zigzag[Number(axis)] >> bit) & 1n) << (bit * 3n + axis);
  }
  return Number(value);
}

export function decodeCell(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_SECTOR) throw new RangeError('Cell index is outside the address space');
  const value = BigInt(index);
  const coordinates = [0n, 0n, 0n];
  for (let bit = 0n; bit < 15n; bit += 1n) {
    for (let axis = 0n; axis < 3n; axis += 1n) coordinates[Number(axis)] |= ((value >> (bit * 3n + axis)) & 1n) << bit;
  }
  const [x, y, z] = coordinates.map((n) => Number(n & 1n ? -(n + 1n) / 2n : n / 2n));
  return { x, y, z };
}
