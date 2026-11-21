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

/**
 * Floor decor (#884): a sparse, busy accent on a few floor cells, kept apart from the quiet
 * `floorVariant` faces so busy art never clumps. A pure function of the cell's place in the true
 * grid and the level seed (same under fog and in any window crop, O(1), no neighbour lookup).
 *
 * The grid is cut into DECOR_BLOCK x DECOR_BLOCK blocks. Each block holds at most one decor, and
 * only in its inner 2x2 cells, so two decor cells are always at least 3 apart (never on a shared
 * cardinal or diagonal edge) and there is never more than one decor per DECOR_BLOCK^2 = 16 cells.
 * About a quarter of blocks hold none, so it does not read as a lattice. A decor on a wall is
 * simply not shown (the draw model reads decor on floor, spawn and exit cells only).
 */
export const DECOR_BLOCK = 4;
/** Decor slots are numbered 0..FLOOR_DECOR_COUNT-1. */
export const FLOOR_DECOR_COUNT = 4;

// A separate salt from the floor variant's hash, so a cell's decor says nothing about its variant.
const DECOR_SALT = 0x5bd1e995;

/** The decor slot (0..FLOOR_DECOR_COUNT-1) at (x, y) in a level with this seed, or null for no decor. */
export function floorDecorAt(x, y, seed = 0) {
  const block = DECOR_BLOCK;
  const h = mix32(Math.floor(x / block), Math.floor(y / block), (Number.isFinite(seed) ? seed | 0 : 0) ^ DECOR_SALT);
  if (h % 4 === 0) return null;
  const col = 1 + ((h >>> 2) & 1);
  const row = 1 + ((h >>> 3) & 1);
  if (((x % block) + block) % block !== col || ((y % block) + block) % block !== row) return null;
  return (h >>> 4) % FLOOR_DECOR_COUNT;
}
