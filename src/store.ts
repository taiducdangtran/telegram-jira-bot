// Lớp truy cập KV: allowlist, config, quét theo prefix.

import type { Env, BotActionKind } from "./types";
import { safeParse, validateProjectKey } from "./util";

export function isAllowed(chatId: number | string | null | undefined, env: Env): boolean {
  const raw = (env.ALLOWED_CHAT_IDS || "").trim();
  if (!raw) return false; // chưa cấu hình -> KHOÁ (fail-closed); đặt ALLOWED_CHAT_IDS để mở
  return raw.split(",").map((s: string) => s.trim()).filter(Boolean).includes(String(chatId));
}

export async function getProjectKey(env: Env): Promise<string> {
  const key = (await env.BOT_KV.get("config:project_key")) || env.JIRA_PROJECT_KEY || "";
  return validateProjectKey(key) ? key : "";
}

// Nhớ chat admin gần nhất để cron/webhook có chỗ gửi nhắc.
// Chỉ ghi khi ĐỔI — KV free tier ~1.000 writes/ngày, ghi mỗi tin nhắn là phí quota.
export async function rememberOwnerChat(env: Env, chatId: number): Promise<void> {
  const cur = await env.BOT_KV.get("config:owner_chat");
  if (cur !== String(chatId)) await env.BOT_KV.put("config:owner_chat", String(chatId));
}

// Chat nhận thông báo chung (nhắc fallback, tin từ Jira webhook):
// owner_chat đã nhớ, không có thì lấy id đầu trong ALLOWED_CHAT_IDS.
export async function getOwnerChat(env: Env): Promise<string | null> {
  const cur = await env.BOT_KV.get("config:owner_chat");
  if (cur) return cur;
  const first = (env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

// Đánh dấu "bot vừa tự làm hành động này trên Jira" — webhook Jira dội về trong ~2'
// sẽ biết là echo để khỏi thông báo lại. Best-effort: KV cross-colo có thể trễ ~60s,
// hiếm lắm mới lọt 1 thông báo thừa — chấp nhận được.
export async function markBotAction(env: Env, issueKey: string, kind: BotActionKind): Promise<void> {
  await env.BOT_KV.put(`botaction:${issueKey}:${kind}`, "1", { expirationTtl: 120 });
}

export async function wasBotAction(env: Env, issueKey: string, kind: BotActionKind): Promise<boolean> {
  return !!(await env.BOT_KV.get(`botaction:${issueKey}:${kind}`));
}

// Gỡ cờ echo khi lệnh Jira FAIL — không gỡ thì 2 phút sau đó thao tác thật trên
// Jira UI sẽ bị nuốt thông báo (tệ nhất: đặt hạn tay trên Jira mà không có nhắc).
export async function clearBotAction(env: Env, issueKey: string, kind: BotActionKind): Promise<void> {
  await env.BOT_KV.delete(`botaction:${issueKey}:${kind}`);
}

// Lịch nhắc vừa thêm/đổi -> xoá hint quét để cron tick sau quét ngay (xem cron.ts).
export async function bumpSchedule(env: Env): Promise<void> {
  await env.BOT_KV.delete("idx:scan");
}

// Đọc mọi record theo prefix (có phân trang KV).
export async function loadByPrefix<T = any>(env: Env, prefix: string): Promise<(T & { _key: string })[]> {
  const out: (T & { _key: string })[] = [];
  let cursor: string | undefined;
  do {
    const page: any = await env.BOT_KV.list({ prefix, cursor });
    for (const k of page.keys) {
      const v = await env.BOT_KV.get(k.name);
      if (!v) continue;
      const rec = safeParse(v);
      if (rec) out.push({ ...rec, _key: k.name });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
