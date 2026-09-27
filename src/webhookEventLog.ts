// Audit log of payment-processor webhook deliveries, surfaced to admins via
// GET /admin/webhook-events. Every delivery is recorded exactly once with its
// outcome, including rejected attempts (bad signature, stale timestamp,
// malformed body, invalid transition, handler error).
//
// This is separate from `processedEvents`: that store decides whether an
// event's side effects run, while this one is an observability record and
// never influences request handling.
//
// The interface is async so a persistent backend (e.g. a Postgres table) can
// replace the in-memory default without changing the route or admin API.

export type WebhookOutcome = "processed" | "duplicate" | "rejected";

export interface WebhookEventLogEntry {
  /** Event id from the payload; null when it was not available or not trusted. */
  event_id: string | null;
  type: string | null;
  order_id: string | null;
  outcome: WebhookOutcome;
  /** Short machine-readable reason for rejected/duplicate outcomes. */
  reason: string | null;
  /** HTTP status returned to the processor. */
  status: number;
  /** ISO-8601 time the delivery was received. */
  received_at: string;
}

export interface WebhookEventPage {
  events: WebhookEventLogEntry[];
  total: number;
}

export interface WebhookEventLog {
  record(entry: WebhookEventLogEntry): Promise<void>;
  /** Entries newest first. */
  list(opts: { limit: number; offset: number }): Promise<WebhookEventPage>;
  clear(): Promise<void>;
}

// Rejected attempts include unauthenticated requests, so the in-memory log is
// capped: once full, the oldest entries are dropped. Entries are lost on
// restart and are per instance.
export const DEFAULT_MAX_LOG_ENTRIES = 1000;

export class InMemoryWebhookEventLog implements WebhookEventLog {
  // Oldest first; `list` reads from the end.
  private entries: WebhookEventLogEntry[] = [];

  constructor(private readonly maxEntries: number = DEFAULT_MAX_LOG_ENTRIES) {}

  async record(entry: WebhookEventLogEntry): Promise<void> {
    this.entries.push({ ...entry });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  async list({ limit, offset }: { limit: number; offset: number }): Promise<WebhookEventPage> {
    const total = this.entries.length;
    const end = Math.max(total - offset, 0);
    const start = Math.max(end - limit, 0);
    const events = this.entries
      .slice(start, end)
      .reverse()
      .map((e) => ({ ...e }));
    return { events, total };
  }

  async clear(): Promise<void> {
    this.entries = [];
  }
}

export const webhookEventLog: WebhookEventLog = new InMemoryWebhookEventLog();
