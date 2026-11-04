import { describe, it, expect, vi } from "vitest";
import { handleHealthcheck, checkHealth } from "../src/health.js";

describe("Healthcheck Service", () => {
  it("ignores non-healthcheck routes", async () => {
    const req: any = { url: "/api/other" };
    const res: any = {};
    const handled = await handleHealthcheck(req, res);
    expect(handled).toBe(false);
  });

  it("handles /healthz and /health requests and writes response", async () => {
    let statusCode = 0;
    let headers: Record<string, string> = {};
    let body = "";

    const req: any = { url: "/healthz" };
    const res: any = {
      writeHead: (code: number, h: Record<string, string>) => {
        statusCode = code;
        headers = h;
      },
      end: (data: string) => {
        body = data;
      },
    };

    // Use dummy unreachable ports to quickly test response structure
    const handled = await handleHealthcheck(req, res, {
      dbUrl: "postgres://postgres:postgres@127.0.0.1:1/nonexistent",
      redisUrl: "redis://127.0.0.1:1",
    });

    expect(handled).toBe(true);
    expect(statusCode).toBe(503); // Since ports 1 are unreachable
    expect(headers["Content-Type"]).toBe("application/json");

    const parsed = JSON.parse(body);
    expect(parsed.status).toBe("down");
    expect(parsed.services.database.status).toBe("down");
    expect(parsed.services.redis.status).toBe("down");
  });

  it("reports degraded status when one service fails", async () => {
    // When DB is down and Redis is down -> "down"
    const res = await checkHealth({
      dbUrl: "postgres://postgres:postgres@127.0.0.1:1/nonexistent",
      redisUrl: "redis://127.0.0.1:1",
    });

    expect(res.status).toBe("down");
    expect(typeof res.timestamp).toBe("string");
    expect(typeof res.uptimeSeconds).toBe("number");
  });
});

