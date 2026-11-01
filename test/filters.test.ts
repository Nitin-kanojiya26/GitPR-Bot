import { describe, it, expect } from "vitest";
import { shouldReviewFile } from "../src/review/filters.js";

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