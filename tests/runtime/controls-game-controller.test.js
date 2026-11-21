// #505 step 1b — the intent-to-command controller lives in runtime: a client that is not the terminal
// drives it with the shared intents and draws `frame()` its own way.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createGameController } from "../../packages/runtime/src/controls/game-controller.js";
import { INTENT } from "../../packages/runtime/src/controls/intents.js";
import { loadBundledLevel } from "../../packages/ui-ascii/src/levels.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures/ui-ascii/levels");
const levels = () => [loadBundledLevel("first-steps", FIXTURES)];

describe("runtime game controller", () => {
  test("a shared intent runs one command and the frame reports it", async () => {
    const game = await createGameController({ levels: levels() });
    const before = game.frame();
    expect(before.turns).toBe(0);
    expect(before.view.player).toBeTruthy();
    await game.handle({ type: INTENT.WAIT });
    const after = game.frame();
    expect(after.turns).toBe(1);
    expect(game.state().status.tick).toBeGreaterThan(0);
  });

  test("#895: frame().events is the turn events of the call, the same as state().events", async () => {
    const game = await createGameController({ levels: levels() });
    expect(game.frame().events).toEqual([]);
    for (const direction of ["east", "south", "west", "north"]) {
      await game.handle({ type: INTENT.MOVE, direction });
      expect(game.frame().events).toEqual(game.state().events);
      if (game.frame().events.length > 0) {
        expect(game.frame().events.some((event) => event.event === "move")).toBe(true);
        return;
      }
    }
    throw new Error("no move produced a turn event");
  });

  test("help is free and needs no terminal", async () => {
    const game = await createGameController({ levels: levels() });
    const shown = game.frame().showHelp;
    await game.handle({ type: INTENT.HELP });
    expect(game.frame().showHelp).toBe(!shown);
    expect(game.frame().turns).toBe(0);
    expect(game.panelChoices()).toBeNull();
  });

  test("it does not import the terminal client", () => {
    for (const name of ["game-controller.js", "intents.js", "messages.js"]) {
      const source = readFileSync(resolve(import.meta.dirname, `../../packages/runtime/src/controls/${name}`), "utf8");
      expect(source, name).not.toMatch(/from\s+"[^"]*ui-ascii/);
    }
  });
});

// ## TODO: Test Permutations
