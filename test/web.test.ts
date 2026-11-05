import { describe, it, expect } from "vitest";
import { createWebApp } from "../src/web/app.js";

function createMockRes(onEnd: (statusCode: number, headers: Record<string, any>, body: string) => void) {
  let statusCode = 200;
  const headers: Record<string, any> = {};
  let body = "";

  const res: any = {
    statusCode: 200,
    setHeader(key: string, val: any) {
      headers[key.toLowerCase()] = val;
      return this;
    },
    getHeader(key: string) {
      return headers[key.toLowerCase()];
    },
    removeHeader(key: string) {
      delete headers[key.toLowerCase()];
    },
    status(code: number) {
      statusCode = code;
      this.statusCode = code;
      return this;
    },
    send(data: any) {
      body = typeof data === "string" ? data : JSON.stringify(data);
      this.end(body);
      return this;
    },
    json(data: any) {
      this.setHeader("content-type", "application/json");
      return this.send(data);
    },
    end(chunk?: any) {
      if (chunk) {
        body = typeof chunk === "string" ? chunk : chunk.toString();
      }
      onEnd(statusCode, headers, body);
    },
  };
  return res;
}

describe("Unified Web Application", () => {
  it("renders the landing page at GET /", async () => {
    const app = createWebApp();

    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      const req: any = {
        method: "GET",
        url: "/",
        headers: {},
      };
      const res = createMockRes((status, _headers, body) => {
        resolve({ status, body });
      });
      app.handle(req, res);
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain("GitPR");
    expect(result.body).toContain("Install on GitHub");
    expect(result.body).toContain("Zero Installation Required");
  });

  it("handles GET /health and returns JSON status", async () => {
    const app = createWebApp();

    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      const req: any = {
        method: "GET",
        url: "/health",
        headers: {},
      };
      const res = createMockRes((status, _headers, body) => {
        resolve({ status, body });
      });
      app.handle(req, res);
    });

    expect([200, 503, 500]).toContain(result.status);
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty("status");
  });
});
