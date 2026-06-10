// Bộ não của bot: định tuyến message/command/callback và chạy nhắc lịch.

import { tg, escapeHtml as esc, taskButtons } from "./telegram";
import { jira } from "./jira";
import { parseTask } from "./ai";
import { offsetMin, nowVN, parseDueStrict, formatVN, ymd, isoFromMs, msFromVN } from "./time";

const HELP = `🤖 <b>Bot ghi việc → Jira</b>

<b>Ghi việc</b>
• Nhắn tự nhiên: "mai 3h chiều gọi khách A", "thứ 6 nộp báo cáo"
  → mình tạo issue + tự nhắc đúng giờ.
• /note &lt;việc&gt; — ghi nhanh, không hạn.
• /note &lt;việc&gt; // &lt;thời gian&gt; — ghi kèm hạn chính xác.
  vd: <code>/note Gọi khách A // 12/06 15:00</code>
• /list — xem việc đang chờ nhắc.

<b>Cài đặt</b>
• /projects — danh sách project Jira.
• /useproject &lt;KEY&gt; — chọn project để ghi (vd KAN).
• /whoami — xem chat id (để khoá bot cho riêng bạn).`;

function isAllowed(chatId: number | string, env: any): boolean {
  const raw = (env.ALLOWED_CHAT_IDS || "").trim();
  if (!raw) return false; // chưa cấu hình -> KHOÁ (fail-closed); đặt ALLOWED_CHAT_IDS để mở
  return raw.split(",").map((s: string) => s.trim()).filter(Boolean).includes(String(chatId));
}

async function getProjectKey(env: any): Promise<string> {
  return (await env.BOT_KV.get("config:project_key")) || env.JIRA_PROJECT_KEY || "";
}

// ---- Định tuyến update ----

export async function onUpdate(update: any, env: any): Promise<void> {
  if (update.callback_query) return onCallback(update.callback_query, env);

  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId = msg.chat.id;

  // Tin không phải chữ (ảnh, sticker, voice, file...). Bot chỉ xử lý chữ.
  if (typeof msg.text !== "string") {
    const isMedia =
      msg.photo || msg.sticker || msg.voice || msg.audio || msg.video ||
      msg.video_note || msg.document || msg.animation || msg.location ||
      msg.contact || msg.poll || msg.dice;
    // Chỉ nhắc khi là media thật của người được phép — tránh spam tin hệ thống (join/leave/pin).
    if (isMedia && isAllowed(chatId, env)) {
      await tg.sendMessage(env, chatId, "Mình chỉ xử lý tin nhắn chữ — nhắn nội dung việc nhé.");
    }
    return;
  }

  if (!isAllowed(chatId, env)) {
    const unset = !(env.ALLOWED_CHAT_IDS || "").trim();
    await tg.sendMessage(
      env,
      chatId,
      unset
        ? `🔒 Bot chưa cấu hình quyền dùng. Chat ID của bạn: <code>${chatId}</code>\nĐặt <code>ALLOWED_CHAT_IDS="${chatId}"</code> trong wrangler.jsonc rồi deploy lại.`
        : "⛔ Bạn không có quyền dùng bot này.",
    );
    return;
  }

  // Nhớ chat gần nhất để cron có chỗ gửi nhắc (fallback khi record thiếu chatId).
  await env.BOT_KV.put("config:owner_chat", String(chatId));

  const text = msg.text.trim();
  if (!text) {
    await tg.sendMessage(env, chatId, "Nhắn nội dung việc giúp mình nhé (gõ /help để xem cách dùng).");
    return;
  }
  if (text.startsWith("/")) return onCommand(text, chatId, env);
  return onNaturalText(text, chatId, env);
}

async function onCommand(text: string, chatId: number, env: any): Promise<void> {
  const sp = text.indexOf(" ");
  const cmd = (sp < 0 ? text : text.slice(0, sp)).toLowerCase().replace(/@.*$/, ""); // bỏ @tên_bot trong group
  const arg = sp < 0 ? "" : text.slice(sp + 1).trim();

  switch (cmd) {
    case "/start":
    case "/help":
      await tg.sendMessage(env, chatId, HELP);
      return;
    case "/whoami":
      await tg.sendMessage(env, chatId, `Chat ID của bạn: <code>${chatId}</code>`);
      return;
    case "/projects":
      return listProjects(chatId, env);
    case "/useproject":
      return useProject(arg, chatId, env);
    case "/note":
    case "/task":
      return noteCommand(arg, chatId, env);
    case "/list":
    case "/today":
      return listUpcoming(chatId, env);
    default:
      await tg.sendMessage(env, chatId, "Lệnh không rõ. Gõ /help để xem hướng dẫn.");
  }
}

