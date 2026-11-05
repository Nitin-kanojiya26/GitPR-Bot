import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { settingsRouter, handleUpdateGuide } from "../src/settings/routes.js";
import { dashboardRouter } from "../src/dashboard/routes.js";
import { getDashboardData } from "../src/dashboard/service.js";
import { retrieveRules } from "../src/review/rag.js";
import { encryptApiKey, decryptApiKey } from "../src/security/crypto.js";
import { getInstallationSettings } from "../src/settings/service.js";
import { handleInstallationDeleted } from "../src/installations/service.js";
import { createWebApp } from "../src/web/app.js";
import * as db from "../src/db/client.js";
import * as embed from "../src/review/embed.js";

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

describe("Strict Multi-Tenant Isolation & Security Audit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const USER_A_INST = 1001;
  const USER_B_INST = 2002;

  describe("Cross-Tenant Settings Isolation", () => {
    it("prevents User B from viewing User A's settings (returns 403)", async () => {
      const req: any = {
        session: {
          user: { id: 2, login: "attacker-bob" },
          installations: [USER_B_INST], // Bob only owns 2002
        },
        query: {
          installation_id: String(USER_A_INST), // Bob tries to access Alice's 1001
        },
      };

      let statusCode = 200;
      let renderedData: any = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        render(_view: string, data: any) {
          renderedData = data;
        },
      };

      const getSettings = (settingsRouter.stack as any[]).find(
        (l) => l.route && l.route.path === "/" && l.route.methods.get
      )?.route.stack.slice(-1)[0].handle;

      await getSettings(req, res);

      expect(statusCode).toBe(403);
      expect(renderedData.error).toContain("not authorized");
    });

    it("prevents User B from setting User A's API key (returns 403)", async () => {
      const req: any = {
        session: {
          user: { id: 2, login: "attacker-bob" },
          installations: [USER_B_INST],
        },
        body: {
          installation_id: USER_A_INST,
          api_key: "AIzaSyD_SOME_VALID_KEY_12345",
        },
      };

      let statusCode = 200;
      let responseBody = "";
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        send(msg: string) {
          responseBody = msg;
        },
      };

      const postKey = (settingsRouter.stack as any[]).find(
        (l) => l.route && l.route.path === "/key" && l.route.methods.post
      )?.route.stack.slice(-1)[0].handle;

      await postKey(req, res);

      expect(statusCode).toBe(403);
      expect(responseBody).toContain("Forbidden");
    });

    it("prevents User B from deleting User A's API key (returns 403)", async () => {
      const req: any = {
        session: {
          user: { id: 2, login: "attacker-bob" },
          installations: [USER_B_INST],
        },
        body: {
          installation_id: USER_A_INST,
        },
      };

      let statusCode = 200;
      let responseBody = "";
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        send(msg: string) {
          responseBody = msg;
        },
      };

      const deleteKey = (settingsRouter.stack as any[]).find(
        (l) => l.route && l.route.path === "/key/delete" && l.route.methods.post
      )?.route.stack.slice(-1)[0].handle;

      await deleteKey(req, res);

      expect(statusCode).toBe(403);
      expect(responseBody).toContain("Forbidden");
    });

    it("prevents User B from overwriting User A's style guide (returns 403)", async () => {
      const req: any = {
        session: {
          user: { id: 2, login: "attacker-bob" },
          installations: [USER_B_INST],
        },
        body: {
          installation_id: USER_A_INST,
          guide_md: "## Malicious Rule\nHack system",
        },
        xhr: true,
      };

      let statusCode = 200;
      let jsonBody: any = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          jsonBody = data;
        },
      };

      await handleUpdateGuide(req, res);

      expect(statusCode).toBe(403);
      expect(jsonBody.error).toContain("Forbidden");
    });
  });

  describe("Cross-Tenant Dashboard Isolation", () => {
    it("prevents User B from querying User A's analytics metrics via query param (returns 403)", async () => {
      const req: any = {
        session: {
          user: { id: 2, login: "attacker-bob" },
          installations: [USER_B_INST],
        },
        query: {
          installation_id: String(USER_A_INST),
        },
      };

      let statusCode = 200;
      let renderedData: any = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        render(_view: string, data: any) {
          renderedData = data;
        },
      };

      const getDashboard = (dashboardRouter.stack as any[]).find(
        (l) => l.route && l.route.path === "/" && l.route.methods.get
      )?.route.stack.slice(-1)[0].handle;

      await getDashboard(req, res);

      expect(statusCode).toBe(403);
      expect(renderedData.error).toContain("Forbidden");
    });

    it("ensures getDashboardData queries strictly partition data by tenant installation ID", async () => {
      const queryParams: any[][] = [];

      vi.spyOn(db, "query").mockImplementation(async (_sql: string, params?: any[]) => {
        queryParams.push(params || []);
        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
      });

      await getDashboardData([USER_B_INST]);

      // All 4 dashboard queries must filter strictly by User B's installation
      for (const p of queryParams) {
        expect(p[0]).toEqual([USER_B_INST]);
        expect(p[0]).not.toContain(USER_A_INST);
      }
    });
  });

  describe("Multi-Tenant RAG Vector Retrieval Isolation", () => {
    it("retrieves only rules matching the tenant installation_id and never cross-pollinates", async () => {
      let executedSql = "";
      let executedParams: any[] = [];

      vi.spyOn(embed, "embedText").mockResolvedValue(new Array(768).fill(0.01));
      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedSql = sql;
        executedParams = params || [];
        return {
          rows: [{ title: "Tenant B Rule", content: "Content B", similarity: "0.89" }],
          rowCount: 1,
          command: "",
          oid: 0,
          fields: [],
        };
      });

      const rules = await retrieveRules("test code", 3, USER_B_INST);

      expect(rules).toHaveLength(1);
      expect(rules[0].title).toBe("Tenant B Rule");

      // Verify the query strictly filters by User B's installation ID
      expect(executedSql).toContain("WHERE installation_id = $2");
      expect(executedParams[1]).toBe(USER_B_INST);
      expect(executedParams[1]).not.toBe(USER_A_INST);
    });
  });

  describe("Key Storage Security & Leakage Audit", () => {
    const rawApiKey = "AIzaSyD_CRITICAL_SECRET_KEY_1234567890";

    it("encrypts with AES-256-GCM and never stores raw key in ciphertext", () => {
      const payload = encryptApiKey(rawApiKey);

      expect(payload.encryptedKey).not.toContain("AIzaSyD");
      expect(payload.last4).toBe("7890");
      expect(payload.ivAndTag).toContain(":");

      // Decrypts accurately with valid IV & tag
      expect(decryptApiKey(payload.encryptedKey, payload.ivAndTag)).toBe(rawApiKey);
    });

    it("verifies settings query returns last4 only and never returns ciphertext or plaintext", async () => {
      const payload = encryptApiKey(rawApiKey);

      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [
          {
            installation_id: USER_A_INST,
            last4: payload.last4,
            guide_md: "## Guide",
            guide_version: 1,
            index_status: "indexed",
            account_login: "alice-team",
            account_type: "Organization",
          },
        ],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      });

      const settings = await getInstallationSettings(USER_A_INST);

      expect(settings).toBeDefined();
      expect(settings.last4).toBe("7890");
      expect(settings.encrypted_key).toBeUndefined();
      expect(JSON.stringify(settings)).not.toContain("AIzaSyD");
    });
  });

  describe("Tenant Purge on Uninstall", () => {
    it("deletes tenant from installations triggering cascading foreign key deletion", async () => {
      let executedSql = "";
      let queryParams: any[] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedSql = sql;
        queryParams = params || [];
        return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] };
      });

      await handleInstallationDeleted(USER_A_INST);

      expect(executedSql).toContain("DELETE FROM installations WHERE installation_id = $1");
      expect(queryParams).toEqual([USER_A_INST]);
    });
  });

  describe("Privacy Policy Page", () => {
    it("renders /privacy with plain-language explanations", async () => {
      const app = createWebApp();

      const result = await new Promise<{ status: number; body: string }>((resolve) => {
        const req = createMockReq({ method: "GET", url: "/privacy" });
        const res = createMockRes((status, _headers, body) => {
          resolve({ status, body });
        });
        app.handle(req, res);
      });

      expect(result.status).toBe(200);
      expect(result.body).toContain("GitPR Privacy Policy");
      expect(result.body).toContain("Ephemeral Diff Transmission");
      expect(result.body).toContain("Bring-Your-Own-Key");
      expect(result.body).toContain("Complete Data Deletion on Uninstall");
    });
  });
});
