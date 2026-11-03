const fs = require("fs");
const path = require("path");

// Load .env manually if needed
if (fs.existsSync(".env")) {
  const envContent = fs.readFileSync(".env", "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...v] = trimmed.split("=");
    if (key && !process.env[key.trim()]) process.env[key.trim()] = v.join("=").trim();
  }
}

async function runEvaluation() {
  console.log("[INFO] Starting RAG Retrieval Evaluation (Hit Rate @ 3)...");

  const { retrieveRules } = await import("../lib/review/rag.js");

  const casesPath = path.resolve("./evals/cases.json");
  if (!fs.existsSync(casesPath)) {
    console.error("[ERROR] Test cases file not found at " + casesPath);
    process.exit(1);
  }

  const raw = fs.readFileSync(casesPath, "utf8");
  const testCases = JSON.parse(raw);
  console.log(`[INFO] Loaded ${testCases.length} evaluation test cases.`);

  const results = [];
  let hits = 0;

  for (const testCase of testCases) {
    console.log(`[INFO] Evaluating Case #${testCase.id}: "${testCase.description}"...`);

    const retrieved = await retrieveRules(testCase.diff, 3);

    let hitRank = null;
    let matchedTitle = null;

    for (let i = 0; i < retrieved.length; i++) {
      const candidate = retrieved[i].title.toLowerCase();
      const target = testCase.expectedRule.toLowerCase();

      // Check substring match
      if (candidate.includes(target) || target.includes(candidate)) {
        hitRank = i + 1;
        matchedTitle = retrieved[i].title;
        break;
      }
    }

    const isHit = hitRank !== null;
    if (isHit) {
      hits++;
    }

    results.push({
      id: testCase.id,
      description: testCase.description,
      expected: testCase.expectedRule,
      matchedTitle: matchedTitle ?? (retrieved[0]?.title || "None"),
      rank: hitRank,
      isHit,
    });
  }

  // Print Evaluation Results Table
  console.log("\n================================================================================");
  console.log("RAG RETRIEVAL EVALUATION RESULTS (Hit Rate @ 3)");
  console.log("================================================================================");
  console.log("ID | Result | Rank | Expected Rule                                          ");
  console.log("---+--------+------+--------------------------------------------------------");

  for (const r of results) {
    const status = r.isHit ? "HIT " : "MISS";
    const rankStr = r.rank ? `#${r.rank} ` : "-   ";
    const truncatedExpected = r.expected.slice(0, 55).padEnd(55, " ");
    console.log(`${String(r.id).padStart(2, " ")} | ${status}   | ${rankStr} | ${truncatedExpected}`);
  }

  const hitRate = (hits / testCases.length) * 100;
  console.log("================================================================================");
  console.log(`[SUMMARY] Total Cases: ${testCases.length}`);
  console.log(`[SUMMARY] Total Hits:  ${hits}`);
  console.log(`[SUMMARY] Hit Rate @ 3: ${hitRate.toFixed(1)}%`);

  if (hitRate >= 80) {
    console.log("\n[SUCCESS] RAG Evaluation PASSED (Hit Rate >= 80%).");
  } else {
    console.log("\n[WARN] RAG Evaluation below target (Hit Rate < 80%).");
  }
}

runEvaluation().catch((err) => {
  console.error("[ERROR] Evaluation failed:", err);
  process.exit(1);
});

