import { describe, it, expect } from "vitest";
import {
  parseGuideMarkdown,
  getDefaultGuideMarkdown,
} from "../src/installations/service.js";

describe("Installation Guide Service", () => {
  it("loads the default guide markdown with rules", () => {
    const md = getDefaultGuideMarkdown();
    expect(md).toBeDefined();
    expect(md.length).toBeGreaterThan(100);
    expect(md).toContain("## ");
  });

  it("parses valid markdown into discrete rules", () => {
    const sampleMd = `
# Engineering Guidelines

## 1. Explicit Timeouts
Always specify an AbortSignal timeout for fetch requests.

## 2. No Eval
Never use dynamic script execution.
`;

    const rules = parseGuideMarkdown(sampleMd);
    expect(rules).toHaveLength(2);
    expect(rules[0].title).toBe("1. Explicit Timeouts");
    expect(rules[0].content).toContain("Always specify an AbortSignal timeout");
    expect(rules[1].title).toBe("2. No Eval");
    expect(rules[1].content).toContain("Never use dynamic script execution");
  });

  it("enforces length cap of 20,000 characters", () => {
    const hugeMd = "# Title\n\n## Big Rule\n" + "A".repeat(20005);
    expect(() => parseGuideMarkdown(hugeMd)).toThrow("exceeds maximum allowed length");
  });

  it("caps rule count at maximum 30 rules", () => {
    let manyRules = "# Many Rules\n";
    for (let i = 1; i <= 35; i++) {
      manyRules += `\n## Rule ${i}\nDescription for rule ${i}\n`;
    }

    const parsed = parseGuideMarkdown(manyRules);
    expect(parsed).toHaveLength(30);
    expect(parsed[29].title).toBe("Rule 30");
  });
});
