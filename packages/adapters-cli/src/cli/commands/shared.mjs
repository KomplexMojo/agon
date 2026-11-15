/**
 * Helpers two or more command families use: paths, ids, JSON IO, environment gates, preview summaries, the command kernel instance.
 * Moved verbatim from agon-impl.mjs (#862); the COMMANDS table there routes to these.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIpfsAdapter } from "../../adapters/ipfs/index.js";
import { createBlockchainAdapter } from "../../adapters/blockchain/index.js";
import { createLlmAdapter } from "../../adapters/llm/index.js";
import { buildBuildArtifacts, createCommandKernel } from "../../../../runtime/src/commands/kernel.js";
import { orchestrateBuild } from "../../../../runtime/src/build/orchestrate-build.js";
import { attachMixedRoomAssembliesToBuildResult } from "../../../../runtime/src/build/authoring-build.js";
import { formatMixedRoomAssembliesCliLines } from "../../../../runtime/src/build/mixed-room-summary.js";
import { DEFAULT_LLM_MODEL } from "../../../../runtime/src/contracts/domain-constants.js";
// M9: this file's whole schema vocabulary — the SCHEMAS alias table below, the four
// schema constants it already imported, and the scattered literals in between —
// now has one origin.
import { ACTOR_LOADOUT_SCHEMA, AFFINITY_PRESET_SCHEMA, AFFINITY_SUMMARY_SCHEMA, AGENT_COMMAND_REQUEST_SCHEMA, BUDGET_ARTIFACT_SCHEMA, BUDGET_RECEIPT_ARTIFACT_SCHEMA, CAPTURED_INPUT_SCHEMA, EFFECT_SCHEMA, EXECUTION_POLICY_SCHEMA, INITIAL_STATE_SCHEMA, INTENT_ENVELOPE_SCHEMA, NARRATIVE_ARTIFACT_SCHEMA, PLAN_ARTIFACT_SCHEMA, PRICE_LIST_SCHEMA, RUN_SUMMARY_SCHEMA, SIM_CONFIG_SCHEMA, SOLVER_REQUEST_SCHEMA, SOLVER_RESULT_SCHEMA, TELEMETRY_RECORD_SCHEMA, TICK_FRAME_SCHEMA } from "../../../../runtime/src/contracts/artifacts.ts";
import { createAuthoringSpecs } from "../../../../runtime/src/commands/authoring-specs.js";

// The authoring grammar and request assembly are runtime's (#557), shared with the browser.
export const {
  applyBudgetCappedFulfillment,
  assertSchema,
  buildAuthoringSection,
  buildPoolWeightsForAuthoredKinds,
  buildSharedOptimizationGoals,
  configurator,
  dedupeOptimizationGoals,
  ensureBudgetedFulfillmentFeasible,
  extractBudgetTokensFromText,
  gradeAllocator,
  isNonEmptyString,
  parseActorStrategy,
  parseDelverSpecs,
  parseHazardSpecs,
  parsePositiveIntStrict,
  parseResourceSpecs,
  parseRoomSpecs,
  parseWardenSpecs,
  prepareAuthoringBuild,
  resolveAuthoringBudget,
  resolveTextVitalOptimizationGoals,
  tacticDirector,
} = createAuthoringSpecs({ makeId, readStrategyFile: (path) => readFileSync(resolvePath(path), "utf8") });

export const SCHEMAS = Object.freeze({
  intent: INTENT_ENVELOPE_SCHEMA,
  plan: PLAN_ARTIFACT_SCHEMA,
  budgetReceipt: BUDGET_RECEIPT_ARTIFACT_SCHEMA,
  budgetArtifact: BUDGET_ARTIFACT_SCHEMA,
  budgetReceiptArtifact: BUDGET_RECEIPT_ARTIFACT_SCHEMA,
  priceList: PRICE_LIST_SCHEMA,
  simConfig: SIM_CONFIG_SCHEMA,
  initialState: INITIAL_STATE_SCHEMA,
  executionPolicy: EXECUTION_POLICY_SCHEMA,
  solverRequest: SOLVER_REQUEST_SCHEMA,
  solverResult: SOLVER_RESULT_SCHEMA,
  tickFrame: TICK_FRAME_SCHEMA,
  effect: EFFECT_SCHEMA,
  telemetry: TELEMETRY_RECORD_SCHEMA,
  runSummary: RUN_SUMMARY_SCHEMA,
  narrative: NARRATIVE_ARTIFACT_SCHEMA,
  agentCommandRequest: AGENT_COMMAND_REQUEST_SCHEMA,
  affinityPreset: AFFINITY_PRESET_SCHEMA,
  actorLoadout: ACTOR_LOADOUT_SCHEMA,
  affinitySummary: AFFINITY_SUMMARY_SCHEMA,
  capturedInput: CAPTURED_INPUT_SCHEMA,
});

export const DEFAULT_ARTIFACTS_DIR = "artifacts";
export const DEFAULT_RUNS_DIR = "runs";
export const DEFAULT_TICKS = 1;
export function usage() {
  // #862: agon.mjs sits one directory up from this file in source, and beside it once bundled into agon.mjs.
  const filename = fileURLToPath(new URL(import.meta.url.includes("/cli/commands/") ? "../agon.mjs" : "./agon.mjs", import.meta.url));
  const base = resolve(dirname(filename), "../../../..");
  const rel = base && filename.startsWith(base)
    ? filename.slice(base.length + 1)
    : filename;
  return `Usage:
  node ${rel} build --spec path [--out-dir dir] [--emit-intermediates]
  node ${rel} schemas [--out-dir dir]
  node ${rel} solve --scenario "..." [--out-dir dir] [--run-id id] [--plan path] [--intent path] [--options path]
  node ${rel} solve --dir dir --question <place-objects|budget-fit> [--budget-tokens N] [--out-dir dir] [--run-id id]
  node ${rel} run (--sim-config path --initial-state path | --from-run runId) [--execution-policy path] [--ticks N] [--world-state-checkpoints ticks] [--seed N] [--out-dir dir] [--run-id id] [--actor spec] [--vital spec] [--vital-default spec] [--tile-wall xy] [--tile-barrier xy] [--tile-floor xy] [--actions path] [--affinity-presets path] [--affinity-loadouts path] [--affinity-summary path] [--progress] [--dry-run]
  node ${rel} configurator --level-gen path --actors path [--plan path] [--budget-receipt path] [--budget path --price-list path --receipt-out path] [--affinity-presets path] [--affinity-loadouts path] [--out-dir dir] [--run-id id]
  node ${rel} budget --budget path [--price-list path] [--receipt path] [--out-dir dir] [--out path] [--receipt-out path]
  node ${rel} replay --sim-config path --initial-state path --tick-frames path [--execution-policy path] [--ticks N] [--seed N] [--out-dir dir]
  node ${rel} inspect --tick-frames path [--effects-log path] [--build-dir dir] [--out-dir dir]
  node ${rel} narrate --tick-frames path --initial-state path [--out-dir dir]
  node ${rel} ipfs --cid cid [--path path] [--gateway url] [--json] [--fixture path] [--out path] [--out-dir dir]
  node ${rel} ipfs-publish --artifact-map path [--path root] [--gateway url] [--fixture-cid cid] [--out path] [--out-dir dir]
  node ${rel} ipfs-load --cid cid [--path root] [--file name --file name] [--gateway url] [--fixture-map path] [--out path] [--out-dir dir]
  node ${rel} blockchain --rpc-url url [--address addr] [--fixture-chain-id path] [--fixture-balance path] [--out path] [--out-dir dir]
  node ${rel} blockchain-mint --rpc-url url --card path [--owner addr] [--contract addr] [--token-id id] [--fixture-chain-id path] [--fixture-mint path] [--out path] [--out-dir dir]
  node ${rel} blockchain-load --rpc-url url --token-id id [--owner addr] [--contract addr] [--fixture-chain-id path] [--fixture-load path] [--out path] [--out-dir dir]
  node ${rel} llm [--model model] --prompt text [--base-url url] [--fixture path] [--out path] [--out-dir dir]
  node ${rel} llm-plan [--scenario path | (--text text | --prompt text) --catalog path] [--model model] [--goal text] [--budget-tokens N] [--base-url url] [--fixture path] [--budget-loop] [--budget-pool id=weight --budget-reserve N] [--out-dir dir] [--run-id id] [--created-at iso] [--emit-intermediates]
  node ${rel} scenario (--text text --catalog path [--model model] [--goal text] [--budget-tokens N] [--base-url url] [--fixture path] [--budget-loop] [--budget-pool id=weight --budget-reserve N] [--created-at iso] [--emit-intermediates] | --from-run runId | --sim-config path --initial-state path) [--ticks N] [--seed N] [--out-dir dir] [--run-id id] [--dry-run]
  node ${rel} recipes [--kind config|strategy] [--role attack|defence|support] [--json]
  node ${rel} recipe <name> [--role delver|warden] [--kind <kind>] [--json]
  node ${rel} show --run-id id
  node ${rel} diff --run-a id --run-b id
  node ${rel} create [--text text] [--room "..."] [--floor-tile "..."] [--hazard "..."] [--resource "..."] [--delver "..."] [--warden "..."] [--place "..."] [--tactic "..."] [--fixture path] [--model model] [--base-url url] [--seed N] [--goal text] [--dungeon-affinity affinity] [--budget-tokens N] [--dungeon-budget-tokens N] [--delver-budget-tokens N] [--grade H..S] [--budget path --price-list path] [--out-dir dir] [--run-id id] [--created-at iso] [--emit-intermediates] [--dry-run]
  node ${rel} configure [--text text] [--room "..."] [--floor-tile "..."] [--hazard "..."] [--resource "..."] [--delver "..."] [--warden "..."] [--place "..."] [--tactic "..."] [--seed N] [--goal text] [--dungeon-affinity affinity] [--budget-tokens N] [--dungeon-budget-tokens N] [--delver-budget-tokens N] [--grade H..S] [--budget path --price-list path] [--out-dir dir] [--run-id id] [--created-at iso] [--emit-intermediates]
  node ${rel} room-plan --room "size=small;count=2" [--room "..."] [--goal text] [--dungeon-affinity affinity] [--budget-tokens N] [--budget path --price-list path] [--out-dir dir] [--run-id id] [--created-at iso] [--emit-intermediates]
  node ${rel} hazard-plan --hazard "affinity=fire;expression=emit;proximityRadius=2[;mana=one-time:<amount>|regen:<current>:<max>:<regen>]" [--hazard "..."] [--goal text] [--dungeon-affinity affinity] [--budget-tokens N] [--budget path --price-list path] [--out-dir dir] [--run-id id] [--created-at iso] [--emit-intermediates]
  node ${rel} resource-plan --resource "permanenceMode=<consumable|level|permanent>;vital=<health|mana|stamina>;delta=<n>" [--resource "..."] [--goal text] [--dungeon-affinity affinity] [--budget-tokens N] [--budget path --price-list path] [--out-dir dir] [--run-id id] [--created-at iso] [--emit-intermediates]
  node ${rel} delver-plan --delver "count=2;affinity=fire;motivation=attacking[;goals=max_mana:high,mana_regen:high]" [--delver "..."] [--goal text] [--dungeon-affinity affinity] [--budget-tokens N] [--budget path --price-list path] [--out-dir dir] [--run-id id] [--created-at iso] [--emit-intermediates]
  node ${rel} warden-plan --warden "count=2;affinity=dark;motivation=defending" [--warden "..."] [--goal text] [--dungeon-affinity affinity] [--budget-tokens N] [--budget path --price-list path] [--out-dir dir] [--run-id id] [--created-at iso] [--emit-intermediates]
  node ${rel} runs list
  node ${rel} play [--dir dir | --from-run id | --sim-config path --initial-state path | --level name] [--keys keys] [--json] [--color | --no-color] [--no-fog] [--realtime ms] [--web [--port n] [--lan] [--debug]] [--record path] [--replay path]
  node ${rel} play --watch (--dir dir | --from-run id) [--tick N] [--keys keys] [--json] [--color | --no-color]
  node ${rel} play-session start [--session id] (--dir dir | --from-run id | --sim-config path --initial-state path | --level name) [--actor id|label] [--commands json] [--keys keys] [--logical-keys json]
  node ${rel} play-session start [--session id] --load path
  node ${rel} play-session act|view|legal|switch|end [--session id] [--actor id|label] [--commands json] [--keys keys] [--save path]
  node ${rel} play-session order [--session id] --actor id|label --strategy goals|json|file.json
  node ${rel} play-session advance [--session id] [--ticks n] [--until orders_done|contact]
  node ${rel} play-session tick [--session id] --actor-commands json

Options:
  --out-dir       Output directory (default: ./artifacts/runs/<runId>/<command>)
  --out           Output file path (command-specific default when omitted)
  --ticks         Number of ticks for run/replay (default: ${DEFAULT_TICKS})
  --world-state-checkpoints  Comma-separated ticks to persist as WorldStateArtifact v2 files (run only)
  --seed          Seed for init (default: 0)
  --solver-fixture Fixture path for solve command (no network)
  --question      solve: ask about the built level in --dir (place-objects | budget-fit; budget-fit needs --budget-tokens)
  --actor         Actor spec: id,x,y,category (delver/warden/hazard/resource/barrier)
  --vital         Vital spec: actorId,vital,current,max,regen
  --vital-default Vital default: vital,current,max,regen
  --tile-wall     Terrain wall coordinate: x,y (repeatable)
  --tile-barrier  Barrier actor coordinate: x,y (repeatable)
  --tile-floor    Terrain floor coordinate: x,y (repeatable)
  --actions       Action log (ActionSequence) path for deterministic replay
  --from-run      Resolve sim-config.json and initial-state.json from artifacts/runs/<runId>/*
  --affinity-presets  Affinity preset artifact path (AffinityPresetArtifact)
  --affinity-loadouts Actor loadout artifact path (ActorLoadoutArtifact)
  --affinity-summary  Write affinity summary JSON (default: <out-dir>/affinity-summary.json)
  --level-gen     Level generation input path (Configurator levelGen input)
  --actors        Actors input path (object with actors array)
  --budget-receipt Budget receipt artifact path (BudgetReceiptArtifact)
  --budget        Budget artifact path (BudgetArtifact)
  --price-list    Price list artifact path (PriceList)
  --receipt       Budget receipt artifact path (BudgetReceiptArtifact)
  --receipt-out   Output path for budget receipt JSON
  --spec          Build spec JSON path (build command only)
  --text          Freeform agent authoring text captured in AgentCommandRequestArtifact
  --scenario      Scenario fixture path for llm-plan
  --catalog       Catalog path for text/prompt-only llm-plan runs
  --goal          Goal text override (llm-plan prompt-only)
  --text          Freeform text for llm-plan; when no fixture is provided, CLI falls back to the default stub summary fixture
  --dungeon-affinity Dungeon affinity for plan summary defaults
  --budget-tokens Hard budget cap in tokens. If freeform text also states a budget, they must match.
  --dungeon-budget-tokens Separate hard budget cap for dungeon-side objects (rooms, tiles, placedHazards, hazards).
  --delver-budget-tokens  Separate hard budget cap for delver-side objects (delvers, wardens).
  --grade             Level difficulty grade H (easiest) to S (ultra hard): the Allocator's budget and
                      dungeon/delver split for that grade (#422). --budget-tokens still wins (an override).
  --emit-intermediates Persist non-canonical sidecar artifacts such as request/intent/plan/solver/captured-input files
  --floor-tile    Floor tile spec for create/configure (repeatable): count=<n>[;id=<id>]
  --hazard        Hazard spec for create/configure/hazard-plan (repeatable): affinity=<kind>;expression=<push|pull|emit|draw>;proximityRadius=<n>[;stacks=<range>][;intensity=<n>][;mana=one-time:<amount>|regen:<current>:<max>:<regen>]
  --resource      Resource artifact spec for create/configure/resource-plan (repeatable).
  --tactic        Placement tactic for create/configure (repeatable): <ambush|retinue|minefield|shrine>[;key=value...]. The Director refuses an
                  unknown tactic, naming the known ones. The plan records each tactic and the placementReport says how it was
                  handled. ambush[;guards=<n>][;resources=<n>][;room=<id>][;visible=true] puts that many of the level's resources in
                  a room (room=, else picked from the seed) and seats that many of its wardens there out of sight of the room's
                  doorways (visible=true: in the open, within 2 of the loot); a room that can't hide them all hides what fits and
                  says so. retinue[;leader=<warden id>][;size=<n>] gives the leader (default: the first free warden) that many
                  minions (default 3) within 2 of it, by role from the affinity table: shield (emits the leader's kind),
                  support (the restoring kind for its defeat vital, push), striker (the leader's kind in a harmful expression
                  it lacks); the Allocator prices them as wardens, and a retinue the warden share can't afford shrinks.
                  minefield[;room=<id>][;hazards=<n>][;range=<n>][;kinds=<kind>+<kind>...] fills a room on the spawn-to-exit
                  route (room=, else picked from the seed) with that many emit hazards (default 4, range default 1) seated
                  clear of a safe line from doorway to doorway along the room's edge, plus one free resource as the reward;
                  kinds are drawn from the table's damaging kinds, no two opposite, unless kinds= names them. The Allocator
                  prices them from the hazard share, which shrinks a minefield it can't afford; the row names the room and
                  the safe line (safeLine: length, cells) and the short route's length.
                  shrine[;room=<id>][;count=<n>][;range=<n>][;kinds=<kind>+<kind>...] seats that many emit hazards (default 1,
                  range default 1) whose field restores a vital in a room off the spawn-to-exit route (room=, else picked from
                  the seed; a route room when there is no other), none touching another hazard; kinds are drawn from the
                  table's restoring kinds by the seed unless kinds= names them (restoring kinds only). A health shrine is
                  reported as a healing well. Priced from the hazard share like a minefield's hazards; the row lists shrines
                  (id, kind, restores, name).
                  llm (alone) asks the model (--fixture, or AGON_LLM_LIVE=1; --model, --base-url) for the mix; an invalid reply
                  or no model falls back to auto's seeded pick, and the result's tacticPlan says which decided.
  --actors llm      #721: the model (--fixture, or AGON_LLM_LIVE=1) picks the delvers and wardens from --text and the recipe
                  catalogue, replying with specs (recipe=shadowblade;motivation=user_controlled). They join any typed
                  --delver/--warden and are parsed like them, so an unknown recipe is refused; actorPlan records the reply.
                  No model or an unreadable reply is an error. Not with --tactic llm (one --fixture).
                  auto (alone) lets the Director pick a mix of these, with their sizes, from the seed; the result lists the picks.
                  With a tactic and no --seed, a seed is drawn; the result reports it (seed) so --seed rebuilds the level exactly.
  --place         Placement constraint for create/configure (repeatable): <subject>[;near=<target>:<d>][;far=<target>:<d>][;count=<n>][;onRoute|offRoute][;spread|clump][;outOfSight=room:<id>]
                  subject: hazard|resource|delver|warden:<id|n|*>; target: spawn, exit, room:<id> or one hazard|resource|delver|warden:<id|n>.
                  Distances are king moves (a room counts from its nearest cell). count=<n> with near= means at least n of the subjects;
                  onRoute is a cell every spawn-to-exit route passes; outOfSight=room:<id> is a cell no doorway of that room can see. A delver or warden named here is placed by this search, not seated
                  by the usual rules. A constraint that cannot hold refuses the level, naming it; the result's placementReport says how each held.
                  Vital payload:   permanenceMode=<consumable|level|permanent>;vital=<health|mana|stamina>;delta=<n>[;regen=<n>][;id=<id>]
                  permanenceMode governs delta only (consumable raises current, level/permanent raise max).
                  regen is a third, independent grant: the actor permanently gains that regen rate on top
                  of the delta. delta may be omitted when regen is given (a regen-only resource).
                  Affinity payload: affinity=<fire|water|earth|wind|growth|decay|corrode|fortify|light|dark>;expression=<push|pull|emit|draw>;stacks=<n>;mana=<n>[;manaRegen=<n>][;id=<id>]
                  Both payloads may be combined in one spec. manaRegen defaults to 0, which grants the
                  affinity temporarily until its mana is spent; manaRegen>0 refills the pool, making the
                  granted affinity permanent (and costing 3 tokens per point of manaRegen to author).
                  slots=<n> (slot-unlock loot) is retired: an actor equips at most 3 and carries the rest.
                  Legacy: tier=<level|permanent>;stat=<vitalMax|vitalRegen|affinity|affinityStack|pushExpression>;delta=<n>;dropRate=<n>[;id=<id>]
  --hazard          Hazard spec for create/configure (repeatable): x=<n>;y=<n>;affinity=<kind>[;expression=<push|pull|emit|draw>][;stacks=<range>][;intensity=<n>][;blocking=<true|false>][;id=<id>][;vitals=<vital>:<max>:<regen>|<vital>:<current>:<max>:<regen>,...]
  --room          Room spec for room-plan (repeatable): size=<small|medium|large>;count=<n>  (rooms are generic containers; affinity comes from --hazard placement)
                    where <expression> is push|pull (spatial) or emit|draw (field)
  --delver      Delver spec for delver-plan (repeatable): count=<n>;affinity=<kind>;motivation=<kind>[+<kind>...][;id=<id>][;affinities=<kind>[:<expression>[:<range>[:<intensity>]]],...][;vitals=<vital>:<max>:<regen>,...|<vital>:<current>:<max>:<regen>,...][;setup-mode=<auto|user|hybrid>][;goals=max_mana[:<priority>],mana_regen[:<priority>]][;slots=<n>][;equip=<kind>:<expression>[:<stacks>],...][;strategy=<goals>|<json>|<file.json>][;escort=<id>[:<distance>]][;leader=<id>][;temperament=<n>]
                    where <expression> is push|pull (spatial) or emit|draw (field)
  --warden      Warden spec for warden-plan (repeatable): count=<n>;affinity=<kind>;motivation=<kind>[+<kind>...][;id=<id>][;affinities=<kind>[:<expression>[:<range>[:<intensity>]]],...][;vitals=<vital>:<max>:<regen>,...|<vital>:<current>:<max>:<regen>,...][;slots=<n>][;equip=<kind>:<expression>[:<stacks>],...][;strategy=<goals>|<json>|<file.json>][;escort=<id>[:<distance>]][;leader=<id>][;temperament=<n>]
                    where <expression> is push|pull (spatial) or emit|draw (field)
                Delver and warden slots/equip (create too): slots=<n> sets affinity slots, 1 to the preset (delver 3,
                warden 2); extra slots are retired and further affinities are a pack. equip= lists starting equips in order,
                each held by the actor; :<stacks> runs it at fewer stacks than it holds. Any mix may be equipped.
                Delver and warden strategy (create too): standing orders the actor follows on its own turns, as compact
                goals in order (reach:exit|reach:<x>/<y>, defeat:<id>, take:<id>, guard:<id>[:radius], follow:<id>[:distance],
                lead:<id>[:distance], hold:<x>/<y>:<ticks>, survive[:distance]), JSON { goals, tactics? } or a .json file.
                goal_oriented follows the goals, strategy_focused and user_controlled the tactics too; any other actor
                ignores it. The create result lists ignored parts and unknown targets under strategyReport.
  --prompt        Prompt override (llm-plan)
  --budget-loop   Enable budget loop (layout then actors)
  --budget-pool   Budget pool weight entry (repeatable): id=weight (e.g., player=0.2)
  --budget-reserve Reserve tokens before pooling (llm-plan budget loop)
  --model         LLM model name (default: ${DEFAULT_LLM_MODEL})
  --fixture       Fixture response for adapter commands (no network)
  --artifact-map  Canonical artifact JSON map path for ipfs-publish
  --fixture-cid   Deterministic CID for ipfs-publish fixture mode
  --fixture-map   Fixture JSON map for ipfs-load (keys are artifact paths under CID)
  --card          Card configuration JSON path for blockchain-mint
  --contract      Contract address or alias for blockchain-mint/load
  --token-id      Token identifier for blockchain-mint/load
  --fixture-mint  Fixture JSON-RPC response for blockchain-mint
  --fixture-load  Fixture JSON-RPC response for blockchain-load
  --run-id        Override run id for output artifacts
  --created-at    Override createdAt timestamp (ISO-8601) for llm-plan/room-plan/hazard-plan/resource-plan/delver-plan/warden-plan
  --dry-run       Validate schema/budget inputs without executing run or writing artifacts
  --dir           play: an \`agon create --out-dir\` or run directory holding sim-config.json + initial-state.json
                  solve --question: the same kind of built level directory
  --level         play: a bundled ui-ascii level (default: all bundled levels, in order)
  --logical-keys  play, play-session: key names as a JSON array (e.g. ["ArrowUp","Enter","d"]), played after --keys
  --keys          play: apply these keys without a terminal and print the final screen (e.g. "ddss.")
  --json          play: print { ok, level, turns, status, screen, launch, warnings? } instead of the screen
  --no-fog        play: debug view of the whole map (play is always under fog of war)
  --realtime      play: a turn passes every <ms> while you wait (interactive only; t toggles)
  --web           play: play in a browser tab on http://localhost:<port> (--port, default 8765; --lan for a phone on the same network; --debug adds the analysis console, evaluation only)
  --record        play: save the played commands to this path (CapturedInputArtifact)
  --replay        play: re-run a saved game on its level, then continue
  --watch         play: watch the run \`agon run\` recorded in --dir (or under artifacts/runs/<--from-run>), tick by tick
  --tick          play --watch: open at this tick (default 0)
  --session       play-session: the game's name (default "game"), kept in artifacts/play-sessions/<name>.json
  --actor         play-session: play this party member (a user_controlled actor, by id or label such as D2); free
  --commands      play-session: a JSON array of commands, each { kind, params?, actorId? } or { kind: "switch", actorId }
  --save          play-session: also copy the game to this path after the call (reopen it with start --load)
  --load          play-session start: begin from a game saved with --save, in place of a level
  --strategy      play-session order: the new strategy for --actor, as compact goals (follow:D1:2,reach:exit),
                  JSON { goals, tactics? } or a .json file. Taking it is that actor's turn and giving it yours.
  --ticks         play-session advance: how many ticks to let run (default 1, or 50 with --until)
  --until         play-session advance: stop early at orders_done (every order done or stalled) or contact
  --actor-commands  play-session tick: a JSON object { actorId|label: command } for ai_controlled actors; one tick for all of them
                  (a hostile in a party member's sight). The seated actor follows its own strategy, else waits.
  --help          Show this help

Schema discovery:
  schemas output includes ${SCHEMAS.agentCommandRequest} for the canonical
  agent-friendly authoring taxonomy and compilation contract.
`;
}

export function resolvePath(input, cwd = process.cwd()) {
  if (!input) {
    return null;
  }
  return isAbsolute(input) ? input : resolve(cwd, input);
}

export function makeId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function createMeta({ producedBy, runId, correlationId, note } = {}) {
  return {
    id: makeId("artifact"),
    runId: runId || makeId("run"),
    createdAt: new Date().toISOString(),
    producedBy: producedBy || "cli",
    correlationId,
    note,
  };
}

export function toRef(artifact) {
  if (!artifact || typeof artifact !== "object") {
    return null;
  }
  if (!artifact.schema || !artifact.schemaVersion) {
    return null;
  }
  const id = artifact.meta?.id || makeId("artifact");
  return {
    id,
    schema: artifact.schema,
    schemaVersion: artifact.schemaVersion,
  };
}

export async function readJson(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function readText(filePath) {
  return readFile(filePath, "utf8");
}

export async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, content, "utf8");
}

export function defaultRunDir(runId) {
  return resolve(process.cwd(), DEFAULT_ARTIFACTS_DIR, DEFAULT_RUNS_DIR, runId);
}

export function defaultRunCommandOutDir(command, runId) {
  return resolve(defaultRunDir(runId), command);
}

export function defaultOutDir(command, runId) {
  const resolvedRunId = runId || makeId("run");
  return defaultRunCommandOutDir(command, resolvedRunId);
}

function defaultBuildOutDir(spec) {
  return defaultRunCommandOutDir("build", spec.meta.runId);
}

function defaultLlmPlanOutDir(runId) {
  return defaultRunCommandOutDir("llm-plan", runId);
}

export function emitJsonStdout(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function buildArtifactPathMap({ outDir, manifestEntries = [] } = {}) {
  const artifactPaths = {};
  artifactPaths.spec = join(outDir, "spec.json");
  artifactPaths.bundle = join(outDir, "bundle.json");
  artifactPaths.manifest = join(outDir, "manifest.json");
  artifactPaths.telemetry = join(outDir, "telemetry.json");
  manifestEntries.forEach((entry) => {
    if (!entry?.path) {
      return;
    }
    const key = entry.path.replace(/\.json$/i, "").replaceAll(/[^A-Za-z0-9]+/g, "_");
    artifactPaths[key] = join(outDir, entry.path);
  });
  return artifactPaths;
}

export function deriveActorIds(initialState) {
  const actors = Array.isArray(initialState?.actors) ? initialState.actors : [];
  return actors
    .map((actor) => actor?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
}

export function deriveRoomIds(simConfig) {
  const rooms = Array.isArray(simConfig?.layout?.data?.rooms) ? simConfig.layout.data.rooms : [];
  return rooms
    .map((room) => room?.id)
    .filter((id) => typeof id === "string" && id.length > 0);
}

const REQUIRED_PREVIEW_CARD_TYPES = Object.freeze(["room", "delver", "warden"]);

function stablePreviewCardKey(card, index) {
  const id = typeof card?.id === "string" ? card.id.trim() : "";
  if (id) return `id:${id}`;
  return `index:${index}:${JSON.stringify(card || {})}`;
}

function mergePreviewCardArrays(...sources) {
  const merged = new Map();
  sources.forEach((cards) => {
    if (!Array.isArray(cards)) return;
    cards.forEach((card, index) => {
      if (!card || typeof card !== "object" || Array.isArray(card)) return;
      const key = stablePreviewCardKey(card, index);
      const previous = merged.get(key);
      merged.set(key, previous ? { ...previous, ...card } : { ...card });
    });
  });
  return Array.from(merged.values());
}

export function collectPreviewCardSet(spec) {
  return mergePreviewCardArrays(
    spec?.configurator?.inputs?.cardSet,
    spec?.plan?.hints?.cardSet,
  );
}

export function normalizePreviewCardType(type) {
  const normalized = typeof type === "string" ? type.trim().toLowerCase() : "";
  if (normalized === "attacker") return "delver";
  if (normalized === "defender") return "warden";
  return normalized;
}

function readConfiguredPreviewCount(count) {
  const parsed = Number(count);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function buildPreviewSummary({
  outDir,
  manifestEntries = [],
  initialState = null,
  simConfig = null,
  spec = null,
} = {}) {
  const resourceBundleEntry = manifestEntries.find((entry) => entry?.path === "resource-bundle.json");
  const cardSet = collectPreviewCardSet(spec);
  const counts = REQUIRED_PREVIEW_CARD_TYPES.reduce((acc, type) => ({ ...acc, [type]: 0 }), {});
  cardSet.forEach((entry) => {
    const type = normalizePreviewCardType(entry?.type);
    if (!REQUIRED_PREVIEW_CARD_TYPES.includes(type)) return;
    counts[type] += readConfiguredPreviewCount(entry?.count ?? 1);
  });
  return {
    ready: Boolean(simConfig && resourceBundleEntry),
    bundlePath: join(outDir, "bundle.json"),
    manifestPath: join(outDir, "manifest.json"),
    resourceBundlePath: join(outDir, "resource-bundle.json"),
    hasActors: deriveActorIds(initialState).length > 0,
    runReady: REQUIRED_PREVIEW_CARD_TYPES.every((type) => counts[type] > 0),
  };
}

export function buildStructuredSuccessSummary({
  command,
  outDir,
  runId,
  manifestEntries = [],
  initialState = null,
  simConfig = null,
  spec = null,
  extra = {},
} = {}) {
  const summary = {
    ok: true,
    command,
    runId,
    outDir,
    actorIds: deriveActorIds(initialState),
    roomIds: deriveRoomIds(simConfig),
    artifactPaths: buildArtifactPathMap({ outDir, manifestEntries }),
    preview: buildPreviewSummary({
      outDir,
      manifestEntries,
      initialState,
      simConfig,
      spec,
    }),
  };
  // Strategy parts an actor will not follow, and targets not in the level: reported, never refused.
  const strategyReport = initialState?.strategies ? configurator.authorCandidates.reportActorStrategies(initialState) : [];
  if (strategyReport.length > 0) summary.strategyReport = strategyReport;
  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined) {
      summary[key] = value;
    }
  });
  return summary;
}

export async function readJsonIfExists(path) {
  if (!path || !existsSync(path)) {
    return null;
  }
  return readJson(path);
}

export async function summarizeBuildLikeOutput({
  command,
  outDir,
  extra = {},
} = {}) {
  const manifest = await readJsonIfExists(join(outDir, "manifest.json"));
  const spec = await readJsonIfExists(join(outDir, "spec.json"));
  const simConfig = await readJsonIfExists(join(outDir, "sim-config.json"));
  const initialState = await readJsonIfExists(join(outDir, "initial-state.json"));
  return buildStructuredSuccessSummary({
    command,
    outDir,
    runId: spec?.meta?.runId || manifest?.correlation?.runId || "",
    manifestEntries: Array.isArray(manifest?.artifacts) ? manifest.artifacts : [],
    initialState,
    simConfig,
    spec,
    extra,
  });
}

export function allowNetworkRequests() {
  const value = process.env.AGON_ALLOW_NETWORK;
  return value === "1" || value === "true";
}

export function isLlmLiveEnabled() {
  const value = process.env.AGON_LLM_LIVE;
  return value === "1" || value === "true";
}

export function isLlmStrictEnabled() {
  const value = process.env.AGON_LLM_STRICT;
  return value === "1" || value === "true";
}

export function isLlmBudgetLoopEnabled() {
  const value = process.env.AGON_LLM_BUDGET_LOOP;
  return value === "1" || value === "true";
}

/**
 * Z10: REAL Z3 IS THE DEFAULT, and the fixture stub is now the opt-out.
 *
 * It used to be the other way round, and the cost of that was measured rather than
 * argued. Without AGON_SOLVER_ENGINE=z3-real every hosted solver call got a stub
 * declaring `domains: []`, so the host deferred and each persona took its greedy
 * fallback. Across 2800 Allocator budget-fit decision points that fallback was
 * optimal 40.8% of the time against an exhaustive oracle, while real Z3 was optimal
 * 100% of the time and never worse at any point. It also refused 250 layouts that
 * were affordable and buildable. Shipping the stub by default meant shipping a
 * wrong answer to roughly three of every five real decisions.
 *
 * See ~/vault/decisions/2026-09-04-does-the-solver-actually-win.md. The flip was
 * deliberately NOT made before the context-lifecycle leak was fixed: turning Z3 on
 * by default while every solve leaked ~10MB would have made a correctness win into
 * an availability problem.
 *
 * AN EXPLICIT FIXTURE STILL WINS. `agon solve --solver-fixture` and a build spec's
 * `solver.fixture` hint are requests to REPLAY a recorded answer, not to search for
 * one; honouring the engine default over them would silently ignore the file the
 * caller named. So a supplied fixturePath selects the fixture adapter regardless of
 * engine, which is also what keeps every fixture-driven test meaningful.
 */
