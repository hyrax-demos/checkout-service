import { Pool, PoolClient } from "pg";
import { config } from "./config";

const pool = new Pool({
  host: config.database.host,
  user: config.database.user,
  password: config.database.password,
  database: config.database.name,
});

// Run a parameterized statement and return the resulting rows. Values must be
// passed via `params` placeholders ($1, $2, ...) — never interpolated into the
// SQL string.
export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

// Run a unit of work inside a single transaction, committing on success and
// rolling back if the callback throws.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
