import express, { Express } from "express";
import path from "node:path";
import { Probot } from "probot";
import { checkHealth } from "../health.js";

export function createWebApp(probotApp?: Probot): Express {
  const app = express();

  // Configure EJS view engine
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "views"));

  // Serve static files from public/
  app.use(express.static(path.join(process.cwd(), "public")));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Healthcheck endpoint (/health and /healthz)
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

  // Landing page
  app.get("/", (_req, res) => {
    const appSlug = process.env.GITHUB_APP_SLUG || "gitpr-review-bot";
    res.render("index", {
      title: "GitPR - AI Pull Request Reviewer",
      installUrl: `https://github.com/apps/${appSlug}/installations/new`,
    });
  });

  return app;
}
