import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

declare module "express-session" {
  interface SessionData {
    csrfToken?: string;
  }
}

/**
 * Lightweight, dependency-free CSRF protection middleware.
 * Generates an unguessable 24-byte hex token in the user's server-side session.
 * Rejects state-changing requests (POST, PUT, DELETE, PATCH) if the token is missing or mismatched.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  // 1. Skip webhook ingestion endpoints (GitHub webhooks use HMAC-SHA256 signature verification)
  if (req.path.startsWith("/api/github/webhooks")) {
    return next();
  }

  // 2. Ensure session exists
  if (!req.session) {
    return next();
  }

  // 3. Generate CSRF token if not already in session
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString("hex");
  }

  // Expose to template rendering engine
  res.locals.csrfToken = req.session.csrfToken;

  // 4. Validate for state-changing requests
  const safeMethods = ["GET", "HEAD", "OPTIONS"];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  const incomingToken =
    (req.body && req.body._csrf) ||
    req.headers["x-csrf-token"] ||
    req.headers["csrf-token"];

  if (!incomingToken || incomingToken !== req.session.csrfToken) {
    res.status(403).json({
      error: "Forbidden: Invalid or missing CSRF token. Please refresh the page and try again.",
    });
    return;
  }

  next();
}
