// Bộ não của bot: định tuyến message/command/callback, tạo issue, nhắc một-lần & nhắc-lặp.

import { tg, escapeHtml as esc, taskButtons, recurButtons } from "./telegram";
import { jira } from "./jira";
import { parseTask } from "./ai";
import {
  offsetMin, nowVN, parseDueStrict, formatVN, ymd, isoFromMs, msFromVN,
  hhmmVN, nextDailyISO, nextWeeklyISO, parseDow, dowNameVN, parseRelative,
} from "./time";

const p2 = (n: number) => String(n).padStart(2, "0");

const HELP = `🤖 <b>Bot quản lý việc → Jira</b>

<b>Ghi việc</b>
• Nhắn tự nhiên: "mai 3h chiều gọi khách A", "30 phút nữa gọi shipper", "nộp báo cáo gấp #sales"
  → tạo issue + tự nhắc. "gấp/khẩn" → priority; <code>#tag</code> → nhãn.
• /note &lt;việc&gt; [// &lt;thời gian&gt;] — ghi tất định (không cần AI).

<b>Xem & sửa việc</b>
• /todo — liệt kê task tồn đọng (chưa Done). Hỏi "có task nào chưa làm?" cũng được.
• /list — việc một-lần đang chờ nhắc (theo giờ).
• /assign KAN-12 me — giao việc (hoặc &lt;tên&gt;).
• /due KAN-12 &lt;giờ&gt; — đặt/đổi hạn (kèm nhắc). vd <code>/due KAN-12 30 phút nữa</code>.
• /prio KAN-12 cao — đổi ưu tiên (cao nhất/cao/trung bình/thấp/thấp nhất).

<b>Nhắc lặp 🔁</b>
• /daily HH:MM &lt;việc&gt; · /weekly &lt;t2..t7|cn&gt; HH:MM &lt;việc&gt; · "mỗi ngày 8h ..."
• /recurring — xem · /stoprecur &lt;id&gt; — gỡ.

<b>Hoàn thành ✅ / Xoá 🗑️</b>
• Xong: nút ✅, hoặc /done KAN-12, hoặc <b>reply</b> tin rồi gõ <code>/done</code> (hay "xong").
• Xoá hẳn: /delete KAN-12, hoặc nhắn <code>xoá KAN-12</code> (xoá Jira là vĩnh viễn).

<b>Cài đặt</b>
• /projects · /useproject &lt;KEY&gt; · /whoami`;

const DONE_RE = /done|hoàn thành|resolved|complete|đã xong|closed|xong|finish/i;
const DONE_WORD_RE = /^(xong|done|hoàn thành|đã xong|hoàn tất|ok xong)\b/i;
const DELETE_WORD_RE = /(xoá|xóa|huỷ|hủy|delete|remove|gỡ task|gỡ việc)/i;

function isAllowed(chatId: number | string, env: any): boolean {
  const raw = (env.ALLOWED_CHAT_IDS || "").trim();
  if (!raw) return false; // chưa cấu hình -> KHOÁ (fail-closed); đặt ALLOWED_CHAT_IDS để mở
  return raw.split(",").map((s: string) => s.trim()).filter(Boolean).includes(String(chatId));
}

async function getProjectKey(env: any): Promise<string> {
  return (await env.BOT_KV.get("config:project_key")) || env.JIRA_PROJECT_KEY || "";
}

function safeParse(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}

// #hashtag -> labels (Jira label không có dấu cách); trả về text đã gỡ tag.
function extractLabels(text: string): { labels: string[]; text: string } {
  const labels: string[] = [];
  const cleaned = String(text).replace(/(^|\s)#([\p{L}\d_]{1,50})/gu, (_m, sp, tag) => {
    labels.push(tag);
    return sp;
  });
  return { labels, text: cleaned.replace(/\s+/g, " ").trim() };
}

