// TOTP（RFC 6238 / HMAC-SHA1・30秒・6桁）— Google Authenticator 等と互換
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export async function totpAt(secretB32: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let x = step;
  for (let i = 7; i >= 0; i--) {
    msg[i] = x & 0xff;
    x = Math.floor(x / 256);
  }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * コードを検証し、一致した時間ステップを返す（前後1ステップ=±30秒の時計ずれを許容）。
 * lastStep 以下のステップは再利用として拒否する。
 */
export async function verifyTotp(secretB32: string, code: string, lastStep = 0, at = Date.now()): Promise<number | null> {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(at / 1000 / 30);
  for (const s of [cur, cur - 1, cur + 1]) {
    if (s <= lastStep) continue;
    if ((await totpAt(secretB32, s)) === c) return s;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer = "Intent-Trace 運営") {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
