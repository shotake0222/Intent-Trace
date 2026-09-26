// WebCrypto ベースの暗号ユーティリティ（Workers ランタイム用）

export const enc = new TextEncoder();

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** URL に載せる短い公開ID（タグ用）。紛らわしい文字を除いた Base32 風 */
export function shortId(len = 10): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const rnd = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(rnd, (b) => alphabet[b % alphabet.length]).join("");
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return bytesToHex(new Uint8Array(d));
}

// ---------- パスワード / PIN ----------
const PBKDF2_ITER = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64urlDecode(saltB64), iterations: Number(iterStr) },
    key,
    256
  );
  return timingSafeEqual(new Uint8Array(bits), b64urlDecode(hashB64));
}

// ---------- タグ鍵の暗号化保存 (AES-GCM) ----------
async function wrapKey(secretHex: string) {
  return crypto.subtle.importKey("raw", hexToBytes(secretHex), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealSecret(plain: string, secretHex: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrapKey(secretHex), enc.encode(plain));
  return `gcm$${b64url(iv)}$${b64url(new Uint8Array(ct))}`;
}

export async function openSecret(sealed: string, secretHex: string): Promise<string> {
  const [scheme, ivB64, ctB64] = sealed.split("$");
  if (scheme !== "gcm") throw new Error("unknown seal scheme");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(ivB64) }, await wrapKey(secretHex), b64urlDecode(ctB64));
  return new TextDecoder().decode(pt);
}
