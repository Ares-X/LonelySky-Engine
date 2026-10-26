import { CELL_SIZE, decodeCell, encodeCell, wrapCell } from './coordinates.js';

export { CELL_SIZE };
export const STREAM_RADIUS = 2;
export const VIEW_FAR = 36000;
export const FADE_START = 25000;

/** Smooth camera-to-centre distance fade. Invalid distances are invisible. */
export function visibilityAtDistance(distance) {
  if (typeof distance !== 'number' || Number.isNaN(distance)) return 0;
  if (distance <= FADE_START) return 1;
  if (distance >= VIEW_FAR) return 0;
  const fraction = (distance - FADE_START) / (VIEW_FAR - FADE_START);
  return 1 - fraction * fraction * (3 - 2 * fraction);
}

/** 125 neighbouring cells; wrapped addresses, offsets relative to the origin cell. */
export function loadedCells(index) {
  const centre = decodeCell(index), cells = [];
  for (let dx = -STREAM_RADIUS; dx <= STREAM_RADIUS; dx += 1) {
    for (let dy = -STREAM_RADIUS; dy <= STREAM_RADIUS; dy += 1) {
      for (let dz = -STREAM_RADIUS; dz <= STREAM_RADIUS; dz += 1) {
        cells.push({ index: encodeCell({ x: wrapCell(centre.x + dx), y: wrapCell(centre.y + dy), z: wrapCell(centre.z + dz) }),
          offset: [dx * CELL_SIZE, dy * CELL_SIZE, dz * CELL_SIZE] });
      }
    }
  }
  return cells;
}