function resolveSolverEngine() {
  const value = process.env.AGON_SOLVER_ENGINE;
  // "z3-real" stays accepted so existing call sites that set it keep working; it is
  // now a no-op that names the default rather than a switch that enables it.
  if (value === "fixture" || value === "stub") return "fixture";
  return "z3-real";
}

export function isLocalBaseUrl(raw) {
  if (!isNonEmptyString(raw)) {
    return false;
  }
  try {
    const url = new URL(raw);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch (error) {
    const lowered = raw.toLowerCase();
    return lowered.startsWith("localhost")
      || lowered.startsWith("127.0.0.1")
      || lowered.startsWith("[::1]")
      || lowered.startsWith("http://localhost")
      || lowered.startsWith("http://127.0.0.1")
      || lowered.startsWith("http://[::1]");
  }
}

export function buildDryRunBudgetEstimate({ budgetReceipt, spendProposal, budgetTokens } = {}) {
  const total = Number.isInteger(budgetReceipt?.budget?.tokens)
    ? budgetReceipt.budget.tokens
    : Number.isInteger(budgetReceipt?.totalBudget)
      ? budgetReceipt.totalBudget
      : Number.isInteger(budgetTokens)
        ? budgetTokens
        : Number.isInteger(spendProposal?.summary?.budgetTokens)
          ? spendProposal.summary.budgetTokens
          : undefined;
  const used = Number.isFinite(budgetReceipt?.totalCost)
    ? budgetReceipt.totalCost
    : Number.isFinite(spendProposal?.summary?.totalSpentTokens)
      ? spendProposal.summary.totalSpentTokens
      : undefined;
  const remaining = Number.isFinite(budgetReceipt?.remaining)
    ? budgetReceipt.remaining
    : Number.isFinite(spendProposal?.summary?.remainingTokens)
      ? spendProposal.summary.remainingTokens
      : Number.isFinite(total) && Number.isFinite(used)
        ? Math.max(0, total - used)
        : undefined;
  if (total === undefined && used === undefined && remaining === undefined) {
    return undefined;
  }
  return { total, used, remaining };
}

export function buildDryRunSuccess({
  command,
  runId,
  outDir,
  actorIds = [],
  roomIds = [],
  budgetEstimate,
  warnings = [],
  extra = {},
} = {}) {
  const summary = {
    ok: true,
    command,
    runId,
    valid: true,
    dryRun: true,
    actorIds,
    roomIds,
    warnings,
  };
  if (outDir) {
    summary.outDir = outDir;
  }
  if (budgetEstimate) {
    summary.budgetEstimate = budgetEstimate;
  }
  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined) {
      summary[key] = value;
    }
  });
  return summary;
}