// Đoán priority từ từ khoá tiếng Việt (dùng cho /note; đường AI tự đoán riêng).
function detectPriority(text: string): string | null {
  const t = String(text).toLowerCase();
  if (/khẩn cấp|rất gấp|cực gấp|gấp lắm|urgent|asap/.test(t)) return "Highest";
  if (/\bgấp\b|khẩn|ưu tiên cao|quan trọng/.test(t)) return "High";
  if (/ưu tiên thấp|không gấp|thong thả|từ từ|lúc nào cũng được/.test(t)) return "Low";
  return null;
}

function extractIssueKey(text: string | undefined): string | null {
  if (!text) return null;
  const m = String(text).match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : null;
}

// Câu hỏi/tra cứu việc ("có task nào tồn đọng không?") -> nên LIỆT KÊ, không tạo task.
function looksLikeQuery(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^(tạo|thêm|ghi|nhắc|add|new)\b/.test(t)) return false; // rõ ràng là tạo việc
  const taskWord = /(task|việc|cần làm|tồn đọng|chưa (làm|xong|hoàn)|đang làm|deadline|hạn chót|to-?do|đầu việc)/.test(t);
  const question =
    /\?\s*$/.test(t) ||
    /(không|chưa)\s*\??$/.test(t) ||
    /^(có |còn |bao nhiêu|mấy |liệt kê|xem |cho .*xem|thống kê|danh sách|list\b|show\b)/.test(t);
  return taskWord && question;
}

// Chào hỏi / xác nhận ngắn -> không phải task.
function looksLikeGreeting(text: string): boolean {
  const t = text.trim();
  return t.length <= 20 && /^(hi|hello|hey|chào|chao|alo|ok|oke|okê|okay|cảm ơn|cám ơn|thanks?|tks|ừ|uh|ờ|vâng|dạ|yes|yeah)\b/i.test(t);
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
  if (text.startsWith("/")) return onCommand(text, chatId, env, msg);
  return onNaturalText(text, chatId, env, msg);
}

async function onCommand(text: string, chatId: number, env: any, msg: any): Promise<void> {
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
    case "/todo":
    case "/pending":
      return listPending(chatId, env);
    case "/assign":
      return assignCommand(arg, chatId, env);
    case "/due":
      return dueCommand(arg, chatId, env);
    case "/prio":
    case "/priority":
      return prioCommand(arg, chatId, env);
    case "/daily":
      return dailyCommand(arg, chatId, env);
    case "/weekly":
      return weeklyCommand(arg, chatId, env);
    case "/recurring":
      return listRecurring(chatId, env);
    case "/stoprecur":
      return stopRecurCommand(arg, chatId, env);
    case "/done":
      return doneCommand(arg, chatId, env, msg);
    case "/delete":
    case "/xoa":
    case "/xoá": {
      const key = extractIssueKey(arg) || extractIssueKey(msg?.reply_to_message?.text);
      if (!key) {
        await tg.sendMessage(env, chatId, "Cú pháp: /delete KAN-12 (hoặc reply tin có mã việc rồi gõ /delete).");
        return;
      }
      return deleteTask(env, chatId, key);
    }
    default:
      await tg.sendMessage(env, chatId, "Lệnh không rõ. Gõ /help để xem hướng dẫn.");
  }
}

// ---- Project setup ----

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

// ---- Tạo issue (một-lần) ----

async function noteCommand(arg: string, chatId: number, env: any): Promise<void> {
  if (!arg) {
    await tg.sendMessage(env, chatId, "Cú pháp: /note &lt;việc&gt; [// &lt;thời gian&gt;]");
    return;
  }
  let body = arg;
  let dueISO: string | null = null;
  let warn = "";
  const idx = arg.indexOf("//");
  if (idx >= 0) {
    body = arg.slice(0, idx).trim();
    const dstr = arg.slice(idx + 2).trim();
    dueISO = parseDueStrict(dstr, offsetMin(env), nowVN(env));
    if (!dueISO) warn = "\n⚠️ Không hiểu phần thời gian, đã lưu không hạn.";
  }
  const { labels, text } = extractLabels(body);
  const priority = detectPriority(body);
  if (!text) {
    await tg.sendMessage(env, chatId, "Thiếu nội dung việc.");
    return;
  }
  await createTask(env, chatId, text, dueISO, warn, { priority, labels });
}

