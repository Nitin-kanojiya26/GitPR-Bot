import { describe, it, expect } from "vitest";
import { ensureAuthenticated, ensureInstallationAccess } from "../src/web/auth.js";
import { csrfProtection } from "../src/web/csrf.js";

describe("Authentication & Multi-Tenant Authorization Security", () => {
  describe("ensureAuthenticated", () => {
    it("redirects unauthenticated users to GitHub login with returnTo", () => {
      let redirectUrl = "";
      const req: any = {
        session: {},
        originalUrl: "/dashboard",
      };
      const res: any = {
        redirect(url: string) {
          redirectUrl = url;
        },
      };
      let nextCalled = false;
      ensureAuthenticated(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(redirectUrl).toBe("/auth/login?returnTo=%2Fdashboard");
    });

    it("allows authenticated users to proceed", () => {
      const req: any = {
        session: { user: { id: 123, login: "alice" } },
      };
      const res: any = {};
      let nextCalled = false;
      ensureAuthenticated(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });
  });

  describe("ensureInstallationAccess (Multi-Tenant Isolation)", () => {
    it("forbids access if installation ID is not owned by the session user", () => {
      let statusCode = 0;
      let errorBody: any = null;

      const req: any = {
        session: {
          user: { id: 100, login: "attacker" },
          installations: [999], // User only owns #999
        },
        query: { installation_id: "555" }, // Trying to access victim's #555
      };

      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          errorBody = data;
          return this;
        },
      };

      let nextCalled = false;
      ensureInstallationAccess(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(403);
      expect(errorBody.error).toContain("Forbidden");
    });

    it("grants access if installation ID belongs to the session user", () => {
      const req: any = {
        session: {
          user: { id: 200, login: "bob" },
          installations: [555, 777],
        },
        query: { installation_id: "555" },
      };
      const res: any = {};
      let nextCalled = false;
      ensureInstallationAccess(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });
  });

  describe("CSRF Protection", () => {
    it("allows GET requests and issues a new session csrfToken", () => {
      const req: any = {
        method: "GET",
        path: "/",
        session: {},
      };
      const res: any = { locals: {} };
      let nextCalled = false;

      csrfProtection(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(req.session.csrfToken).toBeDefined();
      expect(res.locals.csrfToken).toBe(req.session.csrfToken);
    });

    it("rejects state-changing POST requests without CSRF token", () => {
      let statusCode = 0;
      const req: any = {
        method: "POST",
        path: "/settings/key",
        session: { csrfToken: "valid-token-123" },
        body: {},
        headers: {},
      };
      const res: any = {
        locals: {},
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          return this;
        },
      };

      let nextCalled = false;
      csrfProtection(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(403);
    });

    it("accepts state-changing POST requests with matching CSRF token", () => {
      const req: any = {
        method: "POST",
        path: "/settings/key",
        session: { csrfToken: "valid-token-123" },
        body: { _csrf: "valid-token-123" },
        headers: {},
      };
      const res: any = { locals: {} };
      let nextCalled = false;

      csrfProtection(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });
  });
});
