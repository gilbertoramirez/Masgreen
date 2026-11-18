import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { get, run } from "./db";

/**
 * Sesiones del panel.
 * - Contraseña de administrador (ADMIN_PASSWORD): acceso total (uid 0).
 * - Usuarios con PIN (tabla staff): rol "admin" (acceso total) o "vendedor" (caja, pedidos, menú sin costos y corte a ciegas).
 */
const COOKIE = "cafe_admin";
const MAX_AGE = 60 * 60 * 24 * 14; // 14 días
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export type Role = "admin" | "vendedor";
export type Session = { uid: number; name: string; role: Role };
export type StaffUser = {
  id: number;
  name: string;
  role: Role;
  active: number;
  session_version: number;
  failed_attempts: number;
  locked_until: string | null;
};

/** Páginas que puede abrir un vendedor (lo demás es solo para administradores). */
export const SELLER_PATHS = ["/admin/pos", "/admin/pedidos", "/admin/productos", "/admin/caja"];

function adminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD?.trim();
  if (p) return p;
  // Solo en desarrollo hay contraseña por defecto
  return process.env.NODE_ENV === "production" ? null : "admin";
}

function secret(): string {
  return process.env.SESSION_SECRET || `cafe:${adminPassword() ?? ""}`;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function passwordConfigured(): boolean {
  return adminPassword() !== null;
}

export function checkPassword(input: string): boolean {
  const p = adminPassword();
  return p !== null && safeEqual(input.trim(), p);
}

// ---------- PIN ----------

export const validPin = (pin: string) => /^\d{4,6}$/.test(pin);

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

function checkPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const a = scryptSync(pin, salt, 32);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Usuario + PIN. Bloquea 15 min después de 5 intentos fallidos. Devuelve el usuario o un mensaje de error. */
export async function staffLogin(id: number, pin: string): Promise<StaffUser | string> {
  const u = await get<StaffUser & { pin_hash: string }>("SELECT * FROM staff WHERE id = ?", [id]);
  if (!u || !u.pin_hash) {
    hashPin(pin || "0000"); // mismo tiempo de respuesta
    return "Este usuario todavía no tiene PIN. Pide al administrador que se lo ponga.";
  }
  if (!u.active) return "Tu usuario está desactivado. Habla con el administrador.";
  if (u.locked_until && Date.parse(u.locked_until) > Date.now()) {
    return `Demasiados intentos. Espera ${LOCK_MINUTES} minutos o pide al administrador que te cambie el PIN.`;
  }
  if (!validPin(pin) || !checkPin(pin, u.pin_hash)) {
    const fails = u.failed_attempts + 1;
    await run("UPDATE staff SET failed_attempts = ?, locked_until = ? WHERE id = ?", [
      fails >= MAX_ATTEMPTS ? 0 : fails,
      fails >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
      u.id,
    ]);
    return "PIN incorrecto.";
  }
  await run("UPDATE staff SET failed_attempts = 0, locked_until = NULL WHERE id = ?", [u.id]);
  return u;
}

// ---------- Sesión ----------

/** uid 0 = entró con la contraseña de administrador. */
export async function startSession(uid = 0, version = 0) {
  const payload = `${Date.now() + MAX_AGE * 1000}.${uid}.${version}`;
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const v = (await cookies()).get(COOKIE)?.value;
  if (!v) return null;
  const parts = v.split(".");
  if (parts.length !== 4) return null;
  const [exp, uid, ver, sig] = parts;
  if (!safeEqual(sig, sign(`${exp}.${uid}.${ver}`)) || Number(exp) < Date.now()) return null;
  if (uid === "0") return { uid: 0, name: "Administrador", role: "admin" };
  const u = await get<{ id: number; name: string; role: string; active: number; session_version: number }>(
    "SELECT id, name, role, active, session_version FROM staff WHERE id = ?",
    [Number(uid)],
  );
  // Al desactivar al usuario o cambiarle el PIN se cierran sus sesiones
  if (!u || !u.active || u.session_version !== Number(ver)) return null;
  return { uid: u.id, name: u.name, role: u.role === "admin" ? "admin" : "vendedor" };
}

export async function isAdmin(): Promise<boolean> {
  return (await getSession())?.role === "admin";
}

/** Cualquier usuario con sesión (administrador o vendedor). */
export async function isStaff(): Promise<boolean> {
  return (await getSession()) !== null;
}

/** Cualquier usuario con sesión (administrador o vendedor). */
export async function requireStaff(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/admin/login");
  return s;
}

/** Solo administradores. Un vendedor se manda a la caja. */
export async function requireAdmin(): Promise<Session> {
  const s = await requireStaff();
  if (s.role !== "admin") redirect("/admin/pos");
  return s;
}
