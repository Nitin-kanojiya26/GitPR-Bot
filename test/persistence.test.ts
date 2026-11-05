import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  determineRuleTitle,
  recordReviewResult,
} from "../src/review/persistence.js";
import * as db from "../src/db/client.js";

describe("Review & Comment Persistence for Dashboard Analytics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("determineRuleTitle Heuristics", () => {
    const sampleRules = [
      {
        title: "Safe Code Execution (Never Use eval)",
        content: "Do not execute dynamic strings.",
        similarity: 0.9,
      },
      {
        title: "No Hardcoded Secrets or Credentials",
        content: "Use environment variables.",
        similarity: 0.85,
      },
      {
        title: "Parameterized SQL Queries",
        content: "Avoid SQL injection.",
        similarity: 0.82,
      },
      {
        title: "Network Requests Must Have Timeouts",
        content: "Always specify AbortController.",
        similarity: 0.8,
      },
    ];

    it("prioritizes explicit rule_title if provided by LLM", () => {
      const comment = {
        comment: "Some comment text",
        rule_title: "Custom Security Rule",
      };
      expect(determineRuleTitle(comment, sampleRules)).toBe("Custom Security Rule");
    });

    it("matches rule from text keywords (e.g. eval)", () => {
      const comment = {
        comment: "Detected dangerous eval(userInput) call that creates an RCE vulnerability.",
      };
      expect(determineRuleTitle(comment, sampleRules)).toBe(
        "Safe Code Execution (Never Use eval)"
      );
    });

    it("matches rule from text keywords (e.g. secret / api key)", () => {
      const comment = {
        comment: "Hardcoded Stripe API key detected in client code.",
      };
      expect(determineRuleTitle(comment, sampleRules)).toBe(
        "No Hardcoded Secrets or Credentials"
      );
    });

    it("matches rule from text keywords (e.g. sql injection)", () => {
      const comment = {
        comment: "SQL query string concatenation vulnerable to injection attack.",
      };
      expect(determineRuleTitle(comment, sampleRules)).toBe(
        "Parameterized SQL Queries"
      );
    });

    it("matches rule from text keywords (e.g. timeout)", () => {
      const comment = {
        comment: "External fetch() missing required abort timeout handler.",
      };
      expect(determineRuleTitle(comment, sampleRules)).toBe(
        "Network Requests Must Have Timeouts"
      );
    });

    it("falls back to 'General Code Quality' when no rule matches", () => {
      const comment = {
        comment: "Variable foo is never used in this scope.",
      };
      expect(determineRuleTitle(comment, sampleRules)).toBe(
        "General Code Quality"
      );
    });
  });

  describe("recordReviewResult Database Persistence", () => {
    it("returns null if installationId is missing", async () => {
      const result = await recordReviewResult({
        installationId: 0,
        repo: "owner/repo",
        prNumber: 1,
        headSha: "abc1234",
        status: "completed",
        commentsPosted: 0,
      });
      expect(result).toBeNull();
    });

    it("inserts review record and associated comment records with 'open' outcome", async () => {
      const executedQueries: string[] = [];
      const queryParams: any[][] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedQueries.push(sql);
        queryParams.push(params || []);

        if (sql.includes("INSERT INTO reviews")) {
          return {
            rows: [{ id: 42 }],
            rowCount: 1,
            command: "",
            oid: 0,
            fields: [],
          };
        }

        return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] };
      });

      const reviewId = await recordReviewResult({
        installationId: 100,
        repo: "acme/api",
        prNumber: 15,
        headSha: "head_commit_sha_1234",
        status: "completed",
        commentsPosted: 2,
        durationMs: 1450,
        comments: [
          {
            file: "src/auth.ts",
            line: 45,
            severity: "critical",
            comment: "Hardcoded secret key found.",
            rule_title: "No Hardcoded Secrets or Credentials",
            githubCommentId: 987654,
          },
          {
            file: "src/utils.ts",
            line: 12,
            severity: "medium",
            comment: "Missing timeout parameter.",
            rule_title: "Network Requests Must Have Timeouts",
            githubCommentId: 987655,
          },
        ],
      });

      expect(reviewId).toBe(42);

      // Verify installation upsert
      expect(executedQueries.some((q) => q.includes("INSERT INTO installations"))).toBe(true);

      // Verify review insertion
      const reviewQuery = executedQueries.find((q) => q.includes("INSERT INTO reviews"));
      expect(reviewQuery).toBeDefined();

      // Verify comment insertions
      const commentQueries = executedQueries.filter((q) => q.includes("INSERT INTO comments"));
      expect(commentQueries).toHaveLength(2);
      expect(commentQueries[0]).toContain("'open'"); // Default outcome is open
    });

    it("records error status and message when review fails", async () => {
      const executedQueries: string[] = [];
      const queryParams: any[][] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedQueries.push(sql);
        queryParams.push(params || []);
        if (sql.includes("INSERT INTO reviews")) {
          return { rows: [{ id: 43 }], rowCount: 1, command: "", oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] };
      });

      const reviewId = await recordReviewResult({
        installationId: 100,
        repo: "acme/api",
        prNumber: 15,
        headSha: "head_sha",
        status: "rate_limited",
        commentsPosted: 0,
        error: "429 Resource has been exhausted (rate limit)",
        durationMs: 320,
      });

      expect(reviewId).toBe(43);
      const reviewParams = queryParams.find((p) => p.includes("rate_limited"));
      expect(reviewParams).toBeDefined();
      expect(reviewParams).toContain("429 Resource has been exhausted (rate limit)");
    });
  });
});