async function listProjects(chatId: number, env: any): Promise<void> {
  try {
    const ps = await jira.projects(env);
    if (!ps.length) {
      await tg.sendMessage(env, chatId, "Không thấy project nào (kiểm tra quyền của API token).");
      return;
    }
    const shown = ps.slice(0, 50);
    const lines = shown.map((p: any) => `• <b>${esc(p.key)}</b> — ${esc(p.name)}`).join("\n");
    const more = ps.length > shown.length ? `\n… và ${ps.length - shown.length} project khác.` : "";
    await tg.sendMessage(env, chatId, `📋 Project Jira:\n${lines}${more}\n\nChọn: <code>/useproject KEY</code>`);
  } catch (e: any) {
    await tg.sendMessage(env, chatId, `❌ Lỗi tải project:\n<code>${esc(e.message).slice(0, 400)}</code>`);
  }
}

async function useProject(arg: string, chatId: number, env: any): Promise<void> {
  const key = arg.trim().toUpperCase();
  if (!key) {
    await tg.sendMessage(env, chatId, "Cú pháp: /useproject KEY  (vd /useproject KAN)");
    return;
  }
  const p = await jira.getProject(env, key);
  if (!p) {
    await tg.sendMessage(env, chatId, `Không tìm thấy project <b>${esc(key)}</b>. Gõ /projects để xem danh sách.`);
    return;
  }
  await env.BOT_KV.put("config:project_key", key);
  await tg.sendMessage(env, chatId, `✅ Đã chọn project <b>${esc(key)}</b> — ${esc(p.name)}.\nGiờ nhắn việc là mình tạo issue vào đây.`);
}

async function noteCommand(arg: string, chatId: number, env: any): Promise<void> {
  if (!arg) {
    await tg.sendMessage(env, chatId, "Cú pháp: /note &lt;việc&gt; [// &lt;thời gian&gt;]");
    return;
  }
  let title = arg;
  let dueISO: string | null = null;
  let warn = "";
  const idx = arg.indexOf("//");
  if (idx >= 0) {
    title = arg.slice(0, idx).trim();
    const dstr = arg.slice(idx + 2).trim();
    dueISO = parseDueStrict(dstr, offsetMin(env), nowVN(env));
    if (!dueISO) warn = "\n⚠️ Không hiểu phần thời gian, đã lưu không hạn.";
  }
  if (!title) {
    await tg.sendMessage(env, chatId, "Thiếu nội dung việc.");
    return;
  }
  await createTask(env, chatId, title, dueISO, warn);
}

async function onNaturalText(text: string, chatId: number, env: any): Promise<void> {
  const { title, dueISO } = await parseTask(text, env);
  await createTask(env, chatId, title, dueISO, "");
}

// ---- Tạo issue + lên lịch nhắc ----

