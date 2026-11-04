const fs = require("fs");
const Redis = require("ioredis");

// Load .env manually
if (fs.existsSync(".env")) {
  const envContent = fs.readFileSync(".env", "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...v] = trimmed.split("=");
    if (key && !process.env[key.trim()]) process.env[key.trim()] = v.join("=").trim();
  }
}

async function testIdempotency() {
  console.log("[INFO] Testing live Redis Idempotency & Deduplication...");

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  const {
    acquireReviewLock,
    releaseReviewLock,
    buildIdempotencyKey,
  } = await import("../lib/queue/idempotency.js");

  const samplePR = {
    owner: "demo-user",
    repo: "demo-repo",
    pullNumber: 42,
    headSha: "abcdef9876543210",
  };

  try {
    const lockKey = buildIdempotencyKey(samplePR);
    console.log(`[INFO] Idempotency lock key: ${lockKey}`);

    // Ensure clean initial state
    await releaseReviewLock(redis, samplePR);

    // 1. First event arrives
    console.log("[INFO] Simulating First Event (PR opened)...");
    const lock1 = await acquireReviewLock(redis, samplePR, 60);
    console.log(`[INFO] Attempt 1 lock acquired: ${lock1}`);
    if (!lock1) {
      throw new Error("Attempt 1 failed to acquire lock on clean state");
    }

    // 2. Duplicate event arrives (e.g. GitHub webhook retry or network glitch)
    console.log("[INFO] Simulating Duplicate Event for the exact same commit...");
    const lock2 = await acquireReviewLock(redis, samplePR, 60);
    console.log(`[INFO] Attempt 2 lock acquired: ${lock2}`);
    if (lock2) {
      throw new Error("Attempt 2 acquired lock when it should have been blocked!");
    }

    // 3. Clean up the lock
    await releaseReviewLock(redis, samplePR);
    console.log("[INFO] Cleaned up idempotency test lock.");

    console.log("\n[SUCCESS] Idempotency verified! Duplicate webhook events are successfully blocked by Redis.");
  } catch (error) {
    console.error("[ERROR] Idempotency test failed:", error.message);
    process.exit(1);
  } finally {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    process.exit(0);
  }
}

testIdempotency().catch(console.error);