async function onNaturalText(text: string, chatId: number, env: any, msg: any): Promise<void> {
  // 1. Reply "xong/done" vào tin có mã việc -> hoàn thành.
  if (msg?.reply_to_message?.text && DONE_WORD_RE.test(text)) {
    const key = extractIssueKey(msg.reply_to_message.text);
    if (key) {
      const name = await transitionDone(env, chatId, key);
      if (name) await tg.sendMessage(env, chatId, `✅ <b>Đã hoàn thành:</b> ${esc(key)} → ${esc(name)}`);
      return;
    }
  }

  // 2. Xoá/huỷ task: "xoá KAN-105" hoặc reply tin có mã việc + "xoá".
  //    Chỉ kích hoạt khi có mã việc cụ thể và không phải câu "tạo/thêm/ghi".
  if (DELETE_WORD_RE.test(text) && !/^(tạo|thêm|ghi)\b/i.test(text)) {
    const key = extractIssueKey(text) || extractIssueKey(msg?.reply_to_message?.text);
    if (key) return deleteTask(env, chatId, key);
  }

  // 3. Chỉ chào hỏi -> gợi ý, KHÔNG tạo task.
  if (looksLikeGreeting(text)) {
    await tg.sendMessage(env, chatId, "👋 Nhắn nội dung việc để mình tạo task, gõ /todo để xem việc tồn đọng, hoặc /help.");
    return;
  }

  // 3. Câu hỏi/tra cứu -> liệt kê việc tồn đọng (đừng biến câu hỏi thành task).
  if (looksLikeQuery(text)) return listPending(chatId, env);

  // 4. Nhắc lặp tự nhiên: "mỗi ngày 8h uống thuốc".
  if (/(mỗi|hằng|hàng)\s*ngày/i.test(text)) {
    const cleaned = text.replace(/(mỗi|hằng|hàng)\s*ngày/gi, " ").replace(/\s+/g, " ").trim();
    const { text: noTags } = extractLabels(cleaned);
    const parsed = await parseTask(noTags, env);
    const time = (parsed.dueISO && hhmmVN(parsed.dueISO, offsetMin(env))) || "09:00";
    await createRecur(env, chatId, { kind: "daily", time, text: parsed.title });
    return;
  }

  // 5. "X phút/giờ nữa" -> hạn tương đối (xử lý tất định, không phụ thuộc AI).
  const rel = parseRelative(text, env);
  const base = rel ? rel.text : text;
  const { labels, text: noTags } = extractLabels(base);
  const parsed = await parseTask(noTags, env);

  // AI nhận diện ý định (lưới đỡ thêm cho heuristic ở trên).
  if (parsed.action === "query") return listPending(chatId, env);
  if (parsed.action === "chat") {
    await tg.sendMessage(env, chatId, "Mình chưa rõ ý. Nhắn nội dung việc để tạo task, hoặc /todo để xem việc đang có.");
    return;
  }

  const dueISO = rel?.dueISO || parsed.dueISO;
  const priority = parsed.priority || detectPriority(text);
  await createTask(env, chatId, parsed.title, dueISO, "", { priority, labels });
}

