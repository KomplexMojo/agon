# Building a game on Agon

Agon is the engine; a game brings its look, sound, levels and story. This guide walks the loop a game runs, using
Primordial (the first game built on Agon) as the worked example. It describes what exists today; the full list of
importable modules and the rules for changing them are in [`engine-api.md`](engine-api.md).

A complete runnable version of sections 2 to 4 is in `examples/minimal-game/`.

## The split

| Agon decides | The game decides |
|---|---|
| What is legal, what it costs, what it does, who can see what | What it looks and sounds like, and what the player is shown |
| How levels are built, priced and validated | Which levels ship, their order and story |
| How AI-driven actors choose | How opponents are presented |

If the game needs different behaviour from the engine, it files an `api-request` in the engine repository. The
engine never reaches into the game, and the game never imports `core-ts`. `tests/architecture/framework-game-boundary.test.js`
enforces both.

## 1. Install

```bash
npm install @agon-engine/engine
```

The public API is five named entries: `@agon-engine/engine/client` (play and draw), `/authoring` (build levels
and characters), `/skin` (palette, sprites, resource bundle), `/vocabulary` (kinds, vitals, motivations, sound
cues) and `/terminal` (the reference terminal client). `z3-solver` is an optional peer, needed only for
solver commands.

## 2. Get a level

Levels come from the `agon` command (or the `agon_create` MCP tool), never from hand-priced files. Describe the level
and the Allocator prices it against a token budget:

```bash
node node_modules/@agon-engine/engine/dist/adapters-cli/cli/agon.mjs create \
  --room "size=small;count=1" \
  --delver "count=1;affinity=fire;motivation=user_controlled" \
  --warden "count=1;affinity=dark;motivation=defending" \
  --out-dir ./levels/first
```

The run directory holds the artifacts a game uses: `sim-config.json`, `initial-state.json`, `resource-bundle.json`
and a budget receipt. A level with no receipt still plays, but the session reports it as unpriced
(`session.pricingReport`), so a game can warn about hand-written content.

A game can also spawn the command line from code. `playtest-scenarios.js` exports `AGON_CLI`, the resolved path of
`agon.mjs`, and a shared catalogue of ready-made scenarios (`loadPlaytestScenarios()`).

## 3. Play a level

`@agon-engine/engine/client` is the one entry a client needs:

```js
import { createPlaySession } from "@agon-engine/engine/client";

const session = await createPlaySession({ simConfig, initialState });
let result = await session.act({ kind: "move", params: { direction: "east" } });
const view = session.view();   // the board, sight, HUD data and legend for this turn
```

The session runs the real tick loop. Your command is the player's decision; every other actor decides through its
own persona, so opponents, hazards and companions all act under the same rules. `result` reports what was accepted
or rejected, and sound and animation cues for the turn. `result.events` lists what happened in the turn as data, so a
client can animate without comparing two views. Each event has `tick`, `seq` (its order in the run) and `event`, which is
one of `TURN_EVENT_KINDS` (on `/vocabulary`):

| `event` | Fields |
|---|---|
| `move` | `sourceId`, `from` (left out when you did not see where it came from), `to`, `sprint` |
| `cast` | `sourceId`, `targetId`, `kind`, `expression`, `struck`, `reception`; on your side's hit, the words `hit` and `condition` |
| `field` | `sourceId`, `targetId`, `kind`, `expression`: a lasting field started hurting `targetId` |
| `vital` | `targetId`, `vital`, `delta`, `regen` (the part of `delta` that regeneration gave back). Only for your own side |
| `take` | `sourceId`, `targetId`, `taken` |
| `defeat` | `targetId`, `defeatVital`, and the `sourceId`, `kind` and `expression` that did it |
| `exit` | `targetId` |

Under fog only what your party saw or took part in is listed. `session.eventsSince(seq)` returns the events after a
`seq`, and the game controller's `frame().events` holds the last call's. `session.status()` says whether the run is won, lost or still
going: `outcome` is `playing`, `won` or `lost`, and `objectives` lists the level's objectives (#867), each
`{ id, kind, required, state }` with `state` `open`, `met` or `failed` and, where something is counted, `progress`
`{ done, of }`. A level with no `objectives` has one, `reach_exit`, so it is won on leaving and lost on defeat.
`view().status` carries the same report for a HUD. `captureInput()` records the commands, and `replayPlaySession` re-simulates them, which is how a run is
verified or shared.

