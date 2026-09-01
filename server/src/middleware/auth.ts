import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";

export const AUTH_COOKIE_NAME = "novel_forge_session";
const SESSION_DURATION_SECONDS = 12 * 60 * 60;

interface SessionPayload {
  username: string;
  expiresAt: number;
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return decodeURIComponent(item.slice(separator + 1).trim());
    }
  }
  return null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function getAuthConfiguration(): { username: string; sessionSecret: string } | null {
  const username = process.env.AUTH_USERNAME?.trim();
  const sessionSecret = process.env.AUTH_SESSION_SECRET?.trim();
  const passwordHash = process.env.AUTH_PASSWORD_HASH?.trim();
  if (!username || !passwordHash || !sessionSecret || sessionSecret.length < 32) return null;
  return { username, sessionSecret };
}

export function createSessionToken(username: string, secret: string, now = Date.now()): string {
  const payload: SessionPayload = {
    username,
    expiresAt: Math.floor(now / 1000) + SESSION_DURATION_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function readSessionToken(token: string, secret: string, now = Date.now()): SessionPayload | null {
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(encoded, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof payload.username !== "string" || typeof payload.expiresAt !== "number") return null;
    if (payload.expiresAt <= Math.floor(now / 1000)) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export function getAuthenticatedUsername(req: Request): string | null {
  const config = getAuthConfiguration();
  const token = getCookie(req, AUTH_COOKIE_NAME);
  if (!config || !token) return null;
  const session = readSessionToken(token, config.sessionSecret);
  return session && safeEqual(session.username, config.username) ? session.username : null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!getAuthConfiguration()) {
    const response: ApiResponse<null> = { success: false, error: "登录鉴权尚未配置。" };
    res.set("Cache-Control", "no-store").status(503).json(response);
    return;
  }
  if (!getAuthenticatedUsername(req)) {
    const response: ApiResponse<null> = { success: false, error: "登录状态已失效，请重新登录。" };
    res.set("Cache-Control", "no-store").status(401).json(response);
    return;
  }
  next();
}

export function trustedOriginMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get("origin");
  if (!origin) {
    next();
    return;
  }
  const allowed = new Set((process.env.CORS_ORIGIN ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  try {
    const parsed = new URL(origin);
    if (allowed.has(origin) || parsed.host === req.get("host")) {
      next();
      return;
    }
  } catch {
    // Invalid origins are rejected below.
  }
  const response: ApiResponse<null> = { success: false, error: "请求来源不受信任。" };
  res.status(403).json(response);
}

export function authCookieOptions(req: Request) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isHttps = req.secure || forwardedProto === "https";
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || isHttps,
    sameSite: "lax" as const,
    path: "/api",
    maxAge: SESSION_DURATION_SECONDS * 1000,
  };
}