async function createTask(
  env: any,
  chatId: number,
  title: string,
  dueISO: string | null,
  warn: string,
  opts: { priority?: string | null; labels?: string[] } = {},
): Promise<void> {
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
  const priority = opts.priority || null;
  const labels = (opts.labels || []).slice(0, 10);

  try {
    const dueYMD = dueISO ? ymd(dueISO, offsetMin(env)) : null;
    const dropped: string[] = [];
    let issue: any;
    try {
      issue = await jira.createIssue(env, projectKey, title, dueYMD, { priority, labels });
    } catch (e: any) {
      // Project next-gen có thể không bật field priority/labels -> bỏ field lỗi rồi thử lại 1 lần.
      if ((priority || labels.length) && /priority|labels/i.test(e.message || "")) {
        const keepPriority = !/priority/i.test(e.message);
        const keepLabels = !/labels/i.test(e.message);
        if (!keepPriority && priority) dropped.push("priority");
        if (!keepLabels && labels.length) dropped.push("nhãn");
        issue = await jira.createIssue(env, projectKey, title, dueYMD, {
          priority: keepPriority ? priority : null,
          labels: keepLabels ? labels : [],
        });
      } else {
        throw e;
      }
    }

    const url = jira.issueUrl(env, issue.key);
    let head = `✅ Đã tạo: <b>${esc(title)}</b>\n🔖 ${esc(issue.key)}`;
    if (priority && !dropped.includes("priority")) head += ` • ⚑ ${esc(priority)}`;
    if (labels.length && !dropped.includes("nhãn")) head += ` • 🏷 ${esc(labels.join(", "))}`;

    let extra: Record<string, unknown> = {};
    if (dueISO) {
      head += `\n⏰ Hạn: ${esc(formatVN(dueISO, offsetMin(env)))} — mình sẽ nhắc bạn.`;
      await env.BOT_KV.put(
        `due:${issue.key}`,
        JSON.stringify({ issueKey: issue.key, dueISO, chatId, summary: title, url, fired: false }),
      );
      extra = { reply_markup: taskButtons(issue.key) };
    }
    if (dropped.length) warn = (warn || "") + `\n⚠️ Project không hỗ trợ ${dropped.join(" & ")}, đã bỏ qua.`;
    head += `\n🔗 ${esc(url)}${warn || ""}`;
    await tg.sendMessage(env, chatId, head, extra);
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
  const recs = await loadByPrefix(env, "due:");
  const pending = recs.filter((r) => !r.fired);
  if (!pending.length) {
    await tg.sendMessage(env, chatId, "Hiện chưa có việc nào đang chờ nhắc.");
    return;
  }
  pending.sort((a, b) => Date.parse(a.dueISO) - Date.parse(b.dueISO));
  const shown = pending.slice(0, 15);
  const lines = shown
    .map((r) => `• <b>${esc(r.summary.slice(0, 80))}</b>\n  ⏰ ${esc(formatVN(r.dueISO, offsetMin(env)))} • ${esc(r.issueKey)}`)
    .join("\n");
  const more = pending.length > shown.length ? `\n… và ${pending.length - shown.length} việc khác.` : "";
  await tg.sendMessage(env, chatId, `🗓 Việc sắp tới:\n${lines}${more}`);
}

// ---- Tra cứu (query) & sửa task cũ ----

async function listPending(chatId: number, env: any): Promise<void> {
  const projectKey = await getProjectKey(env);
  if (!projectKey) {
    await tg.sendMessage(env, chatId, "⚠️ Chưa chọn project Jira. Gõ /projects rồi /useproject KEY.");
    return;
  }
  try {
    const jql = `project = "${projectKey}" AND statusCategory != Done ORDER BY duedate ASC, created DESC`;
    const issues = await jira.searchJQL(env, jql, ["summary", "status", "assignee", "duedate", "priority"], 20);
    if (!issues.length) {
      await tg.sendMessage(env, chatId, "🎉 Không có task nào đang tồn đọng.");
      return;
    }
    const lines = issues
      .map((i: any) => {
        const f = i.fields || {};
        const who = f.assignee?.displayName ? `👤 ${esc(f.assignee.displayName)}` : "👤 chưa giao";
        const due = f.duedate ? ` · ⏰ ${esc(f.duedate)}` : "";
        const prio = f.priority?.name && f.priority.name !== "Medium" ? ` · ⚑ ${esc(f.priority.name)}` : "";
        return `• <b>${esc(i.key)}</b> — ${esc(String(f.summary || "").slice(0, 60))}\n  ${esc(f.status?.name || "?")} · ${who}${due}${prio}`;
      })
      .join("\n");
    await tg.sendMessage(
      env,
      chatId,
      `📋 <b>Task tồn đọng</b> (${issues.length}):\n${lines}\n\n<i>Sửa:</i> /assign KEY ai · /due KEY giờ · /prio KEY mức · /done KEY`,
    );
  } catch (e: any) {
    await tg.sendMessage(env, chatId, `❌ Lỗi tra task:\n<code>${esc(e.message).slice(0, 400)}</code>`);
  }
}

async function assignCommand(arg: string, chatId: number, env: any): Promise<void> {
  const key = extractIssueKey(arg);
  const who = key ? arg.replace(key, "").trim() : "";
  if (!key || !who) {
    await tg.sendMessage(env, chatId, "Cú pháp: /assign KAN-12 me  (hoặc /assign KAN-12 &lt;tên&gt;)");
    return;
  }
  try {
    let accountId: string, name: string;
    if (/^(me|tôi|toi|mình|minh|tui|t)$/i.test(who)) {
      const m = await jira.myself(env);
      accountId = m.accountId;
      name = m.displayName || "bạn";
    } else {
      const us = await jira.searchAssignable(env, await getProjectKey(env), who);
      if (!us.length) {
        await tg.sendMessage(env, chatId, `Không tìm thấy ai tên "${esc(who)}". Thử <code>/assign ${esc(key)} me</code> để giao cho bạn.`);
        return;
      }
      accountId = us[0].accountId;
      name = us[0].displayName;
    }
    await jira.assign(env, key, accountId);
    await tg.sendMessage(env, chatId, `✅ Đã giao <b>${esc(key)}</b> cho ${esc(name)}.`);
  } catch (e: any) {
    await tg.sendMessage(env, chatId, `❌ Lỗi giao việc:\n<code>${esc(e.message).slice(0, 300)}</code>`);
  }
}

async function dueCommand(arg: string, chatId: number, env: any): Promise<void> {
  const key = extractIssueKey(arg);
  const dstr = key ? arg.replace(key, "").trim() : "";
  if (!key || !dstr) {
    await tg.sendMessage(env, chatId, "Cú pháp: /due KAN-12 &lt;thời gian&gt;\nvd: <code>/due KAN-12 12/06 15:00</code> hoặc <code>/due KAN-12 30 phút nữa</code>");
    return;
  }
  const rel = parseRelative(dstr, env);
  const dueISO = rel?.dueISO || parseDueStrict(dstr, offsetMin(env), nowVN(env));
  if (!dueISO) {
    await tg.sendMessage(env, chatId, "Không hiểu thời gian. vd: 12/06 15:00, 9h30, hoặc '30 phút nữa'.");
    return;
  }
  try {
    const y = ymd(dueISO, offsetMin(env));
    if (y) await jira.setDueDate(env, key, y);
    let summary = key;
    try {
      summary = (await jira.getIssueFields(env, key, ["summary"]))?.fields?.summary || key;
    } catch {
      /* không lấy được summary thì dùng key */
    }
    await env.BOT_KV.put(
      `due:${key}`,
      JSON.stringify({ issueKey: key, dueISO, chatId, summary, url: jira.issueUrl(env, key), fired: false }),
    );
    await tg.sendMessage(
      env,
      chatId,
      `✅ Đặt hạn <b>${esc(key)}</b>: ${esc(formatVN(dueISO, offsetMin(env)))} — mình sẽ nhắc.`,
      { reply_markup: taskButtons(key) },
    );
  } catch (e: any) {
    await tg.sendMessage(env, chatId, `❌ Lỗi đặt hạn:\n<code>${esc(e.message).slice(0, 300)}</code>`);
  }
}

// Thứ tự QUAN TRỌNG: cụm dài/đặc thù trước cụm ngắn (cho nhánh includes phía dưới).
const PRIO_MAP: [string, string][] = [
  ["khẩn cấp", "Highest"], ["rất cao", "Highest"], ["cao nhất", "Highest"], ["highest", "Highest"],
  ["gấp", "High"], ["khẩn", "High"], ["cao", "High"], ["high", "High"],
  ["trung bình", "Medium"], ["tb", "Medium"], ["vừa", "Medium"], ["medium", "Medium"],
  ["thấp nhất", "Lowest"], ["lowest", "Lowest"],
  ["thấp", "Low"], ["low", "Low"],
];

async function prioCommand(arg: string, chatId: number, env: any): Promise<void> {
  const key = extractIssueKey(arg);
  const raw = key ? arg.replace(key, "").trim().toLowerCase() : "";
  if (!key || !raw) {
    await tg.sendMessage(env, chatId, "Cú pháp: /prio KAN-12 &lt;cao nhất|cao|trung bình|thấp|thấp nhất&gt;");
    return;
  }
  const hit = PRIO_MAP.find(([k]) => k === raw) || PRIO_MAP.find(([k]) => raw.includes(k));
  if (!hit) {
    await tg.sendMessage(env, chatId, "Mức ưu tiên: cao nhất / cao / trung bình / thấp / thấp nhất.");
    return;
  }
  try {
    await jira.setPriority(env, key, hit[1]);
    await tg.sendMessage(env, chatId, `✅ <b>${esc(key)}</b> priority → ${esc(hit[1])}.`);
  } catch (e: any) {
    await tg.sendMessage(env, chatId, `❌ Lỗi đặt priority (project có thể không bật field này):\n<code>${esc(e.message).slice(0, 300)}</code>`);
  }
}

// ---- Hoàn thành ----

// Chuyển issue sang trạng thái Done; trả về tên trạng thái, hoặc false nếu không có.
async function transitionDone(env: any, chatId: number, issueKey: string): Promise<string | false> {
  const trs = await jira.transitions(env, issueKey);
  const t = trs.find((x: any) => DONE_RE.test(x.name));
  if (!t) {
    await tg.sendMessage(
      env,
      chatId,
      `Project chưa có trạng thái kiểu "Done". Các trạng thái chuyển được: ${esc(trs.map((x: any) => x.name).join(", ")) || "(không có)"}`,
    );
    return false;
  }
  await jira.transition(env, issueKey, t.id);
  await env.BOT_KV.delete(`due:${issueKey}`);
  return t.name;
}

// Xoá hẳn issue khỏi Jira (vĩnh viễn) + gỡ nhắc liên quan.
async function deleteTask(env: any, chatId: number, key: string): Promise<void> {
  try {
    let summary = key;
    try {
      summary = (await jira.getIssueFields(env, key, ["summary"]))?.fields?.summary || key;
    } catch {
      /* lấy được summary thì hay, không thì thôi */
    }
    await jira.deleteIssue(env, key);
    await env.BOT_KV.delete(`due:${key}`);
    await tg.sendMessage(env, chatId, `🗑️ Đã xoá <b>${esc(key)}</b> — ${esc(String(summary).slice(0, 60))}.`);
  } catch (e: any) {
    await tg.sendMessage(env, chatId, `❌ Lỗi xoá ${esc(key)} (cần quyền Delete issue):\n<code>${esc(e.message).slice(0, 300)}</code>`);
  }
}

async function doneCommand(arg: string, chatId: number, env: any, msg: any): Promise<void> {
  const key = extractIssueKey(arg) || extractIssueKey(msg?.reply_to_message?.text);
  if (!key) {
    await tg.sendMessage(env, chatId, "Reply vào tin có mã việc rồi gõ /done, hoặc /done KAN-12.");
    return;
  }
  const name = await transitionDone(env, chatId, key);
  if (name) await tg.sendMessage(env, chatId, `✅ <b>Đã hoàn thành:</b> ${esc(key)} → ${esc(name)}`);
}

// ---- Nhắc lặp (recurring) ----

async function createRecur(
  env: any,
  chatId: number,
  spec: { kind: "daily" | "weekly"; time: string; text: string; dow?: number },
): Promise<void> {
  const text = String(spec.text || "").replace(/\s+/g, " ").trim().slice(0, 250);
  if (!text) {
    await tg.sendMessage(env, chatId, "Thiếu nội dung việc cần nhắc lặp.");
    return;
  }
  const id = Date.now().toString(36);
  const nextISO = spec.kind === "daily" ? nextDailyISO(spec.time, env) : nextWeeklyISO(spec.dow!, spec.time, env);
  const rec: any = { id, kind: spec.kind, time: spec.time, text, chatId, nextISO };
  if (spec.kind === "weekly") rec.dow = spec.dow;
  await env.BOT_KV.put(`recur:${id}`, JSON.stringify(rec));

  const when = spec.kind === "daily" ? `mỗi ngày ${spec.time}` : `mỗi ${dowNameVN(spec.dow!)} lúc ${spec.time}`;
  await tg.sendMessage(
    env,
    chatId,
    `🔁 Đã đặt nhắc lặp: <b>${esc(text)}</b>\n⏰ ${when}\nLần tới: ${esc(formatVN(nextISO, offsetMin(env)))}\nGỡ: <code>/stoprecur ${id}</code>`,
    { reply_markup: recurButtons(id) },
  );
}

// "8:00" | "08:00" | "8h" | "8h30" -> [h, m] hợp lệ, hoặc null.
function parseClock(tok: string): [number, number] | null {
  const m = tok.match(/^(\d{1,2})(?::|h|g)(\d{2})?$/i);
  if (!m) return null;
  const h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (h > 23 || mi > 59) return null;
  return [h, mi];
}

async function dailyCommand(arg: string, chatId: number, env: any): Promise<void> {
  const sp = arg.indexOf(" ");
  const clock = sp < 0 ? null : parseClock(arg.slice(0, sp));
  const rest = sp < 0 ? "" : arg.slice(sp + 1).trim();
  if (!clock || !rest) {
    await tg.sendMessage(env, chatId, "Cú pháp: /daily HH:MM &lt;việc&gt;\nvd: <code>/daily 08:00 Uống vitamin</code>");
    return;
  }
  const { text } = extractLabels(rest);
  await createRecur(env, chatId, { kind: "daily", time: `${p2(clock[0])}:${p2(clock[1])}`, text });
}

async function weeklyCommand(arg: string, chatId: number, env: any): Promise<void> {
  const parts = arg.split(/\s+/);
  const dow = parts[0] != null ? parseDow(parts[0]) : null;
  const clock = parts[1] != null ? parseClock(parts[1]) : null;
  const rest = parts.slice(2).join(" ").trim();
  if (dow === null || !clock || !rest) {
    await tg.sendMessage(env, chatId, "Cú pháp: /weekly &lt;t2..t7|cn&gt; HH:MM &lt;việc&gt;\nvd: <code>/weekly t2 09:00 Họp đầu tuần</code>");
    return;
  }
  const { text } = extractLabels(rest);
  await createRecur(env, chatId, { kind: "weekly", dow, time: `${p2(clock[0])}:${p2(clock[1])}`, text });
}

async function listRecurring(chatId: number, env: any): Promise<void> {
  const recs = await loadByPrefix(env, "recur:");
  if (!recs.length) {
    await tg.sendMessage(env, chatId, "Chưa có nhắc lặp nào. Tạo: <code>/daily 08:00 &lt;việc&gt;</code>");
    return;
  }
  const lines = recs
    .map((r) => {
      const when = r.kind === "daily" ? `mỗi ngày ${r.time}` : `mỗi ${dowNameVN(r.dow)} ${r.time}`;
      return `• <b>${esc(r.text)}</b>\n  🔁 ${when} • gỡ: <code>/stoprecur ${esc(r.id)}</code>`;
    })
    .join("\n");
  await tg.sendMessage(env, chatId, `🔁 Nhắc lặp:\n${lines}`);
}

async function stopRecurCommand(arg: string, chatId: number, env: any): Promise<void> {
  const id = arg.trim();
  if (!id) {
    await tg.sendMessage(env, chatId, "Cú pháp: /stoprecur &lt;id&gt; (xem id bằng /recurring).");
    return;
  }
  const v = await env.BOT_KV.get(`recur:${id}`);
  if (!v) {
    await tg.sendMessage(env, chatId, `Không thấy nhắc lặp id <code>${esc(id)}</code>.`);
    return;
  }
  await env.BOT_KV.delete(`recur:${id}`);
  await tg.sendMessage(env, chatId, `✅ Đã gỡ nhắc lặp <code>${esc(id)}</code>.`);
}

// ---- Nút bấm (callback_query) ----

async function onCallback(cq: any, env: any): Promise<void> {
  const data: string = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  // Nút bấm cũng phải qua allowlist (đường này KHÔNG đi qua isAllowed của onUpdate).
  if (!isAllowed(chatId, env)) {
    await tg.answerCallback(env, cq.id, "⛔ Không có quyền.");
    return;
  }

  const [action, idOrKey, extraArg] = data.split(":");

  try {
    if (action === "rstop") {
      await env.BOT_KV.delete(`recur:${idOrKey}`);
      await tg.answerCallback(env, cq.id, "✖ Đã dừng nhắc lặp.");
      if (chatId && messageId) {
        await tg.editText(env, chatId, messageId, "✖ <b>Đã dừng nhắc lặp.</b>", { reply_markup: { inline_keyboard: [] } });
      }
      return;
    }

    if (action === "done") {
      const cur = await env.BOT_KV.get(`due:${idOrKey}`);
      const rec = cur ? safeParse(cur) : null;
      const name = await transitionDone(env, chatId, idOrKey);
      if (!name) {
        await tg.answerCallback(env, cq.id, "Không thấy trạng thái Done.");
        return;
      }
      await tg.answerCallback(env, cq.id, `✅ ${idOrKey} → ${name}`);
      if (chatId && messageId) {
        const label = rec?.summary ? esc(rec.summary) : esc(idOrKey);
        await tg.editText(
          env,
          chatId,
          messageId,
          `✅ <b>Đã hoàn thành:</b> ${label}\n🔖 ${esc(idOrKey)} → ${esc(name)}`,
          { reply_markup: { inline_keyboard: [] } },
        );
      }
      return;
    }

    if (action === "snooze" || action === "snmorn") {
      // Chỉ hoãn việc CÒN trong danh sách nhắc — không tự dựng lại record cho việc đã xong/đã xoá.
      const cur = await env.BOT_KV.get(`due:${idOrKey}`);
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
      await env.BOT_KV.put(`due:${idOrKey}`, JSON.stringify(rec));
      try {
        const y = ymd(newISO, offsetMin(env));
        if (y) await jira.setDueDate(env, idOrKey, y);
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

// ---- Cron ----

// Đọc mọi record theo prefix (có phân trang KV).
async function loadByPrefix(env: any, prefix: string): Promise<any[]> {
  const out: any[] = [];
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

export async function runReminders(env: any): Promise<void> {
  const owner = await env.BOT_KV.get("config:owner_chat");
  const now = Date.now();
  const lead = (parseInt(env.REMINDER_LEAD_MINUTES || "0", 10) || 0) * 60000;

  const recs = await loadByPrefix(env, "due:");
  for (const rec of recs) {
    if (rec.fired) continue;
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
      if (!resp || resp.ok === false) {
        console.error("reminder send failed", rec.issueKey, resp);
        continue; // để fired=false cho cron sau thử lại
      }
      rec.fired = true;
      const out = { ...rec };
      delete out._key;
      await env.BOT_KV.put(rec._key, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 14 });
    } catch (e) {
      console.error("reminder error", rec.issueKey, e);
      continue; // cô lập lỗi từng record
    }
  }
}

export async function runRecurring(env: any): Promise<void> {
  const owner = await env.BOT_KV.get("config:owner_chat");
  const now = Date.now();

  const recs = await loadByPrefix(env, "recur:");
  for (const rec of recs) {
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
      if (!resp || resp.ok === false) {
        console.error("recur send failed", rec.id, resp);
        continue;
      }
      // Dời sang lần kế tiếp ở tương lai (không "đuổi" bù các lần đã lỡ).
      rec.nextISO = rec.kind === "daily" ? nextDailyISO(rec.time, env) : nextWeeklyISO(rec.dow, rec.time, env);
      const out = { ...rec };
      delete out._key;
      await env.BOT_KV.put(rec._key, JSON.stringify(out));
    } catch (e) {
      console.error("recur error", rec.id, e);
      continue;
    }
  }
}
