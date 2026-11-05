import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordWebhookDelivery,
  cleanOldWebhookDeliveries,
  checkInstallationHourlyCap,
  isCommitAlreadyReviewed,
  HOURLY_REVIEW_LIMIT,
} from "../src/queue/delivery.js";
import {
  MAX_FILES_PER_PR,
  MAX_TOTAL_DIFF_CHARS,
} from "../src/review/reviewPR.js";
import * as db from "../src/db/client.js";

describe("Limits, Idempotency & Reliability Defenses", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Webhook Delivery Deduplication", () => {
    it("permits processing if delivery ID is missing", async () => {
      const allowed = await recordWebhookDelivery("");
      expect(allowed).toBe(true);
    });

    it("records fresh delivery ID and allows first delivery", async () => {
      let executedQuery = "";
      let queryParams: any[] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedQuery = sql;
        queryParams = params || [];
        return { rows: [], rowCount: 1, command: "", oid: 0, fields: [] };
      });

      const isNew = await recordWebhookDelivery("delivery-guid-1234");
      expect(isNew).toBe(true);
      expect(executedQuery).toContain("INSERT INTO webhook_deliveries");
      expect(queryParams[0]).toBe("delivery-guid-1234");
    });

    it("detects and rejects duplicate delivery IDs (rowCount = 0 on conflict)", async () => {
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [],
        rowCount: 0, // Conflict duplicate
        command: "",
        oid: 0,
        fields: [],
      });

      const isNew = await recordWebhookDelivery("delivery-guid-duplicate");
      expect(isNew).toBe(false);
    });

    it("cleans up webhook deliveries older than 24 hours", async () => {
      let executedQuery = "";

      vi.spyOn(db, "query").mockImplementation(async (sql: string) => {
        executedQuery = sql;
        return { rows: [], rowCount: 45, command: "", oid: 0, fields: [] };
      });

      const deletedCount = await cleanOldWebhookDeliveries();
      expect(deletedCount).toBe(45);
      expect(executedQuery).toContain("received_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'");
    });
  });

  describe("Per-Installation Hourly Review Cap", () => {
    it("allows review when under the hourly limit of 20", async () => {
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [{ count: "7" }],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      });

      const check = await checkInstallationHourlyCap(100);
      expect(check.allowed).toBe(true);
      expect(check.currentCount).toBe(7);
    });

    it("blocks review when hourly limit is reached or exceeded", async () => {
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [{ count: "20" }],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      });

      const check = await checkInstallationHourlyCap(100);
      expect(check.allowed).toBe(false);
      expect(check.currentCount).toBe(HOURLY_REVIEW_LIMIT);
    });
  });

  describe("Commit SHA Deduplication", () => {
    it("returns false if repo, prNumber, or headSha are missing", async () => {
      expect(await isCommitAlreadyReviewed("", 1, "sha")).toBe(false);
      expect(await isCommitAlreadyReviewed("repo", 0, "sha")).toBe(false);
      expect(await isCommitAlreadyReviewed("repo", 1, "")).toBe(false);
    });

    it("identifies already reviewed commit SHAs", async () => {
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [{ "?column?": 1 }],
        rowCount: 1,
        command: "",
        oid: 0,
        fields: [],
      });

      const alreadyReviewed = await isCommitAlreadyReviewed("owner/repo", 5, "head_sha_123");
      expect(alreadyReviewed).toBe(true);
    });

    it("returns false when commit has not yet completed a review", async () => {
      vi.spyOn(db, "query").mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: "",
        oid: 0,
        fields: [],
      });

      const alreadyReviewed = await isCommitAlreadyReviewed("owner/repo", 5, "head_sha_fresh");
      expect(alreadyReviewed).toBe(false);
    });
  });

  describe("Review Size & File Caps", () => {
    it("has protective limits defined for files and diff character volume", () => {
      expect(MAX_FILES_PER_PR).toBe(25);
      expect(MAX_TOTAL_DIFF_CHARS).toBe(100_000);
    });
  });
});
