import { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import Redis from "ioredis";

export interface ServiceHealth {
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  timestamp: string;
  uptimeSeconds: number;
  services: {
    database: ServiceHealth;
    redis: ServiceHealth;
  };
}

/**
 * Pings PostgreSQL with SELECT 1 and records latency.
 */
export async function pingDatabase(dbUrl: string): Promise<ServiceHealth> {
  const start = Date.now();
  const client = new pg.Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 3000,
  });

  try {
    await client.connect();
    await client.query("SELECT 1;");
    const latencyMs = Date.now() - start;
    return { status: "up", latencyMs };
  } catch (err: any) {
    return { status: "down", error: err?.message || String(err) };
  } finally {
    try {
      await client.end();
    } catch {
      // Ignore disconnect error
    }
  }
}

/**
 * Pings Redis with PING and records latency.
 */
export async function pingRedis(redisUrl: string): Promise<ServiceHealth> {
  const start = Date.now();
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 3000,
  });

  try {
    await redis.ping();
    const latencyMs = Date.now() - start;
    return { status: "up", latencyMs };
  } catch (err: any) {
    return { status: "down", error: err?.message || String(err) };
  } finally {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }
}

/**
 * Aggregates health status across all dependent services.
 */
export async function checkHealth(options?: {
  dbUrl?: string;
  redisUrl?: string;
}): Promise<HealthStatus> {
  const dbUrl =
    options?.dbUrl ||
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5433/reviewbot";
  const redisUrl =
    options?.redisUrl || process.env.REDIS_URL || "redis://localhost:6380";

  const [dbHealth, redisHealth] = await Promise.all([
    pingDatabase(dbUrl),
    pingRedis(redisUrl),
  ]);

  let overallStatus: "ok" | "degraded" | "down" = "ok";

  if (dbHealth.status === "down" && redisHealth.status === "down") {
    overallStatus = "down";
  } else if (dbHealth.status === "down" || redisHealth.status === "down") {
    overallStatus = "degraded";
  }

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    services: {
      database: dbHealth,
      redis: redisHealth,
    },
  };
}

/**
 * HTTP handler middleware for /healthz and /health endpoints.
 */
export async function handleHealthcheck(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { dbUrl?: string; redisUrl?: string }
): Promise<boolean> {
  const url = req.url?.split("?")[0];
  if (url === "/healthz" || url === "/health") {
    const health = await checkHealth(options);
    const statusCode = health.status === "ok" ? 200 : 503;

    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(JSON.stringify(health, null, 2));
    return true;
  }

  return false;
}

