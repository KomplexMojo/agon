# Changelog

The engine API contract and stability policy are in `docs/engine-api.md`. Entries name changes to the public API (`apiSurface`, `agon`, `agon_*` MCP tools) only.

## Unreleased

### Added

- Level objectives, step 4 (#867): `agon create --objective "kind=defeat;role=warden"` (repeatable; `objectives` on the `agon_create` MCP tool) authors them, and the Configurator refuses an objective the built level cannot satisfy (no such actor or role, too few holdings to collect). `parseObjectiveSpec`, `checkLevelObjectives` and `withLevelObjectives` are on the Configurator controller. A level built without `--objective` is unchanged. Additive.
- Level objectives, step 3 (#867): `session.status()` (and so every turn result and `view().status`) gains `outcome` (`playing`, `won`, `lost`) and `objectives`, as the Moderator judges them for the level's player. `exited`, `atExit` and `defeated` keep their meaning, and a level with no objectives reads `won` exactly when the player has left. The session does not stop on its own when a run is won by another objective; the client reads `outcome`. Additive.
- Level objectives, step 2 (#867): the Moderator judges them. `evaluateLevelObjectives` (Moderator controller) returns each objective's state (`open`, `met`, `failed`, with `progress` where it counts) and the run's `outcome` (`playing`, `won`, `lost`) from facts only, so a replay reads the same. With no objectives that is won on exit, lost on defeat. Not yet wired into the session. Additive.
- Level objectives, step 1 (#867): SimConfig may carry `objectives`, a list from a closed vocabulary (`reach_exit`, `defeat`, `survive`, `collect`, `escort`, `within`), each `{ id, kind, params, required }`. Absent means one required `reach_exit`, so every existing level is unchanged. `OBJECTIVE_KINDS`, `OBJECTIVE_STATES` and `OBJECTIVE_HOLDING_KINDS` are on `/vocabulary`. Evaluation and the session report follow. Additive.
- Turn events (#864): every turn result that has `cues` (`act`, `actTick`, `order`, `advance`, `autoTick`) also has `events`, what happened in its ticks as data: `move`, `cast`, `field`, `vital`, `take`, `defeat`, `exit`, each with `tick` and `seq`. The Annotator derives them; the session filters them like the cues. `vital` events carry numbers and reach only the seat's own side. `session.eventsSince(seq)` and the controller's `frame().events` give the same list. `TURN_EVENT_KINDS` is exported on `/vocabulary`. `agon/BattleLogEntry` gains the `move` and `vital` events, which the worded battle log and the cues leave out. Additive.
- Fog that returns when you leave (#858): `createPlaySession({ fog: true, fogMemory: false })` (and `createGameController({ fogMemory: false })`) shows only what is in sight now. Every other cell is `UNKNOWN`, with no `REMEMBERED` board, so only base sight (adjacent cells when unlit) and light emit reveal tiles, and a lit cell turns back to fog once the light is gone or out of sight. The session still keeps what was seen for the rooms notebook. Default `true`, so behaviour is unchanged unless a client opts in.
- `examples/minimal-game/` (#869): the smallest complete game, authoring a level with `authorLevel`, playing it with `createPlaySession` and printing the board, importing only the published entries. The suite runs it. No API change.
- Player wording as data (#865): every controller sentence has an id in `MESSAGE_IDS` with today's English in `DEFAULT_MESSAGES`; `createGameController({ messages })` overrides templates and `frame().messageData` lists the `{ id, params }` behind `message`. `formatMessage` words one. Data twins `rejectionMessageData`, `battleLinesData`, `allyWarningData`, `vitalChangeData`, `takeRefusalData` sit beside the string functions, whose output is unchanged. Additive.
- Save and resume (#863): `session.save({ meta })` returns an `agon/PlaySave` (capture, level ids, `ENGINE_VERSION`, state digest, tick, status), and `resumePlaySession({ simConfig, initialState, save })` replays it, throwing `PLAY_SAVE_WRONG_LEVEL` or `PLAY_SAVE_STALE`. The game controller gains `save(meta)` and a `resume` option. `resumePlaySession`, `validatePlaySave`, `PLAY_SAVE_SCHEMA` and `ENGINE_VERSION` are exported on `/client`. Additive.
- The package installs an `agon` command (`bin`, built with a shebang) and ships a README that says which entry to import (#822). No API change.
- `@agon-engine/engine/authoring/browser` (#846): `authorLevel`, the character sheet and the recorded solver adapter with no Node builtin in the import graph, so a browser bundle can import them. `/authoring` is unchanged and still adds the playtest catalogue, which a Node build script uses. Additive; a test bundles the entry for a browser and fails on any `node:` import.

### Removed

- The seven unused persona `contracts.ts` files (#861, 497 lines, imported by nothing). A persona no longer requires one; `contracts.ts` is out of the controller-only boundary's public files. Not part of the public API.
- `agon workflow` and the `agon_workflow_*` MCP tools (and the MCP resources they served), with the whole `AdaptiveWorkflowAgent` control plane, its artifact schemas, model-provider adapters and benchmark tool (#870). Nothing in play, authoring or the public engine entries used them. `agon llm` is unchanged.
- The sandbox WebSocket bridge: the `agon_push_to_ui` MCP tool, `AGON_SANDBOX_BRIDGE_PORT`, and the optional `ws` peer dependency (#859). No client uses them since the web UI moved to Primordial. `agon_sandbox_*` tools are unchanged and still write their artifacts to disk.
- The browser CLI worker, level-builder worker and the browser LLM, IPFS, blockchain and z3 adapters (#859). The recorded solver adapter and `authoring/browser` are unchanged.
- The `ui_cli_equivalence` recipe is no longer scaffoldable by `agon_test_scaffold` (#859); its browser half is gone.

## 0.5.1

### Added

- Floor face variants (#854): draw-model `floor`, `spawn` and `exit` cells carry `floorVariant` (0..`FLOOR_VARIANT_COUNT`-1, 8 variants), a stable per-cell index from the cell's position in the true grid and the level seed, independent of sight and the window crop. `view().floorVariants` is the grid (null in unknown cells). `FLOOR_VARIANT_COUNT` is exported on `/client`. Additive; ASCII output is unchanged.
- Wall blob connectivity for 47-face atlases (#829): draw-model wall cells also carry `wallBlobMask` (0..255, reduced 8-neighbour bits `WALL_BLOB_BITS` = N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128) and `wallBlobSlot` (0..46, index in `WALL_BLOB_MASKS`, ascending). Same true-grid derivation as `wallMask`, but outside the level counts as wall and a diagonal counts only when both cardinals beside it are wall. Frame windows keep full-level values, fog cells carry none. `view().wallBlobMasks` is the grid. `WALL_BLOB_BITS`, `WALL_BLOB_MASKS` and `wallBlobSlot` are exported on `/client`. Additive; `wallMask` and ASCII glyphs are unchanged.

## 0.5.0

### Changed (rules)

No API change. These change prices and mana costs, so levels and characters built on 0.4.0 price differently.

- A harmful kind whose primary vital is health, which is decay today, pays 3 mana a tier for a push or pull where every other kind pays 2 (#833), because its hits go past armour. Emit and draw cost what they did. The `archer` recipe's decay push drops from range 5 to 4 (still 120 mana a shot) and the `leech` recipe's mana rises from 30 to 36, so each can still pay for its cast.
- Mana regen is priced linearly at 3 tokens a point (#834); it was n² like the other regens. Regen 1 costs 3 (was 1), regen 3 costs 9 either way, and anything above is cheaper: regen 18, which casts intensity 3 every turn, costs 54 instead of 324. Health, stamina and durability regen are still n². Every actor carries at least 1 mana regen, so the cheapest actor costs 2 tokens more and minimum level budgets rise with it; recipes that lean on mana regen cost less (`glass-cannon` 432 → 362, `wellspring` 475 → 405 as delvers).
- The 21 configuration recipes are retuned into one price band after the two changes above (#841): every recipe costs 420 to 460 tokens as a delver (they ran 279 to 463). Fifteen recipes gained vitals and mana regen in what they are for; none changed its affinities, ranges or intensities. `scout`, `sneak`, `lantern-bearer` and `watcher` now regenerate enough mana to keep their field lit.

## 0.4.0

### Added

- Five named entry points (#828), which are now the way to import the engine: `@agon-engine/engine/client` (play session, game controller, intents, messages, board frame, HUD and overlay models, window size), `/authoring` (`authorLevel`, character sheet, recorded solver adapter, playtest catalogue), `/skin` (palette, element visuals, board sprite pixels, resource bundle with dressing and element art), `/vocabulary` (affinity kinds and expressions, vitals, motivations, sound cues) and `/terminal` (the reference terminal client). Each only re-exports and its names are pinned by a test. The file-path subpaths (`@agon-engine/engine/runtime/...`, `/ui-ascii/...`, `/adapters-*/...`) still resolve and are unchanged; they are aliases now and will be removed in a later minor release once the game has moved.

### Changed (breaking)

- `@agon-engine/engine/runtime/contracts/domain-constants.js` is no longer public (#828). It exported 80 internal names, among them the engine's LLM prompt builders and model settings; no game imported it. The vocabulary a game needs (`GAME_AFFINITY_KINDS`, `GAME_AFFINITY_EXPRESSIONS`, `GAME_VITAL_KEYS`, the motivation lists) is on `@agon-engine/engine/vocabulary`.

### Changed (rules)

- A same-kind slot resists by its own size instead of cancelling the hit (#831). A push or emit slot of the incoming kind takes its expression's base × its intensity² off each hit of that kind (an emit of intensity 1 takes 1, a push of intensity 2 takes 8); the strongest such slot counts, once, and an opposite slot or a breach doubles only what gets past. Before, any such slot, however small, was total immunity. A same-kind draw still absorbs the whole hit into mana.
- A harmful kind's pull or draw credits its caster half of what the target's vital gave up, rounded down (#832). The target loses what it lost before. Restoring kinds (growth, fortify, light) still credit in full.

### Fixed

- A run with no controlled actor (`agon run`, the simulations) no longer hibernates anyone. The hibernation focus fell back to the level's first actor, so every actor more than 50 tiles from that arbitrary one never decided for the whole run (#702; in `sweep-big-20k`, four patrolling guards were silent for 150 turns). Play sessions, which name their seat, are unchanged.
- A resource whose barrier cage would cut the route from the spawn to the exit gets no cage, and a cage never covers the spawn or exit approach tile (#696). In a narrow room the ring spanned the room wall to wall and sat on the exit approach, so the level could only be finished by breaking furniture (`sweep-demand-recovery`: exit on turn 9 became no exit in 80). Levels with such a resource are built with fewer barriers than before; cages in open floor are unchanged.

## 0.3.2

### Added

- `buildBoardFrame(frame)` on `client-surface.js`: the game controller's frame cut to the play window, for a graphical client to paint. `cells` (draw model) and `overlay` (affinity overlay) are cropped to the window, `entities` are those inside it, all in window coordinates with `origin` giving the window's place on the level, and `cursor` is the aim, raise, target, inspect or watch tile (`{ x, y, kind }`, null when no panel points at a tile). The window follows the aim cursor, as the terminal's does.
- `playWindowBounds({ width, height, windowSize, center })` on `window-size.js` and `client-surface.js`: the window rule itself. The terminal screen now crops with it, so there is one rule; its output is unchanged.
- `createGameController().pointAt({ x, y })`: point at a level tile (a tap or click). While aiming it moves the cursor there; in a target, inspect or watch list it picks whoever stands there (a cast list falls back to aiming at the tile); with no panel open an adjacent tile is a step that way. Returns whether the point meant anything.
- `ui-ascii/game.js` `createGame()` also returns the controller's `frame()`, so a client running the terminal game can draw the board from `buildBoardFrame(game.frame())` and keep `screen({ parts })` for text.
- `targetsInSight(view)` items (and so target, inspect and watch panel items) carry `position`.

### Fixed

- The published `agon` command line could not reach `z3-solver` even when it was installed: the bundle's optional-peer shim imported itself, so `agon create` refused every level whose placement needs the solver with `placement_constraints_need_solver ... (constraint_compile_error)`. This broke the game's build on 0.2.0, 0.3.0 and 0.3.1 for any scenario with a `--tactic`. `ws` had the same fault. The refusal now also carries the solver's own message, so a missing peer says so.

## 0.3.1

### Added

- Wall connectivity for graphical clients (#817): `buildBoardDrawModel` cells with `tile: "wall"` carry `wallMask` (0..15, bits `WALL_NEIGHBOUR_BITS` = north 1, east 2, south 4, west 8), the same true-grid rule as the ASCII wall glyphs, so remembered walls join under fog; fog cells carry none. `view().wallMasks` is the underlying grid (null off walls and in unknown cells; also null where a level draws walls its own way). `WALL_NEIGHBOUR_BITS` is exported from `client-surface.js`. Additive; `tile` is unchanged.

## 0.3.0

### Added

- `buildAffinityBoardOverlayModel(view)` on `client-surface.js` (#814): per cell, the field layer (mark, tint `{mix, alpha, valence}`, per-kind contributors with `weight`, `falloff`, `intensity`, `stacks`, `strength`, `restores`, `vital`, `sources`), the draw layer, the last tick's cast arrow (`glyph`, `direction`, kind hex) and defeat or spent marks, from the fog-masked view. The tint maths is one shared `affinityFieldTint` in `ascii-cell-style.js` that the terminal also paints with, so ASCII output is unchanged.
- `view().drawField` (#815): lasting draw sustains in a grid of their own (`expression: "draw"` on each entry, `restores: false`), masked by sight like `view.field`, with your own reach kept in fog. `view.field` still holds emit and push only. Cast path cells in `view().casts` also carry `direction` (`north`, `southeast`, ...).
- `agon play` / `play-session` take `--logical-keys` (a JSON array of key names such as `["ArrowUp","Enter","Escape"]`), and the `agon_play_*` MCP tools take `logicalKeys`, played after `keys` (#811). Raw `keys` work as before.
- A guard that the benchmark's `agon_create` tool schema uses the runtime's affinity, expression, motivation and vital vocabularies (`tests/tools/agon-tool-schema-vocabulary.test.js`, #765). The schema itself is unchanged, so benchmark results stay comparable.
- The game controller moved into runtime (#505, step 1b): `runtime/controls/game-controller.js` (`createGameController`: intents to play-session commands, the open panel, `frame()` for any client to draw). `ui-ascii`'s `createGame` wraps it and adds only the ASCII screen and panel layout; its return value and every export are unchanged. The new module is in the API surface.
- The shared controls moved into runtime (#505, step 1a): `runtime/controls/intents.js` (intents, default key bindings as data by logical key name, help text) and `runtime/controls/messages.js` (rejection wording, battle, vital and loot lines, order choices). `ui-ascii` keeps terminal key decoding and drawing and re-exports everything it exported before, so nothing changes for its callers. Both new modules are in the API surface.
- A `watcher` configuration recipe (#564): a warden or delver whose emit and pull take a kind from the affinity table's `reveals` column (`kindColumn`), the first by default, rather than a kind the data names. `kind=` accepts only kinds with that column. The catalogue is 21 recipes.
- A warden that has read a hostile's affinity ranks a pack swap to the counter kind above staying, behind the same `counterKinds` decision point (#564). Casting at the hostile still outranks an equip, so the swap happens on a turn the warden cannot usefully cast; a counter it could not aim (a restoring push) is never swapped to.
- A revealing kind's push or pull that struck an actor reveals it the next turn at the slot's intensity, less any concealing field there; `readActorRegistryRevealLevels` and `readActorRegistryReadings` take the last turn, and the player's fog view and the Actor's readings share the rule (#564). Changes what the player sees after a light push or pull.
- Actors read other actors' affinities only through revealing fields (core `readActorRegistryReadings`, capped by the reveal level as the player's view is); a read kind is remembered with its tick, and a cast prefers the opposite kind among slots that reach, through one replaceable decision point `counterKinds` (#564). No inspect, no new pricing.

### Fixed

- The adaptive-workflow sectional seam hosts the Allocator's budget fit when a `ports.solver` adapter is supplied, instead of always using the greedy fallback; an architecture guard now requires every build-capability spread to host the fit or be named (#381).
- The Actor's seeded draws (random movement, yield coins, tie-breaks) now use the level's run seed (#791). They all fell back to seed 0 before, so two levels built with different seeds drew the same coins for the same actor and tick. Levels with a seed and a random actor play differently; runs still replay exactly. The simulation sweep (62 scenarios, which carry no seed) is unchanged.

### Removed
- `render/sprite-atlas-manifest.js` and the `agon/SpriteAtlasManifest` schema (#772). The ResourceBundle, dressed by a game with a `ResourceBundleDressing`, is the one art contract. It was never on `apiSurface`; a game packaging an Aseprite atlas turns it into a dressing.

### Changed
- `--tactic auto` (#651): with a budget, the Director sizes the seeded mix to the hazard and warden pools, using the Allocator's pool split and one-unit quotes, so a level spends most of its dungeon share instead of about a fifth. The mix and the draws are the seed's; only the sizes grow, and the build's fit step still trims what the Allocator does not approve. `pickSeededTactics(seed, counts, sizing?)` takes the optional third argument. Levels built with `auto` change, and build slower.
- Pricing (#650): lasting expressions (emit, draw) cost more the more an actor holds. The k-th lasting slot, cheapest first, costs k times its price; one slot is unchanged. Actors with two or more emit or draw slots quote higher (the shadowblade delver 391 to 454, the spellward 378 to 461).

### Fixed
- `@agon-engine/engine` 0.2.0 (#796): the published bundle now includes `playtest-scenarios.json`, a working `agon` command line (`adapters-cli/cli/agon.mjs`, which `AGON_CLI` points at) and the character configuration command line (`ui-ascii/character-cli.mjs`). Both command lines are listed in the public API. `z3-solver` and `ws` are optional peers, needed only by solver and bridge commands.
### Added
- `docs/engine-api.md`: the public API list and the 0.x stability policy.

- `@agon-engine/engine`: a built (plain JS) bundle of the public API, published to npm on a `v*` tag by `.github/workflows/publish-engine.yml`. Subpaths are `./<package>/<path under src>`, for example `@agon-engine/engine/runtime/render/client-surface.js`.

### Changed (breaking)
- Renamed the `ak` command to `agon` (`agon.mjs`, `agon-impl.mjs`; bins `agon`, `agon-mcp`, `agon-persona`, `agon-maze`), every `ak_*` MCP tool to `agon_*`, every `AK_*` environment variable to `AGON_*` (including the `AK_CLI` export of `playtest-scenarios`, now `AGON_CLI`), and the `ak.uiReady.v1` message type to `agon.uiReady.v1` (#795). No aliases are kept. Update saved MCP configs, shell aliases and environment files.
- Renamed agent-kernel to **Agon**. Schema ids are now `agon/<Name>` (was `agent-kernel/<Name>`), packages are `@agon-engine/*` (was `@agent-kernel/*`), the MCP server is `agon-cli`, and the root package is `agon`. No aliases are kept. The `agon` command and `agon_*` MCP tool names are unchanged for now.
