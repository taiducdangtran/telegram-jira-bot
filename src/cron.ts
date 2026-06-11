// Cron mỗi phút: bắn nhắc một-lần (due:*) và nhắc lặp (recur:*).
//
// QUOTA KV free: ~1.000 list ops/NGÀY — cron mỗi phút × 2 prefix = 2.880 là vượt,
// cuối ngày (giờ UTC) list fail và nhắc câm lặng. Cách xử lý ở đây:
//   1. Gộp 2 lần quét (due: + recur:) thành MỘT list walk.
//   2. Hint `idx:scan` ghi "mốc sớm nhất có thể tới hạn" — tick nào chưa thể có gì
//      thì khỏi quét (chỉ 1 read). Tạo/đổi lịch ở đâu cũng gọi bumpSchedule() xoá
//      hint -> tick sau quét ngay.
//   3. Lưới an toàn: hint cũ quá FORCE_RESCAN_MS vẫn ép quét — hint trôi/mất delete
//      thì tệ nhất nhắc trễ 10', không bao giờ mất hẳn.

import { tg, escapeHtml as esc, taskButtons, recurButtons } from "./telegram";
import { offsetMin, formatVN, nextDailyISO, nextWeeklyISO } from "./time";
import { safeParse } from "./util";
import type { Env, DueRecord, RecurRecord } from "./types";

// Đã bắn trong vòng 10' thì coi như bắn rồi — chống bắn TRÙNG khi write fired=true
// chưa kịp lan giữa các colo KV (eventual consistency ~60s mà cron lại chạy mỗi phút).
const FIRED_RECENT_MS = 10 * 60_000;
const FORCE_RESCAN_MS = 10 * 60_000;
const DUE_TTL = { expirationTtl: 60 * 60 * 24 * 14 } as const;

// Clamp REMINDER_LEAD_MINUTES vào [0, 1440] — giá trị lạ không làm nhắc sớm cả tuần.
function leadMs(env: Env): number {
  const m = parseInt(env.REMINDER_LEAD_MINUTES || "0", 10) || 0;
  return Math.max(0, Math.min(1440, m)) * 60000;
}

function firedRecently(r: DueRecord, now: number): boolean {
  return !!r.firedAtMs && now - r.firedAtMs < FIRED_RECENT_MS;
}

interface ScanHint {
  nextMs: number | null; // mốc sớm nhất có thể tới hạn; null = không có gì chờ
  scannedAtMs: number;
}

export async function runScheduled(env: Env): Promise<void> {
  const raw = await env.BOT_KV.get("idx:scan");
  const hint: ScanHint | null = raw ? safeParse(raw) : null;
  const now = Date.now();
  if (
    hint &&
    typeof hint.scannedAtMs === "number" &&
    now - hint.scannedAtMs < FORCE_RESCAN_MS &&
    (hint.nextMs == null || now < hint.nextMs - leadMs(env))
  ) {
    return; // chưa thể có gì tới hạn — khỏi tốn 1 list op
  }

  const { dues, recurs } = await loadSchedules(env);
  const owner = await env.BOT_KV.get("config:owner_chat");
  await fireDueReminders(env, dues, owner);
  await fireRecurring(env, recurs, owner);

  const next: ScanHint = { nextMs: computeNextMs(dues, recurs, Date.now()), scannedAtMs: Date.now() };
  await env.BOT_KV.put("idx:scan", JSON.stringify(next));
}

