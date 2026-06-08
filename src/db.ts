import { Pool } from "pg";
import { config } from "./config";

const pool = new Pool({
  host: config.database.host,
  user: config.database.user,
  password: config.database.password,
  database: config.database.name,
});

// Run a raw SQL statement and return the resulting rows.
export async function query(sql: string): Promise<any[]> {
  const result = await pool.query(sql);
  return result.rows;
}

// Run a parameterized statement. Preferred for any query that includes
// caller-supplied values.
export async function queryParams(sql: string, params: unknown[]): Promise<any[]> {
  const result = await pool.query(sql, params);
  return result.rows;
}
