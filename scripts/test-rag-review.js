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

async function testRagReview() {
  console.log("[INFO] Testing end-to-end RAG + Gemini Review pipeline...");

  const { retrieveRules, formatRulesForPrompt } = await import("../lib/review/rag.js");
  const { generateReview } = await import("../lib/review/llm.js");

  const sampleDiff = `L1: + async function fetchUserData(userId) {
L2: +   const url = "https://api.example.com/users/" + userId;
L3: +   const response = await fetch(url);
L4: +   const data = await response.json();
L5: +   eval(data.initScript);
L6: +   return data;
L7: + }`;

  console.log("[INFO] Code diff being reviewed:\n" + sampleDiff);

  // 1. Retrieve style rules
  const rules = await retrieveRules(sampleDiff, 3);
  console.log(`[INFO] Retrieved ${rules.length} style rules from pgvector:`);
  rules.forEach((r, i) => console.log(`  ${i + 1}. ${r.title}`));

  const rulesPrompt = formatRulesForPrompt(rules);

  // 2. Ask Gemini to review with the retrieved rules
  console.log("[INFO] Calling Gemini with retrieved rules...");
  const comments = await generateReview(
    [{ filename: "src/users.js", diff: sampleDiff }],
    rulesPrompt
  );

  console.log(`\n[SUCCESS] Gemini returned ${comments.length} comment(s):`);
  comments.forEach((c) => {
    console.log(`- Line ${c.line} [${c.severity.toUpperCase()}]: ${c.comment}`);
  });
}

testRagReview().catch((err) => {
  console.error("[ERROR] Test failed:", err);
  process.exit(1);
});

