import qrcode from "qrcode-generator";

/** QRコードを SVG 文字列で生成（誤り訂正 M: シールの汚れ・欠けにある程度耐える） */
export function qrSvg(text: string, opts: { size?: number; margin?: number; ecc?: "L" | "M" | "Q" | "H" } = {}) {
  const qr = qrcode(0, opts.ecc ?? "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = opts.margin ?? 2;
  const dim = n + margin * 2;
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const size = opts.size ?? dim * 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/** タグのQR用URL（?src=qr で「カメラ読取」として記録を区別する） */
export function tagQrUrl(origin: string, tagId: string) {
  return `${origin}/t/${tagId}?src=qr`;
}
