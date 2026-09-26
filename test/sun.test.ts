import { describe, it, expect } from "vitest";
import { aesCmac, verifySun } from "../worker/lib/sun";
import { hexToBytes, bytesToHex } from "../worker/lib/crypto";

describe("AES-CMAC (RFC 4493 test vectors)", () => {
  const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
  it("empty", async () => {
    expect(bytesToHex(await aesCmac(key, new Uint8Array(0)))).toBe("BB1D6929E95937287FA37D129B756746");
  });
  it("16 bytes", async () => {
    expect(bytesToHex(await aesCmac(key, hexToBytes("6bc1bee22e409f96e93d7e117393172a")))).toBe("070A16B46B4D4144F79BDD9DD04A287C");
  });
  it("40 bytes", async () => {
    const m = hexToBytes("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411");
    expect(bytesToHex(await aesCmac(key, m))).toBe("DFA66747DE9AE63030CA32611497C827");
  });
});

describe("NTAG 424 DNA SUN (NXP AN12196 example)", () => {
  const zero = "00000000000000000000000000000000";
  it("verifies picc/cmac and extracts uid+counter", async () => {
    const r = await verifySun("EF963FF7828658A599F3041510671E88", "94EED9EE65337086", zero, zero);
    expect(r.uid).toBe("04DE5F1EACC040");
    expect(r.counter).toBe(0x3d);
  });
  it("rejects tampered cmac", async () => {
    await expect(verifySun("EF963FF7828658A599F3041510671E88", "94EED9EE65337087", zero, zero)).rejects.toThrow();
  });
});
