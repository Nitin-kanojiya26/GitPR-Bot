import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

export interface SessionUser {
  id: number;
  login: string;
  avatarUrl?: string;
}

declare module "express-session" {
  interface SessionData {
    user?: SessionUser;
    installations?: number[];
    oauthState?: string;
    returnTo?: string;
  }
}

/**
 * Middleware: Enforces that the user has signed in via GitHub.
 */
export function ensureAuthenticated(req: Request, res: Response, next: NextFunction): void {
  if (req.session && req.session.user) {
    return next();
  }
  const returnTo = req.originalUrl || "/settings";
  res.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

/**
 * Multi-Tenant Security Guard: Ensures the authenticated user actually owns / manages the requested installation.
 * Never trusts an installation_id from the browser alone.
 */
export function ensureInstallationAccess(req: Request, res: Response, next: NextFunction): void {
  const rawId =
    req.params?.installationId ||
    req.query?.installation_id ||
    req.body?.installation_id;

  if (!rawId) {
    res.status(400).json({ error: "Bad Request: installation_id is required." });
    return;
  }

  const requestedId = Number(rawId);
  const userInstallations = req.session.installations || [];

  if (!userInstallations.includes(requestedId)) {
    res.status(403).json({
      error: `Forbidden: You do not have authorization to access installation #${requestedId}.`,
    });
    return;
  }

  next();
}

export const authRouter = Router();

// GET /auth/login - Start GitHub OAuth flow
authRouter.get("/login", (req: Request, res: Response) => {
  const clientId = process.env.CLIENT_ID;
  const returnTo = String(req.query.returnTo || "/dashboard");

  if (!clientId) {
    if (process.env.NODE_ENV !== "production") {
      res.redirect(`/auth/dev-login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    res.status(500).send("CLIENT_ID is not configured in server environment.");
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  req.session.returnTo = returnTo;

  const redirectUri = `${process.env.BASE_URL || ""}/auth/callback`;
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&state=${state}&scope=read:user&redirect_uri=${encodeURIComponent(
    redirectUri
  )}`;

  res.redirect(authUrl);
});

// GET /auth/dev-login - Development mode instant sign-in
authRouter.get("/dev-login", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res.status(403).send("Development login is disabled in production.");
    return;
  }

  let instIds = [5567905];
  try {
    const { query: dbQuery } = await import("../db/client.js");
    const instRes = await dbQuery("SELECT installation_id FROM installations LIMIT 10");
    if (instRes.rows.length > 0) {
      instIds = instRes.rows.map((r: any) => Number(r.installation_id));
    }
  } catch {
    // Fallback to [5567905]
  }

  req.session.user = {
    id: 1,
    login: "local-developer",
  };
  req.session.installations = instIds;

  const returnTo = String(req.query.returnTo || "/dashboard");
  res.redirect(returnTo);
});

// GET /auth/callback - Exchange OAuth code and record session
authRouter.get("/callback", async (req: Request, res: Response) => {
  const { code, state } = req.query;

  // 1. Verify OAuth state to prevent CSRF login attacks
  if (!state || state !== req.session.oauthState) {
    res.status(403).send("Forbidden: Invalid OAuth state parameter.");
    return;
  }
  delete req.session.oauthState;

  if (!code) {
    res.status(400).send("Bad Request: Missing OAuth code from GitHub.");
    return;
  }

  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    res.status(500).send("CLIENT_ID or CLIENT_SECRET is not configured.");
    return;
  }

  try {
    // 2. Exchange code for GitHub access token
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = (await tokenResponse.json()) as any;
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      res.status(401).send(`Authentication failed: ${tokenData.error_description || "No token"}`);
      return;
    }

    // 3. Fetch authenticated user profile
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "GitPR-Bot",
      },
    });
    const userData = (await userRes.json()) as any;

    // 4. Fetch installations the user can administer
    const instRes = await fetch("https://api.github.com/user/installations", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "GitPR-Bot",
        Accept: "application/vnd.github+json",
      },
    });
    const instData = (await instRes.json()) as any;
    const userInstallations: number[] = Array.isArray(instData.installations)
      ? instData.installations.map((i: any) => i.id)
      : [];

    // 5. Store verified user and installation permissions in server session
    req.session.user = {
      id: userData.id,
      login: userData.login,
      avatarUrl: userData.avatar_url,
    };
    req.session.installations = userInstallations;

    const destination = req.session.returnTo || "/settings";
    delete req.session.returnTo;
    res.redirect(destination);
  } catch (err: any) {
    console.error("[ERROR] [AUTH] OAuth callback exchange failed:", err?.message || err);
    res.status(500).send("Internal Server Error during authentication.");
  }
});

// GET /auth/logout - Terminate session
authRouter.get("/logout", (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("[ERROR] Failed to destroy session:", err);
    }
    res.redirect("/");
  });
});
