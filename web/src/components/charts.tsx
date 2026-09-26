import { useState, type ReactNode } from "react";

// 単一色相の連続スケール（淡→濃）。値の大小のみを表す
const SEQ = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
export function seqColor(v: number, max: number) {
  if (!v || max <= 0) return "#f1f5f9";
  const i = Math.min(SEQ.length - 1, Math.floor((v / max) * (SEQ.length - 1)));
  return SEQ[i];
}
const BAR = "#2a78d6";

function Tooltip({ left, top, children }: { left: string; top: string; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg" style={{ left, top }}>
      {children}
    </div>
  );
}

/** 日別の縦棒（単一系列） */
export function DailyBars({ data, valueKey, label, height = 160 }: { data: { date: string; [k: string]: number | string }[]; valueKey: string; label: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  const W = 600;
  const pad = { l: 32, r: 8, t: 8, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const bw = data.length ? iw / data.length : iw;
  const ticks = [0, Math.round(max / 2), max];
  if (!data.length) return <div className="py-10 text-center text-sm text-slate-500">データがありません</div>;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => {
          const y = pad.t + ih - (t / max) * ih;
          return (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="#e2e8f0" strokeWidth={1} />
              <text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize={10} fill="#64748b">
                {t}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const v = Number(d[valueKey]) || 0;
          const h = (v / max) * ih;
          const x = pad.l + i * bw + 1;
          const w = Math.max(1, bw - 2);
          const r = Math.min(4, w / 2, h);
          const y = pad.t + ih - h;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={ih} fill="transparent" />
              {h > 0 && <path d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`} fill={BAR} opacity={hover === null || hover === i ? 1 : 0.45} />}
              {(i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 6) === 0) && (
                <text x={pad.l + i * bw + bw / 2} y={height - 6} textAnchor="middle" fontSize={10} fill="#64748b">
                  {String(d.date).slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip left={`${((pad.l + hover * bw + bw / 2) / W) * 100}%`} top={`${((pad.t + ih - ((Number(data[hover][valueKey]) || 0) / max) * ih) / height) * 100}%`}>
          {data[hover].date}　{label} <b>{data[hover][valueKey]}</b>
        </Tooltip>
      )}
    </div>
  );
}

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

/** 曜日 × 時間帯 ヒートマップ */
export function DowHourHeatmap({ grid }: { grid: number[][] }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const max = Math.max(0, ...grid.flat());
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-[2px] text-[10px]">
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="w-6 font-normal text-slate-500">
                  {h % 3 === 0 ? h : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, d) => (
              <tr key={d}>
                <th className="pr-1 font-normal text-slate-500">{DOW[d]}</th>
                {row.map((v, h) => (
                  <td
                    key={h}
                    onMouseEnter={() => setHover({ d, h })}
                    onMouseLeave={() => setHover(null)}
                    title={`${DOW[d]}曜 ${h}時台: ${v}件`}
                    className="h-6 w-6 rounded-[4px]"
                    style={{ background: seqColor(v, max), outline: hover?.d === d && hover?.h === h ? "2px solid #0f172a" : undefined }}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>{hover ? `${DOW[hover.d]}曜 ${hover.h}時台: ${grid[hover.d][hover.h]}件` : "セルにカーソルを合わせると件数を表示"}</span>
        <Legend max={max} />
      </div>
    </div>
  );
}

export function Legend({ max }: { max: number }) {
  return (
    <span className="flex items-center gap-1">
      0
      <span className="flex">
        {[0, 3, 6, 9, 12].map((i) => (
          <span key={i} className="h-3 w-4" style={{ background: SEQ[i] }} />
        ))}
      </span>
      {max}件
    </span>
  );
}

/** フロアマップ上のゾーン別ヒートマップ（pos_x/pos_y を持つゾーンを配置） */
export function ZoneMap({ zones, metric }: { zones: { id: string; name: string; pos_x: number | null; pos_y: number | null; incidents: number; danger: number; taps: number }[]; metric: "incidents" | "taps" }) {
  const [hover, setHover] = useState<string | null>(null);
  const placed = zones.filter((z) => z.pos_x != null && z.pos_y != null);
  const max = Math.max(0, ...zones.map((z) => z[metric]));
  if (!placed.length) return <div className="py-8 text-center text-sm text-slate-500">ゾーンに座標が設定されていません（サイト設定で配置できます）</div>;
  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden rounded-xl bg-[linear-gradient(#e2e8f0_1px,transparent_1px),linear-gradient(90deg,#e2e8f0_1px,transparent_1px)] bg-[size:40px_40px] ring-1 ring-slate-200">
      {placed.map((z) => {
        const v = z[metric];
        const size = 36 + (max ? (v / max) * 64 : 0);
        return (
          <div
            key={z.id}
            onMouseEnter={() => setHover(z.id)}
            onMouseLeave={() => setHover(null)}
            className="absolute -translate-x-1/2 -translate-y-1/2 text-center"
            style={{ left: `${z.pos_x! * 100}%`, top: `${z.pos_y! * 100}%` }}
          >
            <div className="mx-auto grid place-items-center rounded-full text-xs font-bold ring-2 ring-white" style={{ width: size, height: size, background: seqColor(v, max), color: max && v / max > 0.5 ? "#fff" : "#0f172a" }}>
              {v}
            </div>
            <div className="mt-1 rounded bg-white/90 px-1 text-[11px] font-semibold whitespace-nowrap text-slate-700">{z.name}</div>
            {hover === z.id && (
              <div className="absolute top-0 left-1/2 z-10 -translate-x-1/2 -translate-y-full rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white">
                ヒヤリハット {z.incidents}件（危険 {z.danger}）・タッチ {z.taps}件
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
