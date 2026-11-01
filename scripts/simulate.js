const fs = require("fs");
const crypto = require("crypto");

// 1. Read .env file manually if not already in process.env
if (fs.existsSync(".env")) {
  const envContent = fs.readFileSync(".env", "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim();
    if (key && !process.env[key.trim()]) {
      process.env[key.trim()] = value;
    }
  }
}

const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error("WEBHOOK_SECRET is not defined in your .env file!");
  process.exit(1);
}

// 2. Read the test fixture
const fixturePath = "./test/fixtures/pr-opened.json";
if (!fs.existsSync(fixturePath)) {
  console.error(`Fixture not found at ${fixturePath}`);
  process.exit(1);
}

const payload = fs.readFileSync(fixturePath, "utf8");

// 3. Compute the cryptographic HMAC-SHA256 signature
const signature =
  "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");

console.log("Replaying pr-opened.json to http://localhost:3000/api/github/webhooks...");

async function sendWebhook() {
  try {
    const response = await fetch("http://localhost:3000/api/github/webhooks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": crypto.randomUUID(),
        "X-Hub-Signature-256": signature,
      },
      body: payload,
    });

    if (response.ok) {
      console.log(`Webhook delivered successfully! (Status: ${response.status})`);
      console.log("Check your bot terminal to see the PR review processing!");
    } else {
      const errorText = await response.text();
      console.error(`Server returned ${response.status}: ${errorText}`);
    }
  } catch (err) {
    console.error("Could not connect to http://localhost:3000. Is `npm start` running in another terminal?");
  }
}

sendWebhook();

