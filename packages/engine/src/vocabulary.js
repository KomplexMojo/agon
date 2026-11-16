/**
 * `@agon-engine/engine/vocabulary` (#828): the words the engine and a game share, as data. Affinity
 * kinds and expressions, vitals, motivations, the sound cues a turn can raise, and the turn event kinds (#864). Re-exports only.
 */
export * from "../../runtime/src/contracts/game-vocabulary.js";
export * from "../../runtime/src/contracts/sound-cues.js";
export { TURN_EVENT_KINDS } from "../../runtime/src/contracts/turn-events.js";
