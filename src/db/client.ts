import pg from "pg";

const connectionString =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5433/reviewbot";

export const pool = new pg.Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