export function buildDryRunFailure({ command, runId, outDir, error } = {}) {
  const summary = {
    ok: true,
    command,
    runId,
    valid: false,
    dryRun: true,
    errors: [error?.message || String(error)],
    warnings: [],
  };
  if (outDir) {
    summary.outDir = outDir;
  }
  return summary;
}

function addManifestEntry(entries, artifact, path) {
  if (!artifact || typeof artifact !== "object") {
    return;
  }
  const id = artifact.meta?.id;
  if (!id) {
    return;
  }
  entries.push({
    id,
    schema: artifact.schema,
    schemaVersion: artifact.schemaVersion,
    path,
  });
}

function logMixedRoomAssembliesFromBuildResult(buildResult) {
  const assemblies = attachMixedRoomAssembliesToBuildResult(buildResult);
  formatMixedRoomAssembliesCliLines(assemblies).forEach((line) => {
    console.error(line);
  });
}

// #862: the default llm-plan fixture is a repository path, so the host names it; runtime holds no tests/ path.
export function resolveDefaultLlmFixturePath({ resolvePath: resolveCliPath, exists, cwd }) {
  const candidates = [
    resolveCliPath("tests/fixtures/adapters/llm-generate-summary.json"),
    resolveCliPath("tests/fixtures/adapters/llm-generate-summary.json", cwd()),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export const commandKernel = createCommandKernel({
  readJson,
  readText,
  writeJson,
  resolvePath,
  join,
  dirname,
  exists: existsSync,
  makeId,
  createMeta,
  toRef,
  defaultBuildOutDir,
  defaultRunCommandOutDir,
  defaultLlmPlanOutDir,
  allowNetworkRequests,
  isLlmLiveEnabled,
  isLlmStrictEnabled,
  isLlmBudgetLoopEnabled,
  isLocalBaseUrl,
  createIpfsAdapter,
  createBlockchainAdapter,
  createLlmAdapter,
  createSolverAdapter: async (options) => {
    let adapter;
    if (!options?.fixturePath && resolveSolverEngine() === "z3-real") {
      const { createHybridConstraintSolverAdapter } = await import("../../adapters/z3/index.js");
      adapter = createHybridConstraintSolverAdapter(options);
    } else {
      const { createSolverAdapter } = await import("../../adapters/solver-z3/index.js");
      adapter = createSolverAdapter(options);
    }
    // #557: AGON_SOLVER_RECORD=<file> appends each answer, for a host with no solver to replay.
    if (!process.env.AGON_SOLVER_RECORD) return adapter;
    const { withSolverRecording } = await import("../../adapters/solver-recording/index.js");
    return withSolverRecording(adapter, process.env.AGON_SOLVER_RECORD);
  },
  nowIso: () => new Date().toISOString(),
  env: process.env,
  cwd: () => process.cwd(),
  defaultLlmFixturePath: () => resolveDefaultLlmFixturePath({ resolvePath, exists: existsSync, cwd: () => process.cwd() }),
  log: (...parts) => console.error(...parts),
  warn: (...parts) => console.error(...parts),
});

/**
 * Compile a BuildSpec into a gameplay bundle suitable for the browser UI.
 *
 * Returns { spec, artifacts } where artifacts is the canonical artifact array
 * produced by buildBuildArtifacts (SimConfigArtifact, InitialStateArtifact,
 * ResourceBundleArtifact, AffinitySummary, etc.).
 *
 * @param {object} buildSpec  BuildSpec object (agon/BuildSpec)
 * @returns {Promise<{ spec: object, artifacts: object[] }>}
 */
export async function compileBuildSpecToGameplayBundle(buildSpec) {
  if (!buildSpec || typeof buildSpec !== "object") {
    throw new Error("compileBuildSpecToGameplayBundle requires a BuildSpec object.");
  }
  const buildResult = await orchestrateBuild({
    spec: buildSpec,
    producedBy: "sandbox-bridge",
    placeObjects: await commandKernel.hostObjectPlacement(buildSpec.meta?.createdAt),
  });
  const artifacts = buildBuildArtifacts(buildResult, { includeAffinitySummary: true });
  return { spec: buildSpec, artifacts };
}
