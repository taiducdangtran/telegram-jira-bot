// Nhận webhook từ Jira (đăng ký ở Jira admin UI → Settings → System → WebHooks,
// URL: https://<worker>/jira-webhook?s=<JIRA_WEBHOOK_SECRET>, JQL: project = <KEY>,
// events: Issue updated + deleted — xem README mục "Đồng bộ Jira → Telegram").
//
// Issue Done/xoá/đổi hạn/đổi assignee TRÊN JIRA UI -> bot dọn nhắc trong KV + báo Telegram.
// Echo (chính bot vừa gây ra qua lệnh Telegram, đã markBotAction) -> chỉ dọn KV, KHÔNG báo lại.

import { tg, escapeHtml as esc } from "./telegram";
import { jira } from "./jira";
import { offsetMin, formatVN, hhmmVN, msFromVN, isoFromMs } from "./time";
import { getOwnerChat, getProjectKey, wasBotAction, bumpSchedule } from "./store";
import { findMember, notifyAssignment } from "./team";
import { safeParse } from "./util";
import type { Env, DueRecord } from "./types";

export async function onJiraWebhook(payload: any, env: Env): Promise<void> {
  const event: string = payload?.webhookEvent || "";
  const issue = payload?.issue;
  const key: string | undefined = issue?.key;
  if (!key) return;

  // Chỉ quan tâm project đang dùng (phòng JQL filter của webhook cấu hình sai/quên).
  const projectKey = await getProjectKey(env);
  if (!projectKey || !key.startsWith(projectKey + "-")) return;

  const summary: string = issue?.fields?.summary || key;
  const who: string = payload?.user?.displayName || "ai đó";
  const owner = await getOwnerChat(env);

  if (event === "jira:issue_deleted") {
    const had = await env.BOT_KV.get(`due:${key}`);
    if (had) await env.BOT_KV.delete(`due:${key}`);
    if (await wasBotAction(env, key, "delete")) return; // echo từ /delete của bot
    if (owner) {
      await tg.sendMessage(env, owner, `🗑️ <b>${esc(key)}</b> — "${esc(summary)}" đã bị xoá trên Jira (bởi ${esc(who)}).${had ? " Đã gỡ nhắc." : ""}`);
    }
    return;
  }

  if (event !== "jira:issue_updated") return;

  // Lọc field quan tâm TRƯỚC khi ghi dedup — project bận rộn sửa mô tả/label liên tục
  // mà mỗi event tốn 1 write KV thì phí quota (~1k writes/ngày).
  const items: any[] = Array.isArray(payload?.changelog?.items) ? payload.changelog.items : [];
  const relevant = items.filter((i) => /^(status|duedate|assignee)$/i.test(String(i?.field || "")));
  if (!relevant.length) return;

  // Dedup phụ theo changelog id — Jira có thể gửi lại cùng một event.
  const changelogId = payload?.changelog?.id;
  if (changelogId) {
    const dupKey = `processed:jw:${key}:${changelogId}`;
    if (await env.BOT_KV.get(dupKey)) return;
    await env.BOT_KV.put(dupKey, "1", { expirationTtl: 300 });
  }

  for (const item of relevant) {
    try {
      const field = String(item?.field || "").toLowerCase();
      if (field === "status") await onStatusChange(env, key, summary, who, issue, owner);
      else if (field === "duedate") await onDueChange(env, key, summary, item, owner);
      else if (field === "assignee") await onAssigneeChange(env, key, summary, item);
    } catch (e) {
      console.error("jira webhook item error", key, item?.field, e);
    }
  }
}

// Done nhận diện theo statusCategory.key === "done" — chịu được mọi tên cột
// ("Done", "Hoàn tất", "Closed"...). Reopen/chuyển cột thường: bỏ qua (không tự re-arm nhắc).
async function onStatusChange(env: Env, key: string, summary: string, who: string, issue: any, owner: string | null): Promise<void> {
  const catKey = issue?.fields?.status?.statusCategory?.key;
  if (catKey !== "done") return;
  const had = await env.BOT_KV.get(`due:${key}`);
  if (had) await env.BOT_KV.delete(`due:${key}`);
  if (await wasBotAction(env, key, "done")) return; // echo từ /done hoặc nút ✅ của bot
  if (owner) {
    await tg.sendMessage(env, owner, `✅ <b>${esc(key)}</b> — "${esc(summary)}" đã Done trên Jira (bởi ${esc(who)}).${had ? " Đã tắt nhắc." : ""}`);
  }
}

