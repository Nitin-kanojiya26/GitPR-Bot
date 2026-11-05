import { describe, it, expect } from "vitest";
import express from "express";
import { ensureAuthenticated, ensureInstallationAccess, authRouter } from "../src/web/auth.js";
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

  describe("OAuth Callback & Installation Handling", () => {
    it("rejects OAuth callback when state parameter does not match session", async () => {
      const app = express();
      app.use((req: any, _res, next) => {
        req.session = { oauthState: "expected-secret-state" };
        next();
      });
      app.use("/auth", authRouter);

      const result = await new Promise<{ status: number; body: string }>((resolve) => {
        let status = 200;
        let body = "";
        const req: any = {
          method: "GET",
          url: "/auth/callback?code=some-code&state=wrong-state",
          headers: {},
        };
        const res: any = {
          status(code: number) {
            status = code;
            return this;
          },
          send(data: any) {
            body = String(data);
            resolve({ status, body });
            return this;
          },
          setHeader() {
            return this;
          },
        };
        app.handle(req, res);
      });

      expect(result.status).toBe(403);
      expect(result.body).toContain("Forbidden: Invalid OAuth state parameter.");
    });

    it("bypasses state check on GitHub App installation callback with installation_id", async () => {
      const app = express();
      app.use((req: any, _res, next) => {
        req.session = {}; // No oauthState set!
        next();
      });
      app.use("/auth", authRouter);

      const result = await new Promise<{ status: number; location?: string }>((resolve) => {
        let status = 200;
        let location = "";
        const req: any = {
          method: "GET",
          url: "/auth/callback?installation_id=12345",
          headers: {},
        };
        const res: any = {
          status(code: number) {
            status = code;
            return this;
          },
          redirect(url: string) {
            status = 302;
            location = url;
            resolve({ status, location });
          },
          send(data: any) {
            resolve({ status, location: String(data) });
            return this;
          },
          setHeader() {
            return this;
          },
        };
        app.handle(req, res);
      });

      expect(result.status).toBe(302);
      expect(result.location).toBe("/settings?installation_id=12345");
    });

    it("handles GitHub OAuth error by redirecting to home with error message", async () => {
      const app = express();
      app.use((req: any, _res, next) => {
        req.session = {};
        next();
      });
      app.use("/auth", authRouter);

      const result = await new Promise<{ status: number; location: string }>((resolve) => {
        let status = 200;
        let location = "";
        const req: any = {
          method: "GET",
          url: "/auth/callback?error=access_denied&error_description=User%20denied%20access",
          headers: {},
        };
        const res: any = {
          status(code: number) {
            status = code;
            return this;
          },
          redirect(url: string) {
            status = 302;
            location = url;
            resolve({ status, location });
          },
          setHeader() {
            return this;
          },
        };
        app.handle(req, res);
      });

      expect(result.status).toBe(302);
      expect(result.location).toContain("/?error=");
    });
  });
});

