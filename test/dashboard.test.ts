import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDashboardData } from "../src/dashboard/service.js";
import { dashboardRouter } from "../src/dashboard/routes.js";
import * as db from "../src/db/client.js";

describe("Four-Panel Analytics Dashboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("getDashboardData Service Queries", () => {
    it("returns empty default metrics when installations array is empty", async () => {
      const data = await getDashboardData([]);

      expect(data.hasData).toBe(false);
      expect(data.commentsPerWeek).toEqual([]);
      expect(data.topRules).toEqual([]);
      expect(data.outcomeRates.fixed_count).toBe(0);
      expect(data.recentReviews).toEqual([]);
    });

    it("executes the four panel queries filtered strictly by tenant installations", async () => {
      const executedQueries: string[] = [];
      const queryParams: any[][] = [];

      vi.spyOn(db, "query").mockImplementation(async (sql: string, params?: any[]) => {
        executedQueries.push(sql);
        queryParams.push(params || []);

        if (sql.includes("date_trunc('week'")) {
          return {
            rows: [
              { week: "2026-10-19", count: "3" },
              { week: "2026-10-26", count: "8" },
            ],
            rowCount: 2,
            command: "",
            oid: 0,
            fields: [],
          };
        }

        if (sql.includes("GROUP BY rule_title")) {
          return {
            rows: [
              { rule_title: "Safe Code Execution", count: "5" },
              { rule_title: "No Hardcoded Secrets", count: "4" },
            ],
            rowCount: 2,
            command: "",
            oid: 0,
            fields: [],
          };
        }

        if (sql.includes("outcome = 'fixed'")) {
          return {
            rows: [
              {
                fixed_count: "6",
                ignored_count: "2",
                open_count: "1",
                fixed_rate: 75.0,
                ignored_rate: 25.0,
              },
            ],
            rowCount: 1,
            command: "",
            oid: 0,
            fields: [],
          };
        }

        if (sql.includes("FROM reviews")) {
          return {
            rows: [
              {
                id: 101,
                repo: "org/repo-a",
                pr_number: 12,
                head_sha: "abcd1234ef56",
                comments_posted: 2,
                status: "completed",
                duration_ms: 2100,
                created_at: new Date(),
              },
            ],
            rowCount: 1,
            command: "",
            oid: 0,
            fields: [],
          };
        }

        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
      });

      const data = await getDashboardData([100, 200]);

      expect(data.hasData).toBe(true);

      // Panel 1: Comments per week
      expect(data.commentsPerWeek).toHaveLength(2);
      expect(data.commentsPerWeek[0]).toEqual({ week: "2026-10-19", count: 3 });
      expect(data.commentsPerWeek[1]).toEqual({ week: "2026-10-26", count: 8 });

      // Panel 2: Top rules
      expect(data.topRules).toHaveLength(2);
      expect(data.topRules[0]).toEqual({ rule_title: "Safe Code Execution", count: 5 });

      // Panel 3: Fixed vs Ignored rates
      expect(data.outcomeRates.fixed_count).toBe(6);
      expect(data.outcomeRates.ignored_count).toBe(2);
      expect(data.outcomeRates.fixed_rate).toBe(75.0);
      expect(data.outcomeRates.ignored_rate).toBe(25.0);

      // Panel 4: Recent reviews
      expect(data.recentReviews).toHaveLength(1);
      expect(data.recentReviews[0].repo).toBe("org/repo-a");
      expect(data.recentReviews[0].status).toBe("completed");

      // Verify all 4 queries enforced multi-tenant installation scoping
      expect(executedQueries).toHaveLength(4);
      for (const params of queryParams) {
        expect(params[0]).toEqual([100, 200]);
      }
    });
  });

  describe("GET /dashboard Multi-Tenant Route Authorization", () => {
    it("renders noInstallations when user has 0 installations in session", async () => {
      const req: any = {
        session: {
          user: { id: 1, login: "alice" },
          installations: [],
        },
        query: {},
      };

      let renderedView = "";
      let renderData: any = {};
      const res: any = {
        render(view: string, data: any) {
          renderedView = view;
          renderData = data;
        },
      };

      const getDashboardHandler = (dashboardRouter.stack as any[]).find(
        (layer) => layer.route && layer.route.path === "/" && layer.route.methods.get
      )?.route.stack.slice(-1)[0].handle;

      await getDashboardHandler(req, res);

      expect(renderedView).toBe("dashboard");
      expect(renderData.noInstallations).toBe(true);
    });

    it("returns 403 Forbidden when requesting an installation_id not owned by session", async () => {
      const req: any = {
        session: {
          user: { id: 1, login: "alice" },
          installations: [100, 200], // Alice only owns 100 & 200
        },
        query: {
          installation_id: "999", // Attempting to spy on 999
        },
      };

      let statusCode = 200;
      let renderedView = "";
      let renderData: any = {};
      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        render(view: string, data: any) {
          renderedView = view;
          renderData = data;
        },
      };

      const getDashboardHandler = (dashboardRouter.stack as any[]).find(
        (layer) => layer.route && layer.route.path === "/" && layer.route.methods.get
      )?.route.stack.slice(-1)[0].handle;

      await getDashboardHandler(req, res);

      expect(statusCode).toBe(403);
      expect(renderedView).toBe("dashboard");
      expect(renderData.error).toContain("Forbidden");
    });

    it("loads data for authorized installation selection", async () => {
      vi.spyOn(db, "query").mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT installation_id, account_login FROM installations")) {
          return {
            rows: [{ installation_id: 100, account_login: "alice-org" }],
            rowCount: 1,
            command: "",
            oid: 0,
            fields: [],
          };
        }
        return { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
      });

      const req: any = {
        session: {
          user: { id: 1, login: "alice" },
          installations: [100],
        },
        query: {
          installation_id: "100",
        },
      };

      let renderedView = "";
      let renderData: any = {};
      const res: any = {
        render(view: string, data: any) {
          renderedView = view;
          renderData = data;
        },
      };

      const getDashboardHandler = (dashboardRouter.stack as any[]).find(
        (layer) => layer.route && layer.route.path === "/" && layer.route.methods.get
      )?.route.stack.slice(-1)[0].handle;

      await getDashboardHandler(req, res);

      expect(renderedView).toBe("dashboard");
      expect(renderData.noInstallations).toBe(false);
      expect(renderData.selectedInstallationId).toBe(100);
      expect(renderData.installations[0].account_login).toBe("alice-org");
    });
  });
});
