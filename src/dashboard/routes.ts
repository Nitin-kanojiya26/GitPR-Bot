import { Router, Request, Response } from "express";
import { ensureAuthenticated } from "../web/auth.js";
import { getDashboardData } from "./service.js";
import { query } from "../db/client.js";

export const dashboardRouter = Router();

/**
 * GET /dashboard
 * Renders the four-panel metrics dashboard strictly scoped to authorized installations.
 */
dashboardRouter.get("/", ensureAuthenticated, async (req: Request, res: Response) => {
  const userInstallations = (req.session.installations || []).map(Number);

  if (userInstallations.length === 0) {
    return res.render("dashboard", {
      title: "Dashboard - GitPR",
      noInstallations: true,
      selectedInstallationId: null,
      installations: [],
      data: {
        commentsPerWeek: [],
        topRules: [],
        outcomeRates: { fixed_count: 0, ignored_count: 0, open_count: 0, fixed_rate: 0, ignored_rate: 0 },
        recentReviews: [],
        hasData: false,
      },
    });
  }

  // Check if a specific installation was requested via query param
  let targetInstallations = userInstallations;
  let selectedInstallationId: number | null = null;

  if (req.query.installation_id) {
    selectedInstallationId = Number(req.query.installation_id);
    // Strict multi-tenant authorization guard
    if (!userInstallations.includes(selectedInstallationId)) {
      return res.status(403).render("dashboard", {
        title: "Access Denied - GitPR",
        noInstallations: false,
        selectedInstallationId: null,
        installations: [],
        data: null,
        error: "Forbidden: You do not have permission to view analytics for this installation.",
      });
    }
    targetInstallations = [selectedInstallationId];
  }

  // Fetch metrics data
  const data = await getDashboardData(targetInstallations);

  // Retrieve installation logins for account switcher
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

  res.render("dashboard", {
    title: "Analytics Dashboard - GitPR",
    noInstallations: false,
    selectedInstallationId,
    installations: installationsList,
    data,
    error: null,
  });
});

