import { createHash, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Router, type Request } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import {
  AUTH_COOKIE_NAME,
  authCookieOptions,
  createSessionToken,
  getAuthConfiguration,
  getAuthenticatedUsername,
  trustedOriginMiddleware,
} from "../middleware/auth";

const router = Router();
const scrypt = promisify(nodeScrypt);
const loginSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});
const failedAttempts = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, salt, expected] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  try {
    const actual = (await scrypt(password, salt, 64)) as Buffer;
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

router.use(trustedOriginMiddleware);

router.get("/session", (req, res) => {
  const configured = Boolean(getAuthConfiguration());
  const username = getAuthenticatedUsername(req);
  const response: ApiResponse<{ authenticated: boolean; configured: boolean; username: string | null }> = {
    success: true,
    data: { authenticated: Boolean(username), configured, username },
  };
  res.set("Cache-Control", "no-store").status(200).json(response);
});

router.post("/login", async (req, res) => {
  const config = getAuthConfiguration();
  if (!config) {
    const response: ApiResponse<null> = { success: false, error: "登录鉴权尚未配置。" };
    res.status(503).json(response);
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    const response: ApiResponse<null> = { success: false, error: "账号或密码错误。" };
    res.status(400).json(response);
    return;
  }
  const key = clientKey(req);
  const now = Date.now();
  const attempt = failedAttempts.get(key);
  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    res.set("Retry-After", String(Math.ceil((attempt.lockedUntil - now) / 1000)));
    const response: ApiResponse<null> = { success: false, error: "登录尝试过于频繁，请稍后再试。" };
    res.status(429).json(response);
    return;
  }
  const passwordHash = process.env.AUTH_PASSWORD_HASH?.trim() ?? "";
  const usernameMatches = constantTimeStringEqual(parsed.data.username, config.username);
  const passwordMatches = await verifyPassword(parsed.data.password, passwordHash);
  if (!usernameMatches || !passwordMatches) {
    const activeAttempt = !attempt || now - attempt.firstAt > WINDOW_MS
      ? { count: 1, firstAt: now, lockedUntil: 0 }
      : { ...attempt, count: attempt.count + 1 };
    if (activeAttempt.count >= MAX_ATTEMPTS) activeAttempt.lockedUntil = now + LOCK_MS;
    failedAttempts.set(key, activeAttempt);
    const response: ApiResponse<null> = { success: false, error: "账号或密码错误。" };
    res.status(401).json(response);
    return;
  }
  failedAttempts.delete(key);
  res.cookie(AUTH_COOKIE_NAME, createSessionToken(config.username, config.sessionSecret), authCookieOptions(req));
  const response: ApiResponse<{ username: string }> = { success: true, data: { username: config.username } };
  res.set("Cache-Control", "no-store").status(200).json(response);
});

router.post("/logout", (req, res) => {
  const options = authCookieOptions(req);
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
    path: options.path,
  });
  const response: ApiResponse<null> = { success: true, data: null };
  res.set("Cache-Control", "no-store").status(200).json(response);
});

export default router;
