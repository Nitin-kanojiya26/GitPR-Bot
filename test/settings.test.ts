import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isKeyRateLimited,
  resetRateLimits,
  settingsRouter,
} from "../src/settings/routes.js";
import {
  testGeminiKey,
  saveInstallationKey,
  deleteInstallationKey,
  getDecryptedInstallationKey,
  hasPostedNoKeyWarning,
  recordNoKeyWarning,
} from "../src/settings/service.js";
import * as db from "../src/db/client.js";
import { encryptApiKey } from "../src/security/crypto.js";

describe("Settings Service & Security", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.restoreAllMocks();
  });

  describe("isKeyRateLimited", () => {
    it("allows up to 5 attempts then blocks the 6th", () => {
      const clientKey = "127.0.0.1_user123";

      for (let i = 0; i < 5; i++) {
        expect(isKeyRateLimited(clientKey)).toBe(false);
      }

      // 6th attempt should be blocked
      expect(isKeyRateLimited(clientKey)).toBe(true);
    });

    it("resets limits when resetRateLimits is called", () => {
      const clientKey = "127.0.0.1_user456";

      for (let i = 0; i < 5; i++) {
        isKeyRateLimited(clientKey);
      }
      expect(isKeyRateLimited(clientKey)).toBe(true);

      resetRateLimits();
      expect(isKeyRateLimited(clientKey)).toBe(false);
    });
  });

  describe("testGeminiKey validation", () => {
    it("rejects keys that are empty or too short", async () => {
      const emptyCheck = await testGeminiKey("");
      expect(emptyCheck.valid).toBe(false);
      expect(emptyCheck.error).toContain("too short");

      const shortCheck = await testGeminiKey("short_key");
      expect(shortCheck.valid).toBe(false);
      expect(shortCheck.error).toContain("too short");
    });
  });

  describe("Database Key Operations", () => {
    it("getDecryptedInstallationKey returns null when no key is set", async () => {
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: "",
        oid: 0,
        fields: [],
      });

      const key = await getDecryptedInstallationKey(999);
      expect(key).toBeNull();
    });

    it("getDecryptedInstallationKey decrypts stored payload correctly", async () => {
      const originalKey = "AIzaSyD_TEST_DATABASE_KEY_77";
      const { encryptedKey, ivAndTag } = encryptApiKey(originalKey);

      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [{ encrypted_key: encryptedKey, key_iv_and_tag: ivAndTag }],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      });

      const decrypted = await getDecryptedInstallationKey(12345);
      expect(decrypted).toBe(originalKey);
    });

    it("deleteInstallationKey updates database setting to null", async () => {
      let executedQuery = "";
      let params: any[] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, values?: any[]) => {
        executedQuery = sql;
        params = values || [];
        return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] };
      });

      await deleteInstallationKey(54321);
      expect(executedQuery).toContain("SET encrypted_key = NULL");
      expect(params).toEqual([54321]);
    });

    it("hasPostedNoKeyWarning returns false when no warning recorded", async () => {
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: "",
        oid: 0,
        fields: [],
      });

      const warned = await hasPostedNoKeyWarning("owner/repo");
      expect(warned).toBe(false);
    });

    it("recordNoKeyWarning stores notice in database and hasPostedNoKeyWarning returns true", async () => {
      const queries: string[] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT 1 FROM reviews")) {
          return { rows: [{ "?column?": 1 }], rowCount: 1, command: "", oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] };
      });

      await recordNoKeyWarning(123, "owner/repo", 42);
      expect(queries.some((q) => q.includes("INSERT INTO reviews"))).toBe(true);

      const warned = await hasPostedNoKeyWarning("owner/repo");
      expect(warned).toBe(true);
    });
  });

  describe("Settings Multi-Tenant Security Routes", () => {
    it("GET /settings denies access to an installation the user does not own", async () => {
      const req: any = {
        session: {
          user: { id: 1, login: "bob" },
          installations: [100, 200], // User owns #100 and #200
        },
        query: {
          installation_id: "999", // Trying to access victim's #999
        },
      };

      let statusCode = 200;
      let renderedView = "";
      let renderData: any = {};

      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        render(view: string, data: any) {
          renderedView = view;
          renderData = data;
        },
      };

      // Find GET "/" route handler
      const getHandler = (settingsRouter.stack as any[]).find(
        (layer) => layer.route && layer.route.path === "/" && layer.route.methods.get
      )?.route.stack.slice(-1)[0].handle;

      await getHandler(req, res);

      expect(statusCode).toBe(403);
      expect(renderedView).toBe("settings");
      expect(renderData.error).toContain("not authorized");
    });

    it("POST /settings/key returns 403 Forbidden if installation_id is not in session", async () => {
      const req: any = {
        session: {
          user: { id: 1, login: "bob" },
          installations: [100],
        },
        body: {
          installation_id: "999", // Unauthorized installation
          api_key: "AIzaSyD_SOME_VALID_LENGTH_KEY",
        },
      };

      let statusCode = 200;
      let sentBody = "";

      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        send(body: string) {
          sentBody = body;
        },
      };

      const postKeyHandler = (settingsRouter.stack as any[]).find(
        (layer) => layer.route && layer.route.path === "/key" && layer.route.methods.post
      )?.route.stack.slice(-1)[0].handle;

      await postKeyHandler(req, res);

      expect(statusCode).toBe(403);
      expect(sentBody).toContain("Forbidden");
    });

    it("POST /settings/key rate limits excessive key verification attempts", async () => {
      const req: any = {
        ip: "127.0.0.1",
        session: {
          user: { id: 99, login: "spammer" },
          installations: [100],
        },
        body: {
          installation_id: "100",
          api_key: "AIzaSyD_SOME_KEY_123456789",
        },
      };

      let redirectUrl = "";
      const res: any = {
        redirect(url: string) {
          redirectUrl = url;
        },
      };

      const postKeyHandler = (settingsRouter.stack as any[]).find(
        (layer) => layer.route && layer.route.path === "/key" && layer.route.methods.post
      )?.route.stack.slice(-1)[0].handle;

      // Exhaust 5 allowed attempts
      for (let i = 0; i < 5; i++) {
        isKeyRateLimited(`127.0.0.1_99`);
      }

      await postKeyHandler(req, res);

      expect(redirectUrl).toContain("error=Too%20many%20key%20verification%20attempts");
    });
  });
});