### Save and resume

`session.save({ meta })` returns an `agon/PlaySave`: the capture plus the level it belongs to, the engine version
(`ENGINE_VERSION`) and a digest of the state it reached. Store it however your game likes. To continue:

```js
import { resumePlaySession } from "@agon-engine/engine/client";

const session = await resumePlaySession({ simConfig, initialState, save });
```

Resume replays the commands through the same tick loop, so there is no second way to build state. It throws an
error with `code` `PLAY_SAVE_WRONG_LEVEL` when the save is for another level, and `PLAY_SAVE_STALE` when this
engine's rules no longer reproduce the saved state (the message names both engine versions). A newer engine that
still reproduces the state resumes normally. `validatePlaySave` checks a save's shape without running it. The game
controller has `save(meta)` and a `resume: { levelIndex, save }` option that starts the level fresh, with a message,
when the save is stale.

### Wording

The game controller's sentences (refusals, battle and vital lines, loot and order replies) are data first.
`frame().messageData` is the list of `{ id, params }` behind `frame().message`; params are numbers, ids, affinity keys
and positions, never English. To re-word or translate, pass a catalogue of templates for the ids you want to change:

```js
import { createGameController, MESSAGE_IDS } from "@agon-engine/engine/client";

const game = await createGameController({ levels, messages: {
  [MESSAGE_IDS["slot.empty"]]: ({ slot }) => `Emplacement ${slot} vide.`,
} });
```

Ids you leave out keep `DEFAULT_MESSAGES`; `formatMessage({ id, params }, catalogue)` words one message. Battle-log
lines (`view().battleLog[].text`) are render's wording and not catalogued yet.

## 4. Draw it

Agon never draws. `view()` and `buildBoardDrawModel` return data: what is on each cell, what the player can see, what
is remembered, and which actors and resources are present. Everything visual comes from the **ResourceBundle**, the
only art contract:

- `createDefaultResourceBundleArtifact` gives the engine's plain defaults.
- `dressResourceBundle` lets the game layer its own sprites, palette and animation on top, validated by
  `validateResourceBundleArtifact`.
- `resolveElementArt` maps a game element (an affinity, a role, a resource) to the art the bundle names for it.

For a board with controls, drive the game controller and paint its board frame:

```js
import { createGameController, buildBoardFrame } from "@agon-engine/engine/client";

const game = await createGameController({ levels: [level], window: 11 });
const board = buildBoardFrame(game.frame());
// board.cells / board.overlay / board.entities / board.cursor: the play window, in window coordinates
await game.pointAt({ x: tapX + board.origin.x, y: tapY + board.origin.y });   // a tap on the board
```

`buildBoardFrame` cuts the draw model and the affinity overlay to the play window (around the player, or around the
aim cursor while aiming) and carries the cursor, so a client never draws the whole level or re-implements the
window. `pointAt` turns a tapped tile into the right thing for the open panel: move the aim cursor, pick a target,
or step to an adjacent tile.

A terminal client, a phone app and a graphical client can all sit on the same data. The reference terminal client
(`packages/ui-ascii`, run with `agon play`) is the smallest example.

## Primordial as the example

| Concern | Where it lives |
|---|---|
| Affinities, vitals, motivations, fog of war, turn order | Agon |
| Token prices, budgets, receipts | Agon (the Allocator) |
| Level generation and validation | Agon (`agon create`) |
| AI-driven opponents | Agon (the Actor persona) |
| Draw model and HUD model | Agon (`@agon-engine/engine/client`) |
| Palette, glyphs, sprites, animation, sound | Primordial |
| The phone app and its screens | Primordial |
| Scenarios it ships, lore, story | Primordial (the shared playtest catalogue stays in the engine) |

When Primordial shows a fire wizard casting at a warden, Agon decided that the cast was legal, what it cost, what it
did and who was in sight. Primordial decided what it looks and sounds like.

## Rules of thumb

- Put game rules in the engine through an `api-request`, never in the client.
- Never hand-price content. If a level needs a number, it comes from `agon create` and the Allocator.
- Import only listed modules. A missing export is an `api-request`, not a deep import.
- Pin an exact engine version while it is on 0.x, and read `CHANGELOG.md` when bumping.
