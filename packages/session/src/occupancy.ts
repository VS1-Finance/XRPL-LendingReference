import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Occupant, Seat } from "./seat.js";

// Seat occupancy is session metadata, not on-chain state, so it is persisted next to the session's
// provisioned graph. This lets separate processes — a bot runner, a participant joining, a listing —
// agree on who holds which seat across invocations.

type OccupancyMap = Record<string, Occupant>;

function pathFor(setupId: string, dir: string): string {
  return join(resolve(dir), `${setupId}.seats.json`);
}

export function saveOccupancy(setupId: string, seats: Map<string, Seat>, dir = "out"): void {
  mkdirSync(resolve(dir), { recursive: true });
  const map: OccupancyMap = {};
  for (const [key, seat] of seats) map[key] = seat.occupant;
  writeFileSync(pathFor(setupId, dir), JSON.stringify(map, null, 2) + "\n", "utf8");
}

// Apply any persisted occupancy onto freshly built seats. Seats without a saved entry keep their
// default (bot-filled).
export function applyOccupancy(setupId: string, seats: Map<string, Seat>, dir = "out"): void {
  const file = pathFor(setupId, dir);
  if (!existsSync(file)) return;
  const map = JSON.parse(readFileSync(file, "utf8")) as OccupancyMap;
  for (const [key, occupant] of Object.entries(map)) {
    const seat = seats.get(key);
    if (seat) seat.occupant = occupant;
  }
}
