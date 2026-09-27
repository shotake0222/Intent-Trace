import { describe, it, expect } from "vitest";
import { totpAt, verifyTotp, base32Encode, base32Decode } from "../worker/lib/totp";

// RFC 6238 付録B（SHA1, シード "12345678901234567890"）の8桁値の下6桁
const SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"]
  ])("t=%i", async (t, code) => {
    expect(await totpAt(SECRET, Math.floor(t / 30))).toBe(code);
  });
  it("base32 roundtrip", () => {
    const b = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });
  it("rejects reuse of same step", async () => {
    const at = 1234567890 * 1000;
    const step = await verifyTotp(SECRET, "005924", 0, at);
    expect(step).toBe(Math.floor(1234567890 / 30));
    expect(await verifyTotp(SECRET, "005924", step!, at)).toBeNull();
  });
});
