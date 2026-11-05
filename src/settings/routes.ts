import { Router, Request, Response } from "express";
import { ensureAuthenticated } from "../web/auth.js";
import {
  getInstallationSettings,
  saveInstallationKey,
  deleteInstallationKey,
} from "./service.js";
import { syncInstallationRules, getDefaultGuideMarkdown } from "../installations/service.js";
import { query } from "../db/client.js";

export const settingsRouter = Router();

// In-memory rate limiting map for key verification: IP_userId -> timestamps[]
const keyRateLimits = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_KEY_CHECKS = 5;

/**
 * Checks whether an IP or user has exceeded the key-test rate limit.
 */
export function isKeyRateLimited(identifier: string): boolean {
  const now = Date.now();
  const timestamps = (keyRateLimits.get(identifier) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );

  if (timestamps.length >= MAX_KEY_CHECKS) {
    return true;
  }

  timestamps.push(now);
  keyRateLimits.set(identifier, timestamps);
  return false;
}

/**
 * Reset rate limit entries (useful for testing).
 */
export function resetRateLimits(): void {
  keyRateLimits.clear();
}

/**
 * GET /settings
 * Displays settings for one of the user's authorized installations.
 */
settingsRouter.get("/", ensureAuthenticated, async (req: Request, res: Response) => {
  const userInstallations = (req.session.installations || []).map(Number);

  if (userInstallations.length === 0) {
    return res.render("settings", {
      title: "Settings - GitPR",
      noInstallations: true,
      selectedInstallationId: null,
      settings: null,
      installations: [],
      success: req.query.success || null,
      error: req.query.error || null,
    });
  }

  // Requested installation id, or default to the first one in the user's authorized list
  const requestedId = req.query.installation_id
    ? Number(req.query.installation_id)
    : userInstallations[0];

  // Multi-tenant authorization guard: Never trust query param without verifying session ownership
  if (!userInstallations.includes(requestedId)) {
    return res.status(403).render("settings", {
      title: "Access Denied - GitPR",
      noInstallations: false,
      selectedInstallationId: null,
      settings: null,
      installations: [],
      success: null,
      error: "You are not authorized to manage this installation.",
    });
  }

  // Fetch installation settings
  let settings = await getInstallationSettings(requestedId);

  // If settings record does not exist yet, supply default view object and ensure installation row exists
  if (!settings) {
    const defaultGuide = getDefaultGuideMarkdown();

    // Ensure installation exists in installations table
    await query(
      `INSERT INTO installations (installation_id, account_login, account_type)
       VALUES ($1, $2, 'User')
       ON CONFLICT (installation_id) DO NOTHING;`,
      [requestedId, req.session.user?.login || `Installation #${requestedId}`]
    );

    // Ensure initial installation_settings record exists
    await query(
      `INSERT INTO installation_settings (installation_id, guide_md, index_status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (installation_id) DO NOTHING;`,
      [requestedId, defaultGuide]
    );

    const instRes = await query(
      "SELECT account_login, account_type FROM installations WHERE installation_id = $1",
      [requestedId]
    );
    settings = {
      installation_id: requestedId,
      last4: null,
      guide_md: defaultGuide,
      guide_version: 1,
      index_status: "not_configured",
      account_login: instRes.rows[0]?.account_login || req.session.user?.login || `Installation #${requestedId}`,
      account_type: instRes.rows[0]?.account_type || "User",
      updated_at: new Date(),
    };
  } else if (!settings.guide_md) {
    settings.guide_md = getDefaultGuideMarkdown();
  }

  // Retrieve logins for all authorized installations for the dropdown switcher
  const allInstRes = await query(
    "SELECT installation_id, account_login FROM installations WHERE installation_id = ANY($1::bigint[])",
    [userInstallations]
  );
  const installationsList =
    allInstRes.rows.length > 0
      ? allInstRes.rows
      : userInstallations.map((id) => ({
          installation_id: id,
          account_login: `Installation #${id}`,
        }));

  res.render("settings", {
    title: "Settings - GitPR",
    noInstallations: false,
    selectedInstallationId: requestedId,
    settings,
    installations: installationsList,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

/**
 * POST /settings/key
 * Validates, encrypts with AES-256-GCM, and stores the user's Gemini API key.
 */
settingsRouter.post("/key", ensureAuthenticated, async (req: Request, res: Response) => {
  const userInstallations = (req.session.installations || []).map(Number);
  const installationId = Number(req.body.installation_id);
  const apiKey = (req.body.api_key || "").trim();

  // Multi-tenant check
  if (!installationId || !userInstallations.includes(installationId)) {
    return res.status(403).send("Forbidden: Invalid or unauthorized installation ID.");
  }

  // Rate limit key testing attempts
  const rateLimitKey = `${req.ip}_${req.session.user?.id || "user"}`;
  if (isKeyRateLimited(rateLimitKey)) {
    return res.redirect(
      `/settings?installation_id=${installationId}&error=${encodeURIComponent(
        "Too many key verification attempts. Please wait 10 minutes before retrying."
      )}`
    );
  }

  if (!apiKey || apiKey.length < 15) {
    return res.redirect(
      `/settings?installation_id=${installationId}&error=${encodeURIComponent(
        "Please provide a valid Gemini API key (at least 15 characters)."
      )}`
    );
  }

  const result = await saveInstallationKey(installationId, apiKey);
  if (!result.success) {
    return res.redirect(
      `/settings?installation_id=${installationId}&error=${encodeURIComponent(
        result.error || "Key validation failed."
      )}`
    );
  }

  res.redirect(
    `/settings?installation_id=${installationId}&success=${encodeURIComponent(
      "Gemini API key successfully verified and stored with AES-256-GCM encryption."
    )}`
  );
});

/**
 * Common handler for deleting an installation key.
 */
async function handleDeleteKey(req: Request, res: Response) {
  const userInstallations = (req.session.installations || []).map(Number);
  const installationId = Number(req.body.installation_id || req.query.installation_id);

  if (!installationId || !userInstallations.includes(installationId)) {
    return res.status(403).send("Forbidden: Invalid or unauthorized installation ID.");
  }

  await deleteInstallationKey(installationId);
  res.redirect(
    `/settings?installation_id=${installationId}&success=${encodeURIComponent(
      "API key removed. GitPR will pause automated reviews until a new key is added."
    )}`
  );
}

settingsRouter.post("/key/delete", ensureAuthenticated, handleDeleteKey);
settingsRouter.delete("/key", ensureAuthenticated, handleDeleteKey);

/**
 * Common handler for updating and re-indexing the style guide markdown.
 * Supports both PUT /settings/guide (REST/AJAX) and POST /settings/guide (HTML form submission).
 */
export async function handleUpdateGuide(req: Request, res: Response) {
  const userInstallations = (req.session.installations || []).map(Number);
  const installationId = Number(req.body.installation_id);
  const guideMd = typeof req.body.guide_md === "string" ? req.body.guide_md : "";
  const isJson = req.xhr || req.headers["accept"]?.includes("json") || req.is("json");

  // Multi-tenant authorization check
  if (!installationId || !userInstallations.includes(installationId)) {
    if (isJson) {
      return res.status(403).json({ error: "Forbidden: Unauthorized installation ID." });
    }
    return res.status(403).send("Forbidden: Invalid or unauthorized installation ID.");
  }

  // Length validation: max 20,000 characters
  if (guideMd.length > 20000) {
    const errorMsg = `Style guide exceeds maximum allowed limit of 20,000 characters (current: ${guideMd.length}).`;
    if (isJson) {
      return res.status(400).json({ success: false, error: errorMsg });
    }
    return res.redirect(
      `/settings?installation_id=${installationId}&error=${encodeURIComponent(errorMsg)}`
    );
  }

  try {
    const result = await syncInstallationRules(installationId, guideMd);

    if (isJson) {
      return res.json({
        success: true,
        ruleCount: result.ruleCount,
        index_status: "indexed",
      });
    }

    return res.redirect(
      `/settings?installation_id=${installationId}&success=${encodeURIComponent(
        `Review guide updated successfully! ${result.ruleCount} rule(s) embedded into pgvector.`
      )}`
    );
  } catch (err: any) {
    const errorMsg = err?.message || "Failed to update and index review guide.";
    if (isJson) {
      return res.status(400).json({ success: false, error: errorMsg });
    }
    return res.redirect(
      `/settings?installation_id=${installationId}&error=${encodeURIComponent(errorMsg)}`
    );
  }
}

settingsRouter.post("/guide", ensureAuthenticated, handleUpdateGuide);
settingsRouter.put("/guide", ensureAuthenticated, handleUpdateGuide);

