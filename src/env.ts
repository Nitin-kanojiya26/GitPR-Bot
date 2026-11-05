import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Synchronously loads environment variables from .env into process.env if present.
 * Ensures that process.env.REDIS_URL, DATABASE_URL, etc. are available immediately
 * before any static module imports (e.g. BullMQ, pg, ioredis) are initialized.
 */
function loadLocalEnv(): void {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  try {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) {
        continue;
      }
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Non-fatal if .env cannot be read
  }
}

function sanitizeEnv(): void {
  const keysToClean = [
    "WEBHOOK_SECRET",
    "APP_ID",
    "CLIENT_ID",
    "CLIENT_SECRET",
    "BASE_URL",
    "ENCRYPTION_KEY",
    "SESSION_SECRET",
    "DATABASE_URL",
    "REDIS_URL",
  ];

  for (const key of keysToClean) {
    const val = process.env[key];
    if (typeof val === "string") {
      let cleaned = val.trim();
      if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
      ) {
        cleaned = cleaned.slice(1, -1).trim();
      }
      process.env[key] = cleaned;
    }
  }
}

loadLocalEnv();
sanitizeEnv();

