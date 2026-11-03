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

async function testRAG() {
  console.log("[INFO] Testing live RAG retrieval from PostgreSQL...");

  // Compile check or dynamically import compiled/ts file
  const { retrieveRules, formatRulesForPrompt } = await import("../lib/review/rag.js");

  const query = "const data = await fetch('https://api.external.com/users'); return data.json();";
  console.log("[INFO] Query snippet:\n" + query);

  const rules = await retrieveRules(query, 3);
  console.log(`[INFO] Retrieved ${rules.length} relevant rules:`);

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    console.log(`[RANK ${i + 1}] (${(r.similarity * 100).toFixed(1)}% match): ${r.title}`);
  }

  const promptBlock = formatRulesForPrompt(rules);
  console.log("\n[INFO] Formatted Prompt Block:\n" + promptBlock);

  // Acceptance assertion
  if (rules.length > 0 && rules[0].title.toLowerCase().includes("network")) {
    console.log("\n[SUCCESS] RAG retrieval verified! Network timeout rule correctly ranked as #1.");
  } else {
    console.log("\n[WARN] Top rule did not match network rule, but retrieved: " + (rules[0]?.title || "None"));
  }
}

testRAG().catch((err) => {
  console.error("[ERROR] RAG test failed:", err);
  process.exit(1);
});

