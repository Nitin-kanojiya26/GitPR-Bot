export interface ChangedFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
}

export const IGNORED_FILENAMES = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
]);

export const IGNORED_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".webp",
    ".pdf",
    ".woff",
    ".woff2",
    ".ttf",
]);

export const MAX_DIFF_LINES = 800;

/**
 * Determines whether a file should be reviewed by the AI bot.
 * Returns { review: true } or { review: false, reason: string }.
 */
export function shouldReviewFile(file: ChangedFile): { review: boolean; reason?: string } {
    // 1. Must have a valid patch
    if (!file.patch) {
        return { review: false, reason: "No patch available (binary, deleted, or unchanged file)" };
    }

    // 2. Ignore lockfiles
    const basename = file.filename.split("/").pop() || "";
    if (IGNORED_FILENAMES.has(basename)) {
        return { review: false, reason: "Lockfile ignored" };
    }

    // 3. Ignore compiled / build artifacts
    if (
        file.filename.startsWith("dist/") ||
        file.filename.includes("/dist/") ||
        file.filename.startsWith("lib/") ||
        file.filename.includes("/lib/") ||
        file.filename.startsWith("build/") ||
        file.filename.includes("/build/") ||
        file.filename.includes("node_modules/")
    ) {
        return { review: false, reason: "Build or compiled output ignored" };
    }

    // 4. Ignore minified assets
    if (file.filename.endsWith(".min.js") || file.filename.endsWith(".min.css")) {
        return { review: false, reason: "Minified file ignored" };
    }

    // 5. Ignore media / image extensions
    const dotIndex = file.filename.lastIndexOf(".");
    if (dotIndex !== -1) {
        const ext = file.filename.slice(dotIndex).toLowerCase();
        if (IGNORED_EXTENSIONS.has(ext)) {
            return { review: false, reason: "Media or binary file ignored" };
        }
    }

    // 6. Size cap: avoid reviewing gigantic generated diffs (> 800 lines)
    const totalChangedLines = file.additions + file.deletions;
    if (totalChangedLines > MAX_DIFF_LINES) {
        return {
            review: false,
            reason: `Diff too large (${totalChangedLines} lines exceeds ${MAX_DIFF_LINES} line cap)`,
        };
    }

    return { review: true };
}