// NXP NTAG 424 DNA "SUN (Secure Unique NFC)" メッセージ検証
// 参考: NXP AN12196 "NTAG 424 DNA and NTAG 424 DNA TagTamper features and hints"
//
// タグの URL 例:  https://<host>/t/<tagId>?picc=<32hex>&cmac=<16hex>
//   picc = AES-128-CBC(IV=0, SDMMetaReadKey) で暗号化された PICCData (UID + 読取カウンタ)
//   cmac = セッション鍵による CMAC の奇数バイト (8byte)
// タップの度にカウンタが増えるので、URL をコピー/撮影しての不正打刻（リプレイ）を検出できる。
//
// WebCrypto は AES-ECB / CMAC を直接サポートしないため AES-CBC から組み立てる。

import { hexToBytes, bytesToHex, timingSafeEqual } from "./crypto";

const ZERO_IV = new Uint8Array(16);

async function importCbc(key: Uint8Array) {
  return crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt", "decrypt"]);
}

/** AES-128 単一ブロック暗号化 (= ECB) */
async function aesEncryptBlock(key: CryptoKey, block: Uint8Array, iv: Uint8Array = ZERO_IV): Promise<Uint8Array> {
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, block));
  return out.slice(0, 16);
}

/** AES-128-CBC 復号（パディング無し 1ブロック）。WebCrypto の PKCS#7 検査を回避するため補助ブロックを付与する */
async function aesDecryptBlockNoPad(key: CryptoKey, block: Uint8Array, iv: Uint8Array = ZERO_IV): Promise<Uint8Array> {
  // 空データを IV=block で暗号化 → E(K, block XOR 0x10*16)。これを後ろに付けると復号結果の末尾が正しい PKCS#7 パディングになる
  const padBlock = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: block }, key, new Uint8Array(0)));
  const joined = new Uint8Array(32);
  joined.set(block, 0);
  joined.set(padBlock.slice(0, 16), 16);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, joined));
  return pt.slice(0, 16);
}

function shiftLeft1(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    out[i] = ((src[i] << 1) & 0xff) | carry;
    carry = src[i] & 0x80 ? 1 : 0;
  }
  return out;
}

/** AES-CMAC (RFC 4493) */
export async function aesCmac(keyBytes: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const key = await importCbc(keyBytes);
  const L = await aesEncryptBlock(key, new Uint8Array(16));
  const K1 = shiftLeft1(L);
  if (L[0] & 0x80) K1[15] ^= 0x87;
  const K2 = shiftLeft1(K1);
  if (K1[0] & 0x80) K2[15] ^= 0x87;

  const n = Math.max(1, Math.ceil(msg.length / 16));
  const complete = msg.length > 0 && msg.length % 16 === 0;
  const buf = new Uint8Array(n * 16);
  buf.set(msg);
  const last = (n - 1) * 16;
  if (complete) {
    for (let i = 0; i < 16; i++) buf[last + i] ^= K1[i];
  } else {
    buf[msg.length] = 0x80;
    for (let i = 0; i < 16; i++) buf[last + i] ^= K2[i];
  }
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, key, buf));
  return ct.slice(last, last + 16);
}

export interface SunResult {
  uid: string; // hex upper
  counter: number;
}

export class SunError extends Error {}

/**
 * SUN メッセージを検証して UID とカウンタを返す。
 * @param metaKeyHex SDMMetaReadKey (16byte hex)
 * @param fileKeyHex SDMFileReadKey (16byte hex)
 */
export async function verifySun(piccHex: string, cmacHex: string, metaKeyHex: string, fileKeyHex: string): Promise<SunResult> {
  const picc = hexToBytes(piccHex);
  const cmac = hexToBytes(cmacHex);
  if (picc.length !== 16 || cmac.length !== 8) throw new SunError("SUNパラメータの長さが不正です");

  const metaKey = await importCbc(hexToBytes(metaKeyHex));
  const plain = await aesDecryptBlockNoPad(metaKey, picc);

  const tagByte = plain[0];
  const uidMirrored = (tagByte & 0x80) !== 0;
  const ctrMirrored = (tagByte & 0x40) !== 0;
  const uidLen = tagByte & 0x0f;
  if (!uidMirrored || !ctrMirrored || uidLen !== 7) throw new SunError("PICCData の復号に失敗しました（鍵不一致の可能性）");

  const uid = plain.slice(1, 8);
  const ctrBytes = plain.slice(8, 11); // LSB first
  const counter = ctrBytes[0] | (ctrBytes[1] << 8) | (ctrBytes[2] << 16);

  // セッション MAC 鍵導出: SV2 = 3CC3 0001 0080 || UID || SDMReadCtr
  const sv2 = new Uint8Array(16);
  sv2.set([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]);
  sv2.set(uid, 6);
  sv2.set(ctrBytes, 13);
  const sessionKey = await aesCmac(hexToBytes(fileKeyHex), sv2);

  // SDMMACInputOffset == SDMMACOffset（追加入力なし）の構成を前提とする
  const full = await aesCmac(sessionKey, new Uint8Array(0));
  const truncated = new Uint8Array(8);
  for (let i = 0; i < 8; i++) truncated[i] = full[i * 2 + 1];

  if (!timingSafeEqual(truncated, cmac)) throw new SunError("CMAC が一致しません（改ざん・複製の可能性）");
  return { uid: bytesToHex(uid), counter };
}
