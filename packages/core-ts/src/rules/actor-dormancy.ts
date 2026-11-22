import type { ActorRecord } from '../state/actor-types.ts';

/**
 * #906: a dormant actor (a torch waiting for someone to come near) has no lit affinity, so it
 * projects no field and pays no upkeep. Its trigger is pure position data on the record; core
 * invents none. The first living external actor that satisfies it wakes the actor for good.
 */
function triggered(actor: ActorRecord, others: readonly ActorRecord[]): boolean {
  const dormancy = actor.dormant;
  if (!dormancy) return false;
  const visitors = others.filter(other => other.alignment === 'external' && other.lifecycle === 'alive');
  if (dormancy.mode === 'proximity') {
    return visitors.some(other => Math.max(Math.abs(other.position.x - actor.position.x),
      Math.abs(other.position.y - actor.position.y)) <= dormancy.radius);
  }
  const { x, y, width, height } = dormancy.area;
  return visitors.some(other => other.position.x >= x && other.position.x < x + width
    && other.position.y >= y && other.position.y < y + height);
}

/** Wake every dormant actor whose trigger holds; returns their ids in actor order. */
export function wakeDormantActors(actors: readonly ActorRecord[]): string[] {
  const woken: string[] = [];
  for (const actor of actors) {
    if (actor.lifecycle !== 'alive' || !triggered(actor, actors)) continue;
    delete actor.dormant;
    woken.push(actor.id);
  }
  return woken;
}