async function createTask(env: any, chatId: number, title: string, dueISO: string | null, warn: string): Promise<void> {
  const projectKey = await getProjectKey(env);
  if (!projectKey) {
    await tg.sendMessage(env, chatId, "⚠️ Chưa chọn project Jira. Gõ /projects rồi /useproject KEY.");
    return;
  }
  // Jira summary tối đa 255 ký tự; gọn khoảng trắng + cắt để không bị Jira 400.
  title = String(title).replace(/\s+/g, " ").trim().slice(0, 250);
  if (!title) {
    await tg.sendMessage(env, chatId, "Thiếu nội dung việc.");
    return;
  }
  try {
    const dueYMD = dueISO ? ymd(dueISO, offsetMin(env)) : null;
    const issue = await jira.createIssue(env, projectKey, title, dueYMD);
    const url = jira.issueUrl(env, issue.key);

    let msg = `✅ Đã tạo: <b>${esc(title)}</b>\n🔖 ${esc(issue.key)}`;
    let extra: Record<string, unknown> = {};
    if (dueISO) {
      msg += `\n⏰ Hạn: ${esc(formatVN(dueISO, offsetMin(env)))} — mình sẽ nhắc bạn.`;
      // KV là nguồn sự thật cho GIỜ nhắc (Jira duedate chỉ có ngày).
      await env.BOT_KV.put(
        `due:${issue.key}`,
        JSON.stringify({ issueKey: issue.key, dueISO, chatId, summary: title, url, fired: false }),
      );
      extra = { reply_markup: taskButtons(issue.key) };
    }
    msg += `\n🔗 ${esc(url)}${warn || ""}`;
    await tg.sendMessage(env, chatId, msg, extra);
  } catch (e: any) {
    let hint = "";
    if (/issue\s*type|issuetype/i.test(e.message || "")) {
      const p = await jira.getProject(env, projectKey).catch(() => null);
      const types = (p?.issueTypes || []).map((t: any) => t.name).filter(Boolean);
      if (types.length) {
        hint = `\n\nLoại issue hợp lệ của project: ${esc(types.join(", "))}.\nSửa <code>JIRA_ISSUE_TYPE</code> trong wrangler.jsonc cho khớp rồi deploy lại.`;
      }
    }
    await tg.sendMessage(env, chatId, `❌ Lỗi tạo issue Jira:\n<code>${esc(e.message).slice(0, 500)}</code>${hint}`);
  }
}

async function listUpcoming(chatId: number, env: any): Promise<void> {
  const recs = await loadPendingReminders(env);
  if (!recs.length) {
    await tg.sendMessage(env, chatId, "Hiện chưa có việc nào đang chờ nhắc.");
    return;
  }
  recs.sort((a, b) => Date.parse(a.dueISO) - Date.parse(b.dueISO));
  const shown = recs.slice(0, 15);
  const lines = shown
    .map((r) => `• <b>${esc(r.summary.slice(0, 80))}</b>\n  ⏰ ${esc(formatVN(r.dueISO, offsetMin(env)))} • ${esc(r.issueKey)}`)
    .join("\n");
  const more = recs.length > shown.length ? `\n… và ${recs.length - shown.length} việc khác.` : "";
  await tg.sendMessage(env, chatId, `🗓 Việc sắp tới:\n${lines}${more}`);
}

// ---- Nút bấm (callback_query) ----

const DONE_RE = /done|hoàn thành|resolved|complete|đã xong|closed|xong|finish/i;

async function onCallback(cq: any, env: any): Promise<void> {
  const data: string = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  // Nút bấm cũng phải qua allowlist (đường này KHÔNG đi qua isAllowed của onUpdate).
  if (!isAllowed(chatId, env)) {
    await tg.answerCallback(env, cq.id, "⛔ Không có quyền.");
    return;
  }

  const [action, issueKey, extraArg] = data.split(":");

  try {
    if (action === "done") {
      const cur = await env.BOT_KV.get(`due:${issueKey}`);
      const rec = cur ? safeParse(cur) : null;
      const trs = await jira.transitions(env, issueKey);
      const t = trs.find((x: any) => DONE_RE.test(x.name));
      if (!t) {
        await tg.answerCallback(env, cq.id, "Không thấy trạng thái Done.");
        await tg.sendMessage(
          env,
          chatId,
          `Project chưa có trạng thái kiểu "Done". Các trạng thái chuyển được: ${esc(trs.map((x: any) => x.name).join(", ")) || "(không có)"}`,
        );
        return;
      }
      await jira.transition(env, issueKey, t.id);
      await env.BOT_KV.delete(`due:${issueKey}`);
      await tg.answerCallback(env, cq.id, `✅ ${issueKey} → ${t.name}`);
      if (chatId && messageId) {
        const label = rec?.summary ? esc(rec.summary) : esc(issueKey);
        // Gỡ nút để không bấm lại (hoãn nhầm) trên việc đã xong.
        await tg.editText(
          env,
          chatId,
          messageId,
          `✅ <b>Đã hoàn thành:</b> ${label}\n🔖 ${esc(issueKey)} → ${esc(t.name)}`,
          { reply_markup: { inline_keyboard: [] } },
        );
      }
      return;
    }

    if (action === "snooze" || action === "snmorn") {
      // Chỉ hoãn việc CÒN trong danh sách nhắc — không tự dựng lại record cho việc đã xong/đã xoá.
      const cur = await env.BOT_KV.get(`due:${issueKey}`);
      const rec = cur ? safeParse(cur) : null;
      if (!rec) {
        await tg.answerCallback(env, cq.id, "Việc này không còn trong danh sách nhắc.");
        return;
      }

      let newISO: string;
      if (action === "snooze") {
        let mins = parseInt(extraArg || "60", 10);
        if (!Number.isFinite(mins) || mins <= 0) mins = 60;
        newISO = isoFromMs(Date.now() + mins * 60000, offsetMin(env));
      } else {
        const n = nowVN(env);
        const ms = msFromVN(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 9, 0, offsetMin(env)) + 86400000;
        newISO = isoFromMs(ms, offsetMin(env));
      }

      rec.dueISO = newISO;
      rec.fired = false;
      await env.BOT_KV.put(`due:${issueKey}`, JSON.stringify(rec));
      try {
        const y = ymd(newISO, offsetMin(env));
        if (y) await jira.setDueDate(env, issueKey, y);
      } catch {
        /* set duedate là phụ; KV mới quyết định giờ nhắc */
      }
      await tg.answerCallback(env, cq.id, `⏰ Hoãn tới ${formatVN(newISO, offsetMin(env))}`);
      return;
    }

    await tg.answerCallback(env, cq.id, "");
  } catch (e: any) {
    await tg.answerCallback(env, cq.id, "Lỗi: " + String(e.message || "").slice(0, 150));
  }
}

