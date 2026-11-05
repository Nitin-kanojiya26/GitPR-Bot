import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseGuideMarkdown,
  syncInstallationRules,
  getDefaultGuideMarkdown,
} from "../src/installations/service.js";
import { retrieveRules, formatRulesForPrompt } from "../src/review/rag.js";
import { settingsRouter, handleUpdateGuide } from "../src/settings/routes.js";
import * as db from "../src/db/client.js";
import * as embed from "../src/review/embed.js";

describe("Editable Review Guide & Multi-Tenant RAG", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseGuideMarkdown & Defaults", () => {
    it("returns default guide with 10-15 standard rules", () => {
      const defaultMd = getDefaultGuideMarkdown();
      expect(defaultMd).toBeDefined();
      expect(defaultMd.length).toBeGreaterThan(500);

      const rules = parseGuideMarkdown(defaultMd);
      expect(rules.length).toBeGreaterThanOrEqual(10);
      expect(rules.length).toBeLessThanOrEqual(15);
      expect(rules[0].title).toBeDefined();
      expect(rules[0].content).toContain("Bad Example");
    });

    it("rejects markdown exceeding 20,000 characters", () => {
      const oversized = "## Oversized Rule\n" + "x".repeat(20005);
      expect(() => parseGuideMarkdown(oversized)).toThrow("exceeds maximum allowed length");
    });

    it("caps parsed rules at maximum 30 rules", () => {
      let customMd = "# My Style Guide\n";
      for (let i = 1; i <= 35; i++) {
        customMd += `\n## Rule Number ${i}\nDetails for rule ${i}\n`;
      }

      const rules = parseGuideMarkdown(customMd);
      expect(rules).toHaveLength(30);
      expect(rules[29].title).toBe("Rule Number 30");
    });
  });

  describe("syncInstallationRules (Atomic Transaction)", () => {
    it("atomically updates rules, increments version, and sets index_status to indexed", async () => {
      const executedSql: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
          executedSql.push(sql);
          return { rows: [], rowCount: 1 };
        }),
        release: vi.fn(),
      };

      vi.spyOn(db.pool, "connect").mockResolvedValue(mockClient as any);
      vi.spyOn(embed, "embedText").mockResolvedValue(new Array(768).fill(0.01));

      const sampleGuide = `## Safe Math\nNever divide by zero.`;
      const result = await syncInstallationRules(12345, sampleGuide);

      expect(result.success).toBe(true);
      expect(result.ruleCount).toBe(1);

      // Verify transaction boundary
      expect(executedSql[0]).toBe("BEGIN;");
      expect(executedSql.some((q) => q.includes("DELETE FROM rules WHERE installation_id = $1"))).toBe(true);
      expect(executedSql.some((q) => q.includes("INSERT INTO rules"))).toBe(true);
      expect(executedSql.some((q) => q.includes("guide_version = COALESCE"))).toBe(true);
      expect(executedSql[executedSql.length - 1]).toBe("COMMIT;");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("rolls back transaction and sets index_status to failed on error", async () => {
      const executedSql: string[] = [];
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          executedSql.push(sql);
          if (sql.includes("INSERT INTO rules")) {
            throw new Error("Vector embedding dimension mismatch");
          }
          return { rows: [], rowCount: 1 };
        }),
        release: vi.fn(),
      };

      vi.spyOn(db.pool, "connect").mockResolvedValue(mockClient as any);
      vi.spyOn(embed, "embedText").mockResolvedValue(new Array(768).fill(0.01));

      const sampleGuide = `## Safe Math\nNever divide by zero.`;
      await expect(syncInstallationRules(12345, sampleGuide)).rejects.toThrow(
        "Vector embedding dimension mismatch"
      );

      expect(executedSql).toContain("ROLLBACK;");
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe("Multi-Tenant RAG Rule Retrieval", () => {
    it("returns empty array when query is empty or no installation_id is provided", async () => {
      expect(await retrieveRules("", 3, 100)).toEqual([]);
      expect(await retrieveRules("some code", 3, undefined)).toEqual([]);
    });

    it("scopes rule retrieval strictly to the tenant installation_id", async () => {
      let querySql = "";
      let queryParams: any[] = [];

      vi.spyOn(embed, "embedText").mockResolvedValue(new Array(768).fill(0.02));
      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        querySql = sql;
        queryParams = params || [];
        return {
          rows: [
            {
              title: "Tenant A Rule",
              content: "Specific to Tenant A",
              similarity: "0.92",
            },
          ],
          rowCount: 1,
          command: "",
          oid: 0,
          fields: [],
        };
      });

      const retrieved = await retrieveRules("fetch without timeout", 3, 9999);

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].title).toBe("Tenant A Rule");
      expect(retrieved[0].similarity).toBe(0.92);

      // Verify SQL contains multi-tenant filter on installation_id
      expect(querySql).toContain("WHERE installation_id = $2");
      expect(queryParams[1]).toBe(9999);
      expect(queryParams[2]).toBe(3);
    });

    it("formats retrieved rules cleanly for prompt injection", () => {
      const promptText = formatRulesForPrompt([
        { title: "No Eval", content: "Never use eval.", similarity: 0.95 },
      ]);

      expect(promptText).toContain("### RELEVANT TEAM STYLE GUIDE RULES:");
      expect(promptText).toContain("[Rule 1] No Eval");
      expect(promptText).toContain("Never use eval.");
    });
  });

  describe("Web Route Security: POST /settings/guide & PUT /settings/guide", () => {
    it("forbids updating guide if installation_id is not in user session", async () => {
      const req: any = {
        session: {
          user: { id: 1, login: "alice" },
          installations: [100, 200], // User does not own #999
        },
        body: {
          installation_id: 999,
          guide_md: "## Rule\nContent",
        },
        xhr: true,
      };

      let statusCode = 200;
      let jsonBody: any = null;
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

    it("rejects guides exceeding 20,000 characters", async () => {
      const req: any = {
        session: {
          user: { id: 1, login: "alice" },
          installations: [100],
        },
        body: {
          installation_id: 100,
          guide_md: "## Huge Rule\n" + "A".repeat(20005),
        },
        xhr: true,
      };

      let statusCode = 200;
      let jsonBody: any = null;
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

      expect(statusCode).toBe(400);
      expect(jsonBody.error).toContain("20,000 characters");
    });

    it("successfully updates guide and returns JSON when requested via API", async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
        release: vi.fn(),
      };
      vi.spyOn(db.pool, "connect").mockResolvedValue(mockClient as any);
      vi.spyOn(embed, "embedText").mockResolvedValue(new Array(768).fill(0.01));

      const req: any = {
        session: {
          user: { id: 1, login: "alice" },
          installations: [100],
        },
        body: {
          installation_id: 100,
          guide_md: "## Clean Code\nWrite meaningful comments.",
        },
        xhr: true,
      };

      let jsonBody: any = null;
      const res: any = {
        json(data: any) {
          jsonBody = data;
        },
      };

      await handleUpdateGuide(req, res);

      expect(jsonBody).toBeDefined();
      expect(jsonBody.success).toBe(true);
      expect(jsonBody.ruleCount).toBe(1);
      expect(jsonBody.index_status).toBe("indexed");
    });
  });
});

