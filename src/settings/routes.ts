import { Router, Request, Response } from "express";
import { ensureAuthenticated } from "../web/auth.js";
import {
  getInstallationSettings,
  saveInstallationKey,
  deleteInstallationKey,
} from "./service.js";
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

  // If settings record does not exist yet, supply default view object
  if (!settings) {
    const instRes = await query(
      "SELECT account_login, account_type FROM installations WHERE installation_id = $1",
      [requestedId]
    );
    settings = {
      installation_id: requestedId,
      last4: null,
      guide_md: "",
      guide_version: 1,
      index_status: "not_configured",
      account_login: instRes.rows[0]?.account_login || `Installation #${requestedId}`,
      account_type: instRes.rows[0]?.account_type || "User",
      updated_at: new Date(),
    };
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
