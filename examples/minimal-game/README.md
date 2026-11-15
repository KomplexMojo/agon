# Minimal game

The smallest complete game on Agon, in one file under 120 lines. It does what the
[building a game](../../docs/building-a-game.md) guide describes, end to end:

| Part of `play.mjs` | Guide section |
|---|---|
| `authorLevel` with the same arguments as `agon create` (one small room, a fire delver you play, a dark warden that defends) | 2. Get a level |
| `createPlaySession`, then one `session.act(...)` per key | 3. Play a level |
| printing `view().rows` and the player's vitals | 4. Draw it |

It imports only the published entries (`@agon-engine/engine/authoring` and `/client`), exactly as a game
outside this repository would. The test suite runs it, so the guide's path cannot go stale silently.

## Run it

From the repository root, after `pnpm install` and `pnpm run build:engine` (the package entries point at the built
bundle):

```bash
node examples/minimal-game/play.mjs                      # w a s d move, . waits, q quits
node examples/minimal-game/play.mjs --script "d,d,s,."   # the same keys without a terminal
```

It stops when you leave the level, are defeated, or press `q`, and prints how it ended.

## What it leaves out

Colour, sprites, fog, the game controller and its panels. The reference terminal client
(`packages/ui-ascii`) shows those; Primordial is the full game.
