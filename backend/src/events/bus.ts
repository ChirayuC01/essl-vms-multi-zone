import { EventEmitter } from "node:events";

// In-process pub/sub feeding the SSE stream (Phase 1 Milestone 5).
//
// Deliberately in-memory: Phase 1 runs one backend process, and a Postgres
// LISTEN/NOTIFY or pg-boss fan-out would be infrastructure with no second
// subscriber to justify it. The consequence is written down rather than
// discovered later — with two backend processes, a browser connected to one
// would not see events raised on the other. Revisit if the service is ever
// scaled out; until then this is the honest amount of machinery.

export interface PunchEventPayload {
  id: string;
  esslUserId: string;
  deviceId: string;
  deviceSerialNo: string;
  deviceName: string | null;
  punchedAtUtc: string;
  punchedAtDevice: string;
  receivedAt: string;
  verifyMode: number | null;
  statusCode: number | null;
  person: { id: string; name: string } | null;
}

export interface CommandEventPayload {
  id: string;
  type: string;
  status: string;
  targetDeviceId: string;
  deviceCmdId: number | null;
  personId: string | null;
  entryId: string | null;
  lastError: string | null;
}

export interface EntryEventPayload {
  id: string;
  personId: string;
  state: string;
  dayBlocked: boolean;
}

export interface VmsEvents {
  punch: PunchEventPayload;
  command: CommandEventPayload;
  entry: EntryEventPayload;
}

export type VmsEventName = keyof VmsEvents;

const emitter = new EventEmitter();
// A browser tab per operator, plus reconnects; the default limit of 10 would
// start printing warnings on a busy gate for no reason.
emitter.setMaxListeners(100);

/**
 * Publish an event. Never throws into the caller: a live feed is a
 * convenience, and a subscriber blowing up must not fail a punch ingest or a
 * device command. Failures are swallowed here and surface as a missing UI
 * update, not as lost data.
 */
export function publish<K extends VmsEventName>(name: K, payload: VmsEvents[K]): void {
  try {
    emitter.emit(name, payload);
  } catch {
    /* a broken subscriber must never break ingestion */
  }
}

export function subscribe<K extends VmsEventName>(
  name: K,
  listener: (payload: VmsEvents[K]) => void,
): () => void {
  emitter.on(name, listener as (payload: unknown) => void);
  return () => emitter.off(name, listener as (payload: unknown) => void);
}
