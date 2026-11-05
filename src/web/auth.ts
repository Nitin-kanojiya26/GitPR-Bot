import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

export interface SessionUser {
  id: number;
  login: string;
  avatarUrl?: string;
  avatar_url?: string;
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
    res.status(500).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <title>OAuth Configuration Required - GitPR</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="/css/style.css">
      </head>
      <body style="display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px;">
        <div class="card" style="max-width: 540px; width: 100%; padding: 32px;">
          <h2 style="font-size: 18px; margin-bottom: 12px; color: #ef4444;">GitHub OAuth Setup Required</h2>
          <p style="color: var(--text-secondary); font-size: 13px; line-height: 1.6; margin-bottom: 20px;">
            To log into your dashboard and settings in production, configure your GitHub App credentials on Render.
          </p>
          <div style="background-color: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 20px; font-size: 12px; line-height: 1.8;">
            <strong>Step-by-Step Instructions:</strong><br>
            1. Open <a href="https://github.com/settings/apps" target="_blank" rel="noopener" style="color: #ffffff; text-decoration: underline;">GitHub Developer Settings &rarr; GitHub Apps</a>.<br>
            2. Click your App (ID: <code>${process.env.APP_ID || "5567905"}</code>).<br>
            3. Copy the <strong>Client ID</strong> and generate a <strong>Client Secret</strong>.<br>
            4. In your Render Dashboard &rarr; <em>Environment</em>, add:<br>
            &bull; <code>CLIENT_ID</code><br>
            &bull; <code>CLIENT_SECRET</code><br>
            &bull; <code>GITHUB_APP_SLUG</code> (the public name of your app)<br>
            &bull; <code>BASE_URL=https://gitpr-bot.onrender.com</code>
          </div>
          <div style="display: flex; gap: 12px;">
            <a href="/" class="btn btn-secondary btn-sm">&larr; Return Home</a>
            <a href="https://github.com/settings/apps" target="_blank" rel="noopener" class="btn btn-primary btn-sm">GitHub App Settings &nearr;</a>
          </div>
        </div>
      </body>
      </html>
    `);
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  req.session.returnTo = returnTo;

  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "localhost:3000").split(",")[0].trim();
  const baseUrl = (process.env.BASE_URL || `${proto}://${host}`).replace(/\/$/, "");
  const redirectUri = `${baseUrl}/auth/callback`;
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&state=${state}&scope=read:user&redirect_uri=${encodeURIComponent(
    redirectUri
  )}`;

  req.session.save((err) => {
    if (err) {
      console.error("[ERROR] [AUTH] Failed to save session before redirect:", err);
    }
    res.redirect(authUrl);
  });
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
  const { code, state, installation_id, setup_action, error, error_description } = req.query;

  // Handle user cancellation or OAuth error from GitHub
  if (error) {
    console.warn(`[WARN] [AUTH] OAuth error from GitHub: ${error} - ${error_description}`);
    res.redirect("/?error=" + encodeURIComponent(String(error_description || error)));
    return;
  }

  // GitHub App installation callbacks supply installation_id and/or setup_action directly from GitHub's install flow
  const isInstallation = Boolean(installation_id || setup_action);

  // 1. Verify OAuth state to prevent CSRF login attacks
  // Skip state verification ONLY when this is an installation callback directly from GitHub
  if (!isInstallation) {
    if (!state || !req.session?.oauthState || state !== req.session.oauthState) {
      res.status(403).send("Forbidden: Invalid OAuth state parameter.");
      return;
    }
  }

  if (req.session?.oauthState) {
    delete req.session.oauthState;
  }

  if (!code) {
    // If GitHub redirected here from an installation without OAuth code
    if (installation_id) {
      res.redirect(`/settings?installation_id=${encodeURIComponent(String(installation_id))}`);
      return;
    }
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

    if (installation_id && !userInstallations.includes(Number(installation_id))) {
      userInstallations.push(Number(installation_id));
    }

    // Auto-upsert verified installations into database to prevent foreign key issues
    try {
      const { query: dbQuery } = await import("../db/client.js");
      if (Array.isArray(instData.installations)) {
        for (const inst of instData.installations) {
          await dbQuery(
            `INSERT INTO installations (installation_id, account_login, account_type)
             VALUES ($1, $2, $3)
             ON CONFLICT (installation_id) DO UPDATE
             SET account_login = EXCLUDED.account_login, account_type = EXCLUDED.account_type;`,
            [inst.id, inst.account?.login || userData.login, inst.account?.type || "User"]
          );
        }
      }

      if (installation_id) {
        await dbQuery(
          `INSERT INTO installations (installation_id, account_login, account_type)
           VALUES ($1, $2, 'User')
           ON CONFLICT (installation_id) DO NOTHING;`,
          [Number(installation_id), userData.login]
        );
      }
    } catch (dbErr: any) {
      console.warn("[WARN] [AUTH] Failed to pre-seed installations in database:", dbErr?.message || dbErr);
    }

    // 5. Store verified user and installation permissions in server session
    req.session.user = {
      id: userData.id,
      login: userData.login,
      avatarUrl: userData.avatar_url,
      avatar_url: userData.avatar_url,
    };
    req.session.installations = userInstallations;

    const destination =
      req.session.returnTo ||
      (installation_id ? `/settings?installation_id=${encodeURIComponent(String(installation_id))}` : "/dashboard");
    delete req.session.returnTo;

    req.session.save((err) => {
      if (err) {
        console.error("[ERROR] Failed to save session during OAuth callback:", err);
      }
      res.redirect(destination);
    });
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
