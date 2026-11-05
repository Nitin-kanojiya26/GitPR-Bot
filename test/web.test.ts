import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createWebApp } from "../src/web/app.js";

function createMockReq(options: { method: string; url: string; headers?: Record<string, string> }) {
  const req: any = Object.assign(new EventEmitter(), {
    method: options.method,
    url: options.url,
    headers: options.headers || {},
    connection: { encrypted: false },
    socket: { encrypted: false },
    pipe: () => req,
    unpipe: () => req,
  });
  return req;
}

function createMockRes(onEnd: (statusCode: number, headers: Record<string, any>, body: string) => void) {
  const emitter = new EventEmitter();
  let statusCode = 200;
  const headers: Record<string, any> = {};
  let body = "";

  const res: any = Object.assign(emitter, {
    statusCode: 200,
    headersSent: false,
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
      this.headersSent = true;
      this.emit("finish");
      onEnd(statusCode, headers, body);
    },
  });
  return res;
}

describe("Unified Web Application", () => {
  it("renders the landing page at GET /", async () => {
    const app = createWebApp();

    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = createMockReq({ method: "GET", url: "/" });
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
      const req = createMockReq({ method: "GET", url: "/health" });
      const res = createMockRes((status, _headers, body) => {
        resolve({ status, body });
      });
      app.handle(req, res);
    });

    expect([200, 503, 500]).toContain(result.status);
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty("status");
  });

  it("redirects GET /setup to login when no active session exists", async () => {
    const app = createWebApp();

    const result = await new Promise<{ status: number; headers: Record<string, any> }>((resolve) => {
      const req = createMockReq({ method: "GET", url: "/setup" });
      const res = createMockRes((status, headers) => {
        resolve({ status, headers });
      });
      app.handle(req, res);
    });

    expect(result.status).toBe(302);
    expect(result.headers["location"]).toContain("/auth/login?returnTo=/setup");
  });

  it("redirects GET /probot to / so users never see the default probot page", async () => {
    const app = createWebApp();

    const result = await new Promise<{ status: number; headers: Record<string, any> }>((resolve) => {
      const req = createMockReq({ method: "GET", url: "/probot" });
      const res = createMockRes((status, headers) => {
        resolve({ status, headers });
      });
      app.handle(req, res);
    });

    expect(result.status).toBe(302);
    expect(result.headers["location"]).toBe("/");
  });
});