// ---- Cron: quét KV và bắn nhắc ----

interface Reminder {
  issueKey: string;
  dueISO: string;
  chatId?: number | string;
  summary: string;
  url: string;
  fired?: boolean;
}

async function loadPendingReminders(env: any): Promise<Reminder[]> {
  const out: Reminder[] = [];
  let cursor: string | undefined;
  // KV.list phân trang 1000 key/lần — lặp cho chắc.
  do {
    const page: any = await env.BOT_KV.list({ prefix: "due:", cursor });
    for (const k of page.keys) {
      const v = await env.BOT_KV.get(k.name);
      if (!v) continue;
      const rec = safeParse(v);
      if (rec && !rec.fired) out.push(rec);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function runReminders(env: any): Promise<void> {
  const owner = await env.BOT_KV.get("config:owner_chat");
  const now = Date.now();
  const lead = (parseInt(env.REMINDER_LEAD_MINUTES || "0", 10) || 0) * 60000;

  let cursor: string | undefined;
  do {
    const page: any = await env.BOT_KV.list({ prefix: "due:", cursor });
    for (const k of page.keys) {
      const v = await env.BOT_KV.get(k.name);
      if (!v) continue;
      const rec: Reminder | null = safeParse(v);
      if (!rec || rec.fired) continue;

      const dueMs = Date.parse(rec.dueISO);
      if (Number.isNaN(dueMs)) continue;
      if (now < dueMs - lead) continue; // chưa tới giờ

      const target = rec.chatId || owner;
      if (!target) continue;

      try {
        const resp: any = await tg.sendMessage(
          env,
          target,
          `⏰ <b>Nhắc việc</b>\n📌 ${esc(rec.summary)}\n🔖 ${esc(rec.issueKey)} • hạn ${esc(formatVN(rec.dueISO, offsetMin(env)))}\n🔗 ${esc(rec.url)}`,
          { reply_markup: taskButtons(rec.issueKey) },
        );
        // Gửi hỏng (Telegram trả ok:false) -> để fired=false cho cron sau thử lại.
        if (!resp || resp.ok === false) {
          console.error("reminder send failed", rec.issueKey, resp);
          continue;
        }
        rec.fired = true;
        // Đã nhắc xong -> giữ thêm 14 ngày rồi tự xoá để KV không phình.
        await env.BOT_KV.put(k.name, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 14 });
      } catch (e) {
        // Cô lập lỗi từng record: 1 record hỏng không được chặn các record còn lại.
        console.error("reminder error", rec.issueKey, e);
        continue;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function safeParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
