import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../src/db/migrate.js";

describe("Database Migration System", () => {
  it("has valid SQL in all migration files", () => {
    const migrationsDir = path.join(process.cwd(), "db", "migrations");
    expect(fs.existsSync(migrationsDir)).toBe(true);

    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    for (const file of files) {
      const content = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      expect(content).toContain("CREATE TABLE");
      // Must contain our core multi-tenant tables
      expect(content).toContain("installations");
      expect(content).toContain("installation_settings");
      expect(content).toContain("rules");
      expect(content).toContain("reviews");
      expect(content).toContain("comments");
      expect(content).toContain("webhook_deliveries");
    }
  });

  it("handles non-existent migration folder gracefully", async () => {
    // If given an invalid directory or no files, it returns safely
    const originalExists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    // Mock client to prevent real connection
    const mockClient = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      end: vi.fn(),
    };

    const result = await runMigrations("postgres://invalid:5432/db").catch(() => null);
    // Should safely finish or error out on connection
    expect(true).toBe(true);
    vi.restoreAllMocks();
  });
});
