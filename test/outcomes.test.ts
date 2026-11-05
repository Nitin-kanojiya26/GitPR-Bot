import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  markThreadResolved,
  markThreadUnresolved,
  markUnresolvedCommentsIgnored,
  getOutcomeStats,
} from "../src/review/outcomes.js";
import * as db from "../src/db/client.js";

describe("PR Review Outcome Tracking (fixed vs ignored)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("markThreadResolved", () => {
    it("returns 0 immediately if commentIds array is empty", async () => {
      const updated = await markThreadResolved([]);
      expect(updated).toBe(0);
    });

    it("executes update query setting outcome to 'fixed' for matching comment IDs", async () => {
      let executedQuery = "";
      let queryParams: any[] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedQuery = sql;
        queryParams = params || [];
        return { rows: [], rowCount: 2, command: "", oid: 0, fields: [] };
      });

      const updated = await markThreadResolved([111, 222]);

      expect(updated).toBe(2);
      expect(executedQuery).toContain("outcome = 'fixed'");
      expect(executedQuery).toContain("outcome = 'open'");
      expect(queryParams[0]).toEqual([111, 222]);
    });
  });

  describe("markThreadUnresolved", () => {
    it("returns 0 if commentIds array is empty", async () => {
      const updated = await markThreadUnresolved([]);
      expect(updated).toBe(0);
    });

    it("reverts 'fixed' comments back to 'open' and clears outcome_at", async () => {
      let executedQuery = "";
      let queryParams: any[] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedQuery = sql;
        queryParams = params || [];
        return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] };
      });

      const updated = await markThreadUnresolved([111]);

      expect(updated).toBe(1);
      expect(executedQuery).toContain("outcome = 'open'");
      expect(executedQuery).toContain("outcome_at = NULL");
      expect(queryParams[0]).toEqual([111]);
    });
  });

  describe("markUnresolvedCommentsIgnored", () => {
    it("returns 0 if repo or prNumber are missing", async () => {
      expect(await markUnresolvedCommentsIgnored("", 10)).toBe(0);
      expect(await markUnresolvedCommentsIgnored("owner/repo", 0)).toBe(0);
    });

    it("marks only remaining 'open' comments as 'ignored' upon PR close", async () => {
      let executedQuery = "";
      let queryParams: any[] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedQuery = sql;
        queryParams = params || [];
        return { rows: [], rowCount: 3, command: "", oid: 0, fields: [] };
      });

      const updated = await markUnresolvedCommentsIgnored("acme/web", 42);

      expect(updated).toBe(3);
      expect(executedQuery).toContain("outcome = 'ignored'");
      expect(executedQuery).toContain("outcome = 'open'"); // Ensures fixed comments are NOT overwritten
      expect(queryParams).toEqual(["acme/web", 42]);
    });
  });

  describe("getOutcomeStats Rate Calculations", () => {
    it("returns zeros when installations list is empty", async () => {
      const stats = await getOutcomeStats([]);
      expect(stats.fixedCount).toBe(0);
      expect(stats.ignoredCount).toBe(0);
      expect(stats.fixedRatePercent).toBe(0);
      expect(stats.ignoredRatePercent).toBe(0);
    });

    it("handles zero decided comments without division by zero NaN", async () => {
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [{ fixed_count: "0", ignored_count: "0", open_count: "5" }],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      });

      const stats = await getOutcomeStats([100]);

      expect(stats.openCount).toBe(5);
      expect(stats.fixedCount).toBe(0);
      expect(stats.ignoredCount).toBe(0);
      expect(stats.fixedRatePercent).toBe(0);
      expect(stats.ignoredRatePercent).toBe(0);
    });

    it("accurately calculates fixed vs ignored rates", async () => {
      // 3 fixed, 1 ignored out of 4 decided comments -> 75% fixed, 25% ignored
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [{ fixed_count: "3", ignored_count: "1", open_count: "2" }],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      });

      const stats = await getOutcomeStats([100]);

      expect(stats.fixedCount).toBe(3);
      expect(stats.ignoredCount).toBe(1);
      expect(stats.openCount).toBe(2);
      expect(stats.fixedRatePercent).toBe(75);
      expect(stats.ignoredRatePercent).toBe(25);
    });
  });
});
