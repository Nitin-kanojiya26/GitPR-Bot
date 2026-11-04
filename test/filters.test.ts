import { describe, it, expect } from "vitest";
import { shouldReviewFile, filterDuplicateComments } from "../src/review/filters.js";

describe("shouldReviewFile", () => {
    it("allows standard source code files with patches", () => {
        const result = shouldReviewFile({
            filename: "src/calc.js",
            status: "modified",
            additions: 10,
            deletions: 2,
            patch: "@@ -1,3 +1,4 @@...",
        });
        expect(result.review).toBe(true);
    });

    it("rejects lockfiles", () => {
        const result = shouldReviewFile({
            filename: "package-lock.json",
            status: "modified",
            additions: 500,
            deletions: 200,
            patch: "...",
        });
        expect(result.review).toBe(false);
        expect(result.reason).toContain("Lockfile");
    });

    it("rejects compiled directories (dist/ and lib/)", () => {
        expect(
            shouldReviewFile({
                filename: "lib/index.js",
                status: "modified",
                additions: 5,
                deletions: 1,
                patch: "...",
            }).review
        ).toBe(false);

        expect(
            shouldReviewFile({
                filename: "dist/bundle.js",
                status: "added",
                additions: 100,
                deletions: 0,
                patch: "...",
            }).review
        ).toBe(false);
    });

    it("rejects minified files", () => {
        const result = shouldReviewFile({
            filename: "assets/app.min.js",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "...",
        });
        expect(result.review).toBe(false);
        expect(result.reason).toContain("Minified");
    });

    it("rejects image files", () => {
        const result = shouldReviewFile({
            filename: "public/logo.png",
            status: "added",
            additions: 0,
            deletions: 0,
            patch: "...",
        });
        expect(result.review).toBe(false);
    });

    it("rejects files without patches", () => {
        const result = shouldReviewFile({
            filename: "src/secret.bin",
            status: "added",
            additions: 0,
            deletions: 0,
            patch: undefined,
        });
        expect(result.review).toBe(false);
    });

    it("rejects files exceeding the 800 line cap", () => {
        const result = shouldReviewFile({
            filename: "src/huge-file.js",
            status: "modified",
            additions: 600,
            deletions: 300,
            patch: "...",
        });
        expect(result.review).toBe(false);
        expect(result.reason).toContain("Diff too large");
    });
});

describe("filterDuplicateComments", () => {
    it("drops comments on files and lines that were already commented on", () => {
        const candidates = [
            { file: "src/calc.js", line: 5, comment: "Bug in mul", severity: "high" as const },
            { file: "src/calc.js", line: 8, comment: "Eval is dangerous", severity: "high" as const },
            { file: "src/utils.js", line: 12, comment: "Missing error handling", severity: "medium" as const },
        ];

        const existing = [
            { path: "src/calc.js", line: 5 },
            { path: "src/calc.js", line: 8 },
        ];

        const filtered = filterDuplicateComments(candidates, existing);
        expect(filtered.length).toBe(1);
        expect(filtered[0].file).toBe("src/utils.js");
        expect(filtered[0].line).toBe(12);
    });

    it("returns all candidates when no comments exist yet", () => {
        const candidates = [
            { file: "src/calc.js", line: 5, comment: "Bug", severity: "high" as const },
        ];

        const filtered = filterDuplicateComments(candidates, []);
        expect(filtered.length).toBe(1);
    });

    it("normalizes path differences like leading ./ or /", () => {
        const candidates = [
            { file: "calc.js", line: 8, comment: "Eval is dangerous", severity: "high" as const },
        ];

        const existing = [
            { path: "./calc.js", line: 8 },
        ];

        const filtered = filterDuplicateComments(candidates, existing);
        expect(filtered.length).toBe(0);
    });
});
