const fs = require("fs");

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

async function testHealth() {
  console.log("[INFO] Probing live healthcheck (/healthz) dependencies...");

  const { checkHealth } = await import("../lib/health.js");

  const health = await checkHealth();
  console.log("[INFO] Healthcheck Report:\n" + JSON.stringify(health, null, 2));

  if (health.status === "ok") {
    console.log(
      `\n[SUCCESS] Healthcheck PASSED (HTTP 200). Database (${health.services.database.latencyMs}ms) and Redis (${health.services.redis.latencyMs}ms) are both healthy!`
    );
    process.exit(0);
  } else {
    console.error(
      `\n[ERROR] Healthcheck failed with status: ${health.status.toUpperCase()} (HTTP 503).`
    );
    process.exit(1);
  }
}

testHealth().catch((err) => {
  console.error("[ERROR] Healthcheck probe crashed:", err);
  process.exit(1);
});

