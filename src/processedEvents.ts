// Record of payment-processor webhook event ids that have already been
// handled, so a replayed delivery can be acknowledged without re-running its
// side effects.
//
// Deduplication has to check and reserve in one step. If `has()` and
// `add()` were separate calls, two concurrent deliveries of the same event
// could both see "not processed" before either one recorded it, and both
// would apply the side effects. So a handler first *claims* the id with
// `begin()`, which atomically checks and reserves it. After that it either
// `complete()`s the id (handled successfully, now permanently deduplicated)
// or `release()`s it (handling failed or was rejected, so a retry may claim
// it again).
//
// The interface is async and deliberately minimal so a persistent backend can
// replace the in-memory default without changing the webhook route. For
// example, a Postgres table with a unique constraint on the event id and a
// status column: `begin` is an INSERT ... ON CONFLICT DO NOTHING.
export type BeginResult =
  /** The caller now owns the id and must `complete` or `release` it. */
  | "claimed"
  /** Another delivery of this id is being handled right now. */
  | "in_progress"
  /** The id was already handled successfully. */
  | "done";

export interface ProcessedEventStore {
  begin(eventId: string): Promise<BeginResult>;
  complete(eventId: string): Promise<void>;
  release(eventId: string): Promise<void>;
  /** True once the id has been completed (not while it is only claimed). */
  has(eventId: string): Promise<boolean>;
  clear(): Promise<void>;
}

// In-memory implementation. `begin` does its check and set with no await in
// between, so it is atomic on Node's single-threaded event loop. Ids are lost
// on restart and are not shared across instances; swap in a persistent store
// for multi-instance deployments.
export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly state = new Map<string, "in_progress" | "done">();

  async begin(eventId: string): Promise<BeginResult> {
    const current = this.state.get(eventId);
    if (current) return current;
    this.state.set(eventId, "in_progress");
    return "claimed";
  }

  async complete(eventId: string): Promise<void> {
    this.state.set(eventId, "done");
  }

  async release(eventId: string): Promise<void> {
    if (this.state.get(eventId) === "in_progress") this.state.delete(eventId);
  }

  async has(eventId: string): Promise<boolean> {
    return this.state.get(eventId) === "done";
  }

  async clear(): Promise<void> {
    this.state.clear();
  }
}

export const processedEvents: ProcessedEventStore =
  new InMemoryProcessedEventStore();
