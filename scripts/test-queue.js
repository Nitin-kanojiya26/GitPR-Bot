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

async function testQueue() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
  console.log(`[INFO] Testing Redis connection on ${redisUrl}...`);
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // Do not hang if connection fails
    connectTimeout: 3000,
  });

  try {
    const pong = await redis.ping();
    console.log(`[INFO] Redis is online! Ping response: ${pong}`);

    const { reviewQueue } = await import("../lib/queue/reviewQueue.js");

    // Add a sample review job
    const job = await reviewQueue.add("test-review-job", {
      owner: "test-owner",
      repo: "test-repo",
      pullNumber: 999,
      headSha: "1234567890abcdef",
    });

    console.log(`[INFO] Job enqueued successfully with ID: ${job.id}`);
    const state = await job.getState();
    console.log(`[INFO] Job state in queue: ${state}`);

    await job.remove();
    console.log("[INFO] Test job cleaned up.");
    console.log("\n[SUCCESS] BullMQ & Redis queue integration verified!");

    await reviewQueue.close();
    process.exit(0);
  } catch (error) {
    console.error("[ERROR] Redis connection failed:", error.message);
    console.log("\n[ACTION REQUIRED] Start Redis in Docker with this command:");
    console.log("docker run -d --name redis -p 6379:6379 redis:7-alpine");
  } finally {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }
}

testQueue().catch(console.error);