// Jira duedate chỉ có NGÀY. Giữ giờ-phút cũ từ KV record nếu có, không thì 09:00.
async function onDueChange(env: Env, key: string, summary: string, item: any, owner: string | null): Promise<void> {
  if (await wasBotAction(env, key, "due")) return; // bot vừa set (applyDue/snooze) — KV đã là nguồn sự thật
  const min = offsetMin(env);
  const newYMD: string | null = item?.to ? String(item.to).slice(0, 10) : null;
  const curRaw = await env.BOT_KV.get(`due:${key}`);
  const cur = curRaw ? (safeParse(curRaw) as DueRecord | null) : null;

  if (!newYMD) {
    // Hạn bị gỡ trên Jira -> tắt nhắc nếu đang có.
    if (cur) {
      await env.BOT_KV.delete(`due:${key}`);
      if (owner) await tg.sendMessage(env, owner, `⏰ <b>${esc(key)}</b>: hạn bị gỡ trên Jira — đã tắt nhắc.`);
    }
    return;
  }
  const m = newYMD.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return;
  const hhmm = (cur && hhmmVN(cur.dueISO, min)) || "09:00";
  const [h, mi] = hhmm.split(":").map(Number);
  const ms = msFromVN(+m[1], +m[2], +m[3], h, mi, min);
  const newISO = isoFromMs(ms, min);

  if (cur) {
    const next: DueRecord = { ...cur, dueISO: newISO, fired: false };
    delete next.firedAtMs; // mở lại nhắc cho hạn mới
    await env.BOT_KV.put(`due:${key}`, JSON.stringify(next));
    await bumpSchedule(env); // lịch đổi -> cron tick sau quét ngay
    if (owner) await tg.sendMessage(env, owner, `⏰ <b>${esc(key)}</b>: hạn đổi trên Jira → ${esc(formatVN(newISO, min))}. Đã cập nhật nhắc.`);
    return;
  }
  // Chưa có nhắc cho task này: tạo mới nếu mốc còn ở tương lai.
  if (!owner) return;
  if (ms > Date.now()) {
    const rec: DueRecord = { issueKey: key, dueISO: newISO, chatId: Number(owner), summary, url: jira.issueUrl(env, key), fired: false };
    await env.BOT_KV.put(`due:${key}`, JSON.stringify(rec));
    await bumpSchedule(env); // lịch mới -> cron tick sau quét ngay
    await tg.sendMessage(env, owner, `⏰ <b>${esc(key)}</b> — "${esc(summary)}": có hạn mới ${esc(formatVN(newISO, min))} (đặt trên Jira), mình sẽ nhắc.`);
  } else {
    await tg.sendMessage(env, owner, `⏰ <b>${esc(key)}</b> — "${esc(summary)}": hạn mới ${esc(formatVN(newISO, min))} đã qua, không đặt nhắc.`);
  }
}

// Giao việc trên Jira UI -> DM người trong /team (khớp theo accountId, fallback tên hiển thị).
// Không báo owner: chính admin vừa thao tác trên Jira rồi.
async function onAssigneeChange(env: Env, key: string, summary: string, item: any): Promise<void> {
  if (await wasBotAction(env, key, "assign")) return; // /assign của bot đã DM rồi — tránh DM đôi
  const accountId: string | null = item?.to ? String(item.to) : null;
  if (!accountId) return; // bỏ gán (unassign) -> thôi
  // Cẩn thận: "toString" là key dữ liệu của changelog Jira, nếu thiếu sẽ dính
  // Object.prototype.toString (function) -> phải check typeof.
  const displayName = typeof item?.toString === "string" ? item.toString : null;
  const member = await findMember(env, { accountId, name: displayName });
  if (!member) return;
  const resp: any = await notifyAssignment(env, member, key, summary, null);
  if (!resp || resp.ok === false) console.error("assignee DM failed", key, member.alias, resp);
}
