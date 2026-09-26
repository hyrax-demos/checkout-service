// Record of payment-processor webhook event ids that have already been
// handled, so a replayed delivery can be acknowledged without re-running its
// side effects.
//
// The interface is async and deliberately minimal so a persistent backend
// (e.g. a Postgres table with a unique constraint) can replace the in-memory
// default without changing the webhook route.
export interface ProcessedEventStore {
  has(eventId: string): Promise<boolean>;
  add(eventId: string): Promise<void>;
  clear(): Promise<void>;
}

// In-memory implementation. Ids are lost on restart and are not shared across
// instances; swap in a persistent store for multi-instance deployments.
export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly ids = new Set<string>();

  async has(eventId: string): Promise<boolean> {
    return this.ids.has(eventId);
  }

  async add(eventId: string): Promise<void> {
    this.ids.add(eventId);
  }

  async clear(): Promise<void> {
    this.ids.clear();
  }
}

export const processedEvents: ProcessedEventStore =
  new InMemoryProcessedEventStore();
