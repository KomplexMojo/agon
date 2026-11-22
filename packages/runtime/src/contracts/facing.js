/**
 * Actor facing (#898): which way an actor last stepped, as one of four cardinal names, so every
 * client dresses the same pose without keeping its own movement history. The Annotator's `move`
 * entries are the only input; the play session reads them (it derives nothing else).
 *
 * Cardinalization, stated once: a step takes the axis it moves farther along; a perfect diagonal
 * takes the horizontal axis (east or west). y grows downward, so a negative dy is north.
 */

/** Every facing, in the order a client lists its poses. */
export const FACINGS = Object.freeze(["north", "east", "south", "west"]);

/** What an actor faces before it has moved: south, the pose a sprite sheet calls Idle_Down. */
export const DEFAULT_FACING = "south";

/** The facing of one step (`dx`, `dy`), or null for no step. */
export function facingOfStep(dx, dy) {
  if (!dx && !dy) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "east" : "west";
  return dy > 0 ? "south" : "north";
}
