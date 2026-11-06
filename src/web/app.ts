import express, { Express } from "express";
import path from "node:path";
import cookieParser from "cookie-parser";
import session from "express-session";
import { Probot } from "probot";
import { checkHealth } from "../health.js";
import { csrfProtection } from "./csrf.js";
import { authRouter } from "./auth.js";
import { settingsRouter } from "../settings/routes.js";
import { dashboardRouter } from "../dashboard/routes.js";

export function createWebApp(probotApp?: Probot): Express {
  const app = express();

  // Trust first proxy hop (Render, Cloudflare, AWS ALB) for secure cookies and https protocol detection
  app.set("trust proxy", 1);

  // Dynamically resolve real GitHub App slug/URL directly from GitHub API
  let cachedInstallUrl: string | null = null;
  if (probotApp?.auth) {
    probotApp
      .auth()
      .then((octokit: any) => octokit.apps.getAuthenticated())
      .then((res: any) => {
        const data = res?.data;
        if (data?.html_url) {
          cachedInstallUrl = `${data.html_url}/installations/new`;
        } else if (data?.slug) {
          cachedInstallUrl = `https://github.com/apps/${data.slug}/installations/new`;
        }
      })
      .catch(() => {
        // Non-fatal, falls back to GITHUB_APP_SLUG or gitpr-bot
      });
  }

  // 1. Configure EJS view engine
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "views"));

  // 2. Middleware pipeline
  app.use(express.static(path.join(process.cwd(), "public")));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // 3. Server-side session configuration
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "gitpr-dev-session-secret-change-in-prod",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    })
  );

  // 4. CSRF Protection for state-changing routes
  app.use(csrfProtection);

  // 5. Expose session user and app slug to all EJS templates
  app.use((req, res, next) => {
    res.locals.user = req.session?.user || null;
    res.locals.installations = req.session?.installations || [];
    res.locals.currentPath = req.path || "/";
    const envSlug = process.env.GITHUB_APP_SLUG;
    res.locals.installUrl =
      (envSlug ? `https://github.com/apps/${envSlug}/installations/new` : null) ||
      cachedInstallUrl ||
      `https://github.com/apps/gitpr-bot/installations/new`;
    next();
  });

  // 6. Mount Authentication, Settings & Dashboard Routers
  app.use("/auth", authRouter);
  app.use("/settings", settingsRouter);
  app.use("/dashboard", dashboardRouter);

  // 7. Healthcheck endpoint (/health and /healthz)
  app.get(["/health", "/healthz"], async (_req, res) => {
    try {
      const health = await checkHealth();
      const statusCode = health.status === "ok" ? 200 : 503;
      res.status(statusCode).json({
        status: health.status,
        timestamp: health.timestamp,
        uptimeSeconds: health.uptimeSeconds,
        services: health.services,
      });
    } catch (err: any) {
      res.status(500).json({ status: "down", error: err?.message || String(err) });
    }
  });

  // 8. Setup redirect target from GitHub App installation
  app.get("/setup", (req, res) => {
    if (!req.session?.user) {
      const returnTo = req.query.installation_id
        ? `/setup?installation_id=${encodeURIComponent(String(req.query.installation_id))}`
        : "/setup";
      res.redirect(`/auth/login?returnTo=${returnTo}`);
      return;
    }
    const target = req.query.installation_id
      ? `/settings?installation_id=${encodeURIComponent(String(req.query.installation_id))}`
      : "/settings";
    res.redirect(target);
  });

  // 9. Landing page
  app.get("/", (_req, res) => {
    res.render("index", {
      title: "Vigilentia - Autonomous AI Pull Request Reviewer",
    });
  });

  // 10. Privacy policy page
  app.get("/privacy", (_req, res) => {
    res.render("privacy", {
      title: "Privacy Policy - Vigilentia",
    });
  });

  // 11. Probot default fallback redirect (ensures /probot always routes to landing page)
  app.use("/probot", (_req, res) => {
    res.redirect("/");
  });

  return app;
}