// MỘT list walk cho cả hai loại record (thay vì 2 lần loadByPrefix = 2 list ops).
async function loadSchedules(env: Env): Promise<{
  dues: (DueRecord & { _key: string })[];
  recurs: (RecurRecord & { _key: string })[];
}> {
  const dues: (DueRecord & { _key: string })[] = [];
  const recurs: (RecurRecord & { _key: string })[] = [];
  let cursor: string | undefined;
  do {
    const page: any = await env.BOT_KV.list({ cursor });
    for (const k of page.keys) {
      const isDue = k.name.startsWith("due:");
      const isRecur = k.name.startsWith("recur:");
      if (!isDue && !isRecur) continue;
      const v = await env.BOT_KV.get(k.name);
      if (!v) continue;
      const rec = safeParse(v);
      if (!rec) continue;
      if (isDue) dues.push({ ...rec, _key: k.name });
      else recurs.push({ ...rec, _key: k.name });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { dues, recurs };
}

async function fireDueReminders(env: Env, dues: (DueRecord & { _key: string })[], owner: string | null): Promise<void> {
  const now = Date.now();
  const lead = leadMs(env);

  for (const rec of dues) {
    if (rec.fired || firedRecently(rec, now)) continue;
    const dueMs = Date.parse(rec.dueISO);
    if (Number.isNaN(dueMs)) continue;
    if (now < dueMs - lead) continue; // chưa tới giờ

    const target = rec.chatId || owner;
    if (!target) continue;

    try {
      // Đọc lại bản MỚI NHẤT ngay trước khi bắn: list() có thể trả snapshot cũ,
      // record có thể vừa được done/xoá/snooze trong lúc quét.
      const curRaw = await env.BOT_KV.get(rec._key);
      if (!curRaw) {
        rec.fired = true; // đã xong/xoá — đánh dấu để tính hint cho đúng
        continue;
      }
      const cur = safeParse(curRaw) as DueRecord | null;
      if (!cur) continue;
      Object.assign(rec, cur); // đồng bộ bản trong RAM cho phần tính hint
      if (rec.fired || firedRecently(rec, Date.now())) continue;
      const curDueMs = Date.parse(rec.dueISO);
      if (Number.isNaN(curDueMs) || Date.now() < curDueMs - lead) continue; // vừa bị snooze/dời

      // Đánh dấu ĐÃ BẮN trước khi gửi: crash giữa chừng -> thà lỡ 1 nhắc (có log)
      // còn hơn nhắc trùng.
      const marked: DueRecord = { ...cur, fired: true, firedAtMs: Date.now() };
      await env.BOT_KV.put(rec._key, JSON.stringify(marked), DUE_TTL);

      const resp: any = await tg.sendMessage(
        env,
        target,
        `⏰ <b>Nhắc việc</b>\n📌 ${esc(rec.summary)}\n🔖 ${esc(rec.issueKey)} • hạn ${esc(formatVN(rec.dueISO, offsetMin(env)))}\n🔗 ${esc(rec.url)}`,
        { reply_markup: taskButtons(rec.issueKey) },
      );
      if (!resp || resp.ok === false) {
        const code = Number(resp?.error_code) || 0;
        if (code === 429 || code >= 500) {
          // Lỗi TẠM THỜI -> mở lại cờ nhưng GIỮ firedAtMs: tự throttle còn 1 lần/10',
          // và GIỮ TTL — không thành vòng lặp 2 write/phút đốt sạch quota.
          console.error("reminder send failed (transient), thử lại sau", rec.issueKey, JSON.stringify(resp));
          const revert: DueRecord = { ...marked, fired: false };
          await env.BOT_KV.put(rec._key, JSON.stringify(revert), DUE_TTL);
          Object.assign(rec, revert);
        } else {
          // Lỗi VĨNH VIỄN (403 bot bị chặn, 400 chat không tồn tại...) -> bỏ cuộc,
          // giữ fired=true. Revert ở đây = retry mỗi phút mãi mãi = chết quota KV.
          console.error("reminder send failed (permanent), bỏ qua", rec.issueKey, JSON.stringify(resp));
          Object.assign(rec, marked);
        }
        continue;
      }
      Object.assign(rec, marked);
      // Nếu sendMessage THROW (timeout mơ hồ — có thể đã gửi) thì GIỮ fired=true,
      // chấp nhận rủi ro lỡ nhắc thay vì nhắc trùng; log ở catch dưới để truy lại.
    } catch (e) {
      console.error("reminder error", rec.issueKey, e);
      continue; // cô lập lỗi từng record
    }
  }
}

async function fireRecurring(env: Env, recurs: (RecurRecord & { _key: string })[], owner: string | null): Promise<void> {
  const now = Date.now();

  for (const rec of recurs) {
    if (!rec.nextISO) continue;
    const ms = Date.parse(rec.nextISO);
    if (Number.isNaN(ms)) continue;
    if (now < ms) continue;

    const target = rec.chatId || owner;
    if (!target) continue;

    try {
      const resp: any = await tg.sendMessage(
        env,
        target,
        `🔁 <b>Nhắc lặp</b>\n📌 ${esc(rec.text)}`,
        { reply_markup: recurButtons(rec.id) },
      );
      const failed = !resp || resp.ok === false;
      if (failed) {
        const code = Number(resp?.error_code) || 0;
        if (code === 429 || code >= 500) {
          console.error("recur send failed (transient), thử lại sau", rec.id, JSON.stringify(resp));
          continue; // giữ nextISO quá khứ -> tick sau thử lại
        }
        // Lỗi vĩnh viễn: bỏ lần này, vẫn dời lịch — không thì quét/retry mỗi phút mãi.
        console.error("recur send failed (permanent), bỏ lần này", rec.id, JSON.stringify(resp));
      }
      // Dời sang lần kế tiếp ở tương lai (không "đuổi" bù các lần đã lỡ).
      rec.nextISO = rec.kind === "daily" ? nextDailyISO(rec.time, env) : nextWeeklyISO(rec.dow!, rec.time, env);
      const out: Record<string, unknown> = { ...rec };
      delete out._key;
      await env.BOT_KV.put(rec._key, JSON.stringify(out));
    } catch (e) {
      console.error("recur error", rec.id, e);
      continue;
    }
  }
}

// Mốc sớm nhất có thể tới hạn sau lần quét này (cho hint).
function computeNextMs(dues: DueRecord[], recurs: RecurRecord[], now: number): number | null {
  let next: number | null = null;
  const cand = (ms: number) => {
    if (Number.isNaN(ms)) return;
    if (next == null || ms < next) next = ms;
  };
  for (const r of dues) {
    if (r.fired) continue;
    const due = Date.parse(r.dueISO);
    if (Number.isNaN(due)) continue;
    // Đang trong cửa sổ throttle (revert tạm thời) -> lần thử kế là hết cửa sổ.
    if (r.firedAtMs && now - r.firedAtMs < FIRED_RECENT_MS) cand(r.firedAtMs + FIRED_RECENT_MS);
    else cand(due);
  }
  for (const r of recurs) {
    if (r.nextISO) cand(Date.parse(r.nextISO));
  }
  return next;
}
