import { expect, test } from 'vitest';
import { createActorRegistry } from '../../packages/core-ts/src/state/actor-registry.ts';
import { createActorTurn } from '../../packages/core-ts/src/rules/actor-turn.ts';
import { readActorRegistryLightByCell } from '../../packages/core-ts/src/rules/actor-observation.ts';
import type { ActorRecord } from '../../packages/core-ts/src/state/actor-types.ts';

// #906: a dormant fixture projects no light and pays no upkeep until its trigger holds.

function actor(id: string, x: number, alignment: 'external' | 'dungeon' = 'dungeon'): ActorRecord {
  return { id, position: { x, y: 0 }, alignment, lifecycle: 'alive', defeatVital: 'health',
    vitals: { health: { current: 10, max: 10, regen: 0 }, mana: { current: 10, max: 10, regen: 0 } },
    capabilities: { canMove: true, canCast: true, canEquip: true, canTake: true, canExit: true,
      blocksMovement: false, blocksSight: false }, motivations: [], affinities: [], activeAffinityKey: null, holdings: [] };
}

function torch(dormant: ActorRecord['dormant']): ActorRecord {
  const record = actor('torch', 8);
  record.affinities = [{ kind: 'light', expression: 'emit', stacks: 1 }];
  record.activeAffinityKey = 'light:emit';
  record.dormant = dormant;
  return record;
}

const UPKEEP = Array.from({ length: 101 }, (_, stacks) => (stacks === 0 ? 0 : 2 + stacks));
const costs = { castManaBase: {}, movementStamina: {}, persistentUpkeep: UPKEEP };

function build(actors: ActorRecord[]) {
  return createActorRegistry({ dimensions: { width: 12, height: 1 }, terrain: Array(12).fill('floor'), actors });
}

function turn(registry: ReturnType<typeof build>) {
  const t = createActorTurn(registry, 1, costs);
  t.closeActions();
  t.resolveFields();
  t.regenerate();
  return registry.snapshot().actors;
}

test('a dormant torch projects no light and pays no upkeep', () => {
  const registry = build([actor('seat', 0, 'external'), torch({ mode: 'proximity', radius: 2 })]);
  expect(Object.keys(readActorRegistryLightByCell(registry.snapshot()))).toEqual([]);
  const after = turn(registry);
  expect(after.find(entry => entry.id === 'torch')!.vitals.mana!.current).toBe(10);
  expect(after.find(entry => entry.id === 'torch')!.dormant).toBeDefined();
});

test('proximity wakes it when an external actor comes within the radius, and it then lights and pays', () => {
  const registry = build([actor('seat', 6, 'external'), torch({ mode: 'proximity', radius: 2 })]);
  const after = turn(registry);
  const woken = after.find(entry => entry.id === 'torch')!;
  expect(woken.dormant).toBeUndefined();
  expect(Object.keys(readActorRegistryLightByCell(registry.snapshot())).length).toBeGreaterThan(0);
  expect(woken.vitals.mana!.current).toBeLessThan(10);
});

test('a dungeon actor nearby does not wake it', () => {
  const registry = build([actor('warden', 7), torch({ mode: 'proximity', radius: 3 })]);
  expect(turn(registry).find(entry => entry.id === 'torch')!.dormant).toBeDefined();
});

test('room_enter wakes it when an external actor is inside the room area', () => {
  const area = { x: 7, y: 0, width: 4, height: 1 };
  const outside = build([actor('seat', 2, 'external'), torch({ mode: 'room_enter', area })]);
  expect(turn(outside).find(entry => entry.id === 'torch')!.dormant).toBeDefined();
  const inside = build([actor('seat', 9, 'external'), torch({ mode: 'room_enter', area })]);
  expect(turn(inside).find(entry => entry.id === 'torch')!.dormant).toBeUndefined();
});

test('an invalid dormancy is refused', () => {
  expect(() => build([torch({ mode: 'proximity', radius: 0 })])).toThrow('invalid dormancy');
});
