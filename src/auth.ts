// Optional shared-password login. When APP_PASSWORD is set, every page and API call requires a
// session cookie obtained by POST /api/login. The cookie holds an HMAC of the password, so changing
// APP_PASSWORD logs everyone out. Without APP_PASSWORD (local dev) the app is open.
import { createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";

const COOKIE = "brain_session";
const MAX_AGE = 30 * 24 * 3600;

export function authEnabled(): boolean {
  return !!process.env.APP_PASSWORD;
}

function token(password: string): string {
  return createHmac("sha256", password).update("company-brain-session-v1").digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function isAuthed(req: http.IncomingMessage): boolean {
  if (!authEnabled()) return true;
  const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return !!cookie && safeEqual(cookie.slice(COOKIE.length + 1), token(process.env.APP_PASSWORD!));
}

export function checkPassword(password: unknown): boolean {
  return authEnabled() && typeof password === "string" && safeEqual(password, process.env.APP_PASSWORD!);
}

export function sessionCookie(req: http.IncomingMessage): string {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${token(process.env.APP_PASSWORD!)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
export function isCron(req: http.IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && safeEqual(String(req.headers.authorization ?? ""), `Bearer ${secret}`);
}

// ---- Optional second gate for the HR persona (HR_PASSWORD) ----
const HR_COOKIE = "brain_hr";

export function hrGateEnabled(): boolean {
  return !!process.env.HR_PASSWORD;
}

/**
 * True when the HR persona may be used: the HR cookie is present, or no HR_PASSWORD is configured
 * on a local machine. On Vercel (production/preview), HR stays locked until HR_PASSWORD is set,
 * so real HR data can never be exposed by a missing setting.
 */
export function hrUnlocked(req: http.IncomingMessage): boolean {
  if (!hrGateEnabled()) return !process.env.VERCEL;
  const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${HR_COOKIE}=`));
  return !!cookie && safeEqual(cookie.slice(HR_COOKIE.length + 1), token(process.env.HR_PASSWORD!));
}

export function checkHrPassword(password: unknown): boolean {
  return hrGateEnabled() && typeof password === "string" && safeEqual(password, process.env.HR_PASSWORD!);
}

export function hrCookie(req: http.IncomingMessage): string {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${HR_COOKIE}=${token(process.env.HR_PASSWORD!)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}${secure}`;
}
