import type { Redis } from "ioredis";

export interface IdempotencyParams {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

/**
 * Pure function to construct a consistent, normalized Redis lock key.
 */
export function buildIdempotencyKey(params: IdempotencyParams): string {
  const { owner, repo, pullNumber, headSha } = params;
  return `pr-review-lock:${owner.toLowerCase()}:${repo.toLowerCase()}:${pullNumber}:${headSha}`;
}

/**
 * Attempts to acquire an atomic distributed lock in Redis using SET ... NX EX.
 * Returns true if lock was acquired (first request), or false if it already exists (duplicate).
 */
export async function acquireReviewLock(
  redis: Redis,
  params: IdempotencyParams,
  ttlSeconds: number = 300
): Promise<boolean> {
  const key = buildIdempotencyKey(params);
  const result = await redis.set(key, "locked", "EX", ttlSeconds, "NX");
  return result === "OK";
}

/**
 * Manually releases an idempotency lock if needed (e.g. on unrecoverable retry error).
 */
export async function releaseReviewLock(
  redis: Redis,
  params: IdempotencyParams
): Promise<void> {
  const key = buildIdempotencyKey(params);
  await redis.del(key);
}

