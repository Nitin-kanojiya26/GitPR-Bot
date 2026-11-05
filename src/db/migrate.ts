import fs from "node:fs";
import path from "node:path";
import pg from "pg";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(dbUrl?: string): Promise<MigrationResult> {
  const connectionString =
    dbUrl || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5433/reviewbot";

  const client = new pg.Client({ connectionString });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // 1. Create schema_migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Read migration directory
    const migrationsDir = path.join(process.cwd(), "db", "migrations");
    if (!fs.existsSync(migrationsDir)) {
      console.warn(`[WARN] Migrations directory not found at: ${migrationsDir}`);
      return { applied, skipped };
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // 3. Apply pending migrations sequentially
    for (const file of files) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [file]
      );

      if (rowCount && rowCount > 0) {
        skipped.push(file);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf8");

      console.log(`[MIGRATE] Applying migration: ${file}...`);
      await client.query("BEGIN;");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1);",
          [file]
        );
        await client.query("COMMIT;");
        applied.push(file);
        console.log(`[SUCCESS] [MIGRATE] Applied ${file}`);
      } catch (err: any) {
        await client.query("ROLLBACK;");
        console.error(`[ERROR] [MIGRATE] Failed applying ${file}:`, err?.message || err);
        throw err;
      }
    }

    return { applied, skipped };
  } finally {
    await client.end();
  }
}

// Allow direct execution via CLI
if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  runMigrations()
    .then((result) => {
      console.log(
        `[MIGRATE SUMMARY] Applied: ${result.applied.length}, Skipped: ${result.skipped.length}`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("[FATAL] Migration failed:", err);
      process.exit(1);
    });
}

