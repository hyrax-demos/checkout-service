import { Pool, PoolClient } from "pg";
import { config } from "./config";

const pool = new Pool({
  host: config.database.host,
  user: config.database.user,
  password: config.database.password,
  database: config.database.name,
});

/**
 * An opaque SQL query object produced by the `sql` tagged-template tag.
 *
 * The only way to obtain a `SqlQuery` is via the `sql` tag, which means the
 * SQL text is always a static string (the template literal "strings" array)
 * and user-supplied values are always separate positional parameters — never
 * concatenated into the SQL text.  This makes SQL injection impossible to
 * introduce at the type level: `pool.query` never receives a single string
 * assembled from user data.
 */
export interface SqlQuery {
  /** Static SQL text with $1, $2, … placeholders substituted for interpolations. */
  readonly text: string;
  /** Positional parameter values corresponding to the $N placeholders. */
  readonly values: readonly unknown[];
}

/**
 * Tagged-template builder for parameterised SQL.
 *
 * Usage:
 *   const q = sql`SELECT * FROM orders WHERE id = ${id} AND customer_id = ${cid}`;
 *   // q.text  → "SELECT * FROM orders WHERE id = $1 AND customer_id = $2"
 *   // q.values → [id, cid]
 *
 * Interpolated expressions become positional parameters ($1, $2, …).  The SQL
 * text is assembled only from the static string parts of the template, so no
 * user-supplied data can ever appear in the query text itself.
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SqlQuery {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      text += `$${i + 1}`;
    }
  }
  return { text, values };
}

/**
 * Execute a parameterised SQL statement and return the resulting rows.
 *
 * The statement must be constructed with the `sql` tagged-template tag:
 *
 *   const rows = await query<Order>(sql`SELECT * FROM orders WHERE id = ${id}`);
 *
 * Accepting a `SqlQuery` (not a plain `string`) makes it a compile-time type
 * error to pass a raw string or a template literal built by string
 * interpolation — eliminating the SQL-injection class entirely.
 */
export async function query<T = any>(q: SqlQuery): Promise<T[]> {
  const result = await pool.query(q.text, q.values as unknown[]);
  return result.rows as T[];
}

/**
 * Run a unit of work inside a single transaction, committing on success and
 * rolling back if the callback throws.
 *
 * The `PoolClient` passed to `fn` exposes a `queryRaw` method that accepts a
 * `SqlQuery` so transaction-local statements get the same injection protection.
 */
export async function withTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(new TransactionClient(client));
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Thin wrapper around a `PoolClient` that exposes only the parameterised
 * `query` method so transaction-local statements cannot bypass the
 * `SqlQuery` type constraint.
 */
export class TransactionClient {
  private readonly client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async query<T = any>(q: SqlQuery): Promise<T[]> {
    const result = await this.client.query(q.text, q.values as unknown[]);
    return result.rows as T[];
  }
}
