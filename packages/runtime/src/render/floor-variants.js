/**
 * Floor face variants (#854): a small stable index per floor cell, so a graphical client can
 * dress floors with several faces without hashing coordinates itself. A pure function of the
 * cell's place in the true level grid and the level seed: it does not depend on sight, on
 * the play window's crop, or on neighbours, and costs a few integer operations per cell.
 */

/** Variants are numbered 0..FLOOR_VARIANT_COUNT-1. */
export const FLOOR_VARIANT_COUNT = 8;

function mix32(x, y, seed) {
  let h = Math.imul(x ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul((y + 0x7f4a7c15) | 0, 0xc2b2ae35) ^ Math.imul((seed | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** The variant (0..FLOOR_VARIANT_COUNT-1) of the floor at (x, y) in a level with this seed. */
export function floorVariantAt(x, y, seed = 0) {
  return mix32(x, y, Number.isFinite(seed) ? seed : 0) % FLOOR_VARIANT_COUNT;
}
