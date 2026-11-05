import { describe, it, expect } from "vitest";
import { extractRuleFromComment } from "../src/review/learner.js";

describe("Shadowing Engine / Learner", () => {
  it("immediately returns isRule: false for short or trivial comments", async () => {
    const result1 = await extractRuleFromComment("");
    expect(result1.isRule).toBe(false);

    const result2 = await extractRuleFromComment("LGTM!");
    expect(result2.isRule).toBe(false);

    const result3 = await extractRuleFromComment("nice catch");
    expect(result3.isRule).toBe(false);
  });
});

