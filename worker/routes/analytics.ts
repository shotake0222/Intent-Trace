// 分析（ヒートマップ・所要時間）と元請け向けレポート出力
import { createRouter } from "../lib/app";
import { assertFeature } from "../lib/platform";
import { requireAuth, requireRole } from "../lib/auth";

const r = createRouter();
r.use("*", requireAuth, requireRole("admin", "manager"));

// 現状はJSTで集計（サイト別タイムゾーンは将来対応）
const TZ = "'+9 hours'";

function params(c: { req: { query: (k: string) => string | undefined } }) {
  const to = Number(c.req.query("to") ?? Date.now());
  const from = Number(c.req.query("from") ?? to - 30 * 86400_000);
  const siteId = c.req.query("siteId") ?? null;
  return { from, to, siteId };
}

const requirePro = (env: Env, orgId: string) => assertFeature(env, orgId, "analytics", "ヒートマップ・所要時間分析");

r.get("/summary", async (c) => {
  const u = c.get("user");
  const { from, to, siteId } = params(c);
  const q = <T>(sql: string) => c.env.DB.prepare(sql).bind(u.orgId, from, to, siteId, siteId).first<T>();
  const [taps, insp, inc, patrol, alerts] = await Promise.all([
    q<{ n: number; high: number; offline: number; users: number }>(
      `SELECT COUNT(*) n, SUM(assurance='high') high, SUM(offline) offline, COUNT(DISTINCT user_id) users FROM tap_events WHERE org_id=? AND occurred_at BETWEEN ? AND ? AND (? IS NULL OR site_id=?)`
    ),
    q<{ n: number; ng: number; avg_sec: number | null }>(
      `SELECT COUNT(*) n, SUM(result!='ok') ng, AVG(CASE WHEN started_at IS NOT NULL THEN (completed_at-started_at)/1000.0 END) avg_sec FROM inspections WHERE org_id=? AND completed_at BETWEEN ? AND ? AND (? IS NULL OR site_id=?)`
    ),
    q<{ n: number; danger: number; ble: number }>(
      `SELECT COUNT(*) n, SUM(severity='danger') danger, SUM(source='ble') ble FROM incidents WHERE org_id=? AND occurred_at BETWEEN ? AND ? AND (? IS NULL OR site_id=?)`
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) n, SUM(r.status='completed') completed FROM patrol_runs r JOIN patrol_routes pr ON pr.id=r.route_id WHERE r.org_id=? AND r.started_at BETWEEN ? AND ? AND (? IS NULL OR pr.site_id=?)`
    )
      .bind(u.orgId, from, to, siteId, siteId)
      .first<{ n: number; completed: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n, SUM(severity='danger') danger FROM alerts WHERE org_id=? AND acked_at IS NULL AND (? IS NULL OR site_id=?)")
      .bind(u.orgId, siteId, siteId)
      .first<{ n: number; danger: number }>()
  ]);
  // 点検期限切れ設備
  const { results: overdue } = await c.env.DB.prepare(
    `SELECT e.id, e.name, e.inspection_interval_days, MAX(i.completed_at) last
       FROM equipment e LEFT JOIN inspections i ON i.equipment_id=e.id
      WHERE e.org_id=? AND e.inspection_interval_days IS NOT NULL AND (? IS NULL OR e.site_id=?)
      GROUP BY e.id HAVING last IS NULL OR last + e.inspection_interval_days*86400000 < ?`
  )
    .bind(u.orgId, siteId, siteId, Date.now())
    .all();
  const { results: daily } = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', occurred_at/1000, 'unixepoch', ${TZ}) d, COUNT(*) taps FROM tap_events
      WHERE org_id=? AND occurred_at BETWEEN ? AND ? AND (? IS NULL OR site_id=?) GROUP BY d ORDER BY d`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all<{ d: string; taps: number }>();
  const { results: dailyInc } = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', occurred_at/1000, 'unixepoch', ${TZ}) d, COUNT(*) n FROM incidents
      WHERE org_id=? AND occurred_at BETWEEN ? AND ? AND (? IS NULL OR site_id=?) GROUP BY d ORDER BY d`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all<{ d: string; n: number }>();
  const incMap = new Map(dailyInc.map((x) => [x.d, x.n]));
  const days = new Set([...daily.map((x) => x.d), ...dailyInc.map((x) => x.d)]);
  return c.json({
    from,
    to,
    taps: { total: taps?.n ?? 0, highAssurance: taps?.high ?? 0, offline: taps?.offline ?? 0, activeUsers: taps?.users ?? 0 },
    inspections: { total: insp?.n ?? 0, ng: insp?.ng ?? 0, avgDurationSec: insp?.avg_sec ?? null },
    incidents: { total: inc?.n ?? 0, danger: inc?.danger ?? 0, ble: inc?.ble ?? 0 },
    patrols: { total: patrol?.n ?? 0, completed: patrol?.completed ?? 0 },
    openAlerts: { total: alerts?.n ?? 0, danger: alerts?.danger ?? 0 },
    overdueEquipment: overdue,
    daily: [...days].sort().map((d) => ({ date: d, taps: daily.find((x) => x.d === d)?.taps ?? 0, incidents: incMap.get(d) ?? 0 }))
  });
});

/** 「誰が・いつ・どこで」ヒヤリハットを起こしたか：ゾーン × 時間帯のヒートマップ（Pro） */
r.get("/heatmap", async (c) => {
  const u = c.get("user");
  await requirePro(c.env, u.orgId);
  const { from, to, siteId } = params(c);
  const { results: zoneRows } = await c.env.DB.prepare(
    `SELECT z.id, z.name, z.floor, z.pos_x, z.pos_y,
            (SELECT COUNT(*) FROM incidents i WHERE i.zone_id=z.id AND i.occurred_at BETWEEN ?2 AND ?3) incidents,
            (SELECT COUNT(*) FROM incidents i WHERE i.zone_id=z.id AND i.severity='danger' AND i.occurred_at BETWEEN ?2 AND ?3) danger,
            (SELECT COUNT(*) FROM tap_events t WHERE t.zone_id=z.id AND t.occurred_at BETWEEN ?2 AND ?3) taps
       FROM zones z JOIN sites s ON s.id=z.site_id WHERE s.org_id=?1 AND (?4 IS NULL OR z.site_id=?4) ORDER BY z.floor, z.name`
  )
    .bind(u.orgId, from, to, siteId)
    .all();
  // 設備（BLE受信機）単位の接近件数
  const { results: equipmentRows } = await c.env.DB.prepare(
    `SELECT e.id, e.name, COUNT(i.id) incidents, SUM(i.severity='danger') danger, MIN(i.distance_m) min_distance
       FROM incidents i JOIN equipment e ON e.id=i.equipment_id
      WHERE i.org_id=? AND i.occurred_at BETWEEN ? AND ? AND (? IS NULL OR i.site_id=?) GROUP BY e.id ORDER BY incidents DESC LIMIT 20`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all();
  // 曜日 × 時間帯
  const { results: matrix } = await c.env.DB.prepare(
    `SELECT CAST(strftime('%w', occurred_at/1000, 'unixepoch', ${TZ}) AS INTEGER) dow,
            CAST(strftime('%H', occurred_at/1000, 'unixepoch', ${TZ}) AS INTEGER) hour, COUNT(*) n
       FROM incidents WHERE org_id=? AND occurred_at BETWEEN ? AND ? AND (? IS NULL OR site_id=?) GROUP BY dow, hour`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all<{ dow: number; hour: number; n: number }>();
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  for (const m of matrix) grid[m.dow][m.hour] = m.n;
  // 人別
  const { results: byUser } = await c.env.DB.prepare(
    `SELECT us.id, us.name, COUNT(*) incidents, SUM(i.severity='danger') danger, SUM(i.source='ble') ble
       FROM incidents i JOIN users us ON us.id=i.user_id
      WHERE i.org_id=? AND i.occurred_at BETWEEN ? AND ? AND (? IS NULL OR i.site_id=?) GROUP BY us.id ORDER BY incidents DESC LIMIT 20`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all();
  return c.json({ zones: zoneRows, equipment: equipmentRows, dowHour: grid, byUser });
});

/** どの設備の点検に時間がかかっているか（Pro） */
r.get("/inspection-durations", async (c) => {
  const u = c.get("user");
  await requirePro(c.env, u.orgId);
  const { from, to, siteId } = params(c);
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.name, e.category, COUNT(i.id) n,
            AVG((i.completed_at - i.started_at)/1000.0) avg_sec,
            MAX((i.completed_at - i.started_at)/1000.0) max_sec,
            SUM(i.result != 'ok') ng
       FROM inspections i JOIN equipment e ON e.id = i.equipment_id
      WHERE i.org_id=? AND i.completed_at BETWEEN ? AND ? AND (? IS NULL OR i.site_id=?) AND i.started_at IS NOT NULL
      GROUP BY e.id ORDER BY avg_sec DESC LIMIT 50`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all();
  return c.json(results);
});

export default r;
