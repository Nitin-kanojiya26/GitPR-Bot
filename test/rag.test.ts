import { describe, it, expect } from "vitest";
import { formatRulesForPrompt, retrieveRules, RetrievedRule } from "../src/review/rag.js";

describe("RAG Rule Formatting", () => {
  it("returns empty string when given empty list or null", () => {
    expect(formatRulesForPrompt([])).toBe("");
    expect(formatRulesForPrompt(null as any)).toBe("");
  });

  it("formats single rule into prompt markdown", () => {
    const rules: RetrievedRule[] = [
      {
        title: "1. Network Requests Must Have Timeouts",
        content: "Always specify AbortSignal.timeout().",
        similarity: 0.88,
      },
    ];

    const output = formatRulesForPrompt(rules);
    expect(output).toContain("RELEVANT TEAM STYLE GUIDE RULES");
    expect(output).toContain("[Rule 1] 1. Network Requests Must Have Timeouts");
    expect(output).toContain("Always specify AbortSignal.timeout().");
  });

  it("formats multiple rules in ranked order", () => {
    const rules: RetrievedRule[] = [
      {
        title: "Rule A",
        content: "Content A",
        similarity: 0.95,
      },
      {
        title: "Rule B",
        content: "Content B",
        similarity: 0.82,
      },
    ];

    const output = formatRulesForPrompt(rules);
    expect(output).toContain("[Rule 1] Rule A");
    expect(output).toContain("[Rule 2] Rule B");
    expect(output.indexOf("[Rule 1]")).toBeLessThan(output.indexOf("[Rule 2]"));
  });

  it("retrieveRules handles empty query gracefully", async () => {
    const results = await retrieveRules("");
    expect(results).toEqual([]);
  });
});

