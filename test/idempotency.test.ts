import { describe, it, expect } from "vitest";
import {
  buildIdempotencyKey,
  acquireReviewLock,
  releaseReviewLock,
} from "../src/queue/idempotency.js";

describe("Idempotency & Deduplication", () => {
  it("buildIdempotencyKey generates normalized lowercase keys", () => {
    const key1 = buildIdempotencyKey({
      owner: "MyOrg",
      repo: "MyRepo",
      pullNumber: 42,
      headSha: "abcdef123456",
    });

    const key2 = buildIdempotencyKey({
      owner: "myorg",
      repo: "myrepo",
      pullNumber: 42,
      headSha: "abcdef123456",
    });

    expect(key1).toBe("pr-review-lock:myorg:myrepo:42:abcdef123456");
    expect(key1).toBe(key2);
  });

  it("buildIdempotencyKey distinguishes different commits on the same PR", () => {
    const keyCommit1 = buildIdempotencyKey({
      owner: "owner",
      repo: "repo",
      pullNumber: 1,
      headSha: "sha1111",
    });

    const keyCommit2 = buildIdempotencyKey({
      owner: "owner",
      repo: "repo",
      pullNumber: 1,
      headSha: "sha2222",
    });

    expect(keyCommit1).not.toBe(keyCommit2);
  });

  it("acquireReviewLock grants lock on first attempt and blocks duplicate attempts", async () => {
    const store = new Map<string, string>();

    // Mock Redis client implementing SET ... NX EX
    const mockRedis: any = {
      set: async (key: string, value: string, _ex: string, _ttl: number, mode?: string) => {
        if (mode === "NX" && store.has(key)) {
          return null;
        }
        store.set(key, value);
        return "OK";
      },
      del: async (key: string) => {
        store.delete(key);
        return 1;
      },
    };

    const params = {
      owner: "acme",
      repo: "app",
      pullNumber: 10,
      headSha: "commit-sha-abc",
    };

    // First attempt -> should succeed
    const firstAttempt = await acquireReviewLock(mockRedis, params);
    expect(firstAttempt).toBe(true);

    // Duplicate attempt for the same commit -> should be blocked
    const duplicateAttempt = await acquireReviewLock(mockRedis, params);
    expect(duplicateAttempt).toBe(false);

    // After release -> should be able to acquire again
    await releaseReviewLock(mockRedis, params);
    const reacquired = await acquireReviewLock(mockRedis, params);
    expect(reacquired).toBe(true);
  });
});

