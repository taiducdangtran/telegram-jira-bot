// Router của bot: định tuyến message/command, hiểu câu tự nhiên, nhắc lặp.
// Thao tác task -> tasks.ts · nút bấm -> callbacks.ts · cron -> cron.ts · KV -> store.ts.

import { tg, escapeHtml as esc, recurButtons } from "./telegram";
import { jira } from "./jira";
import { parseTask } from "./ai";
import {
  offsetMin, nowVN, parseDueStrict, formatVN,
  hhmmVN, nextDailyISO, nextWeeklyISO, parseDow, dowNameVN, parseRelative,
} from "./time";
import { p2, extractLabels, detectPriority, extractIssueKey, looksLikeQuery, looksLikeGreeting, parseClock, validateProjectKey, splitBatchCommands } from "./util";
import { isAllowed, loadByPrefix, rememberOwnerChat, bumpSchedule } from "./store";
import {
  createTask, listUpcoming, listPending, applyAssign, applyDue, applyPriority,
  transitionDone, deleteTask,
} from "./tasks";
import { onCallback } from "./callbacks";
import { teamCommand } from "./team";
import type { Env, RecurRecord } from "./types";

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

<b>↩️ Reply vào 1 task = sửa task đó</b>
"3p nữa" / "mai 9h" → đặt nhắc · "giao cho Tú" → giao · "ưu tiên cao" · "xong" · "xoá" · câu khác → thêm ghi chú.

<b>Đội 👥 (DM nhân viên, khỏi cần tạo user Jira)</b>
• /team add &lt;tên&gt; &lt;chatId&gt; · /team list · /team del &lt;tên&gt;
  Nhân viên bấm Start bot → bot trả Chat ID → bạn /team add. Rồi /assign KAN-12 &lt;tên&gt;
  (hay "giao cho Tú") → bot DM người đó + ghi chú lên Jira.

<b>Cài đặt</b>
• /projects · /useproject &lt;KEY&gt; · /whoami`;

const DONE_WORD_RE = /^(xong|done|hoàn thành|đã xong|hoàn tất|ok xong)\b/i;
const DELETE_WORD_RE = /(xoá|xóa|huỷ|hủy|delete|remove|gỡ task|gỡ việc)/i;

// ---- Định tuyến update ----

export async function onUpdate(update: any, env: Env): Promise<void> {
  // Telegram có thể retry cùng một update (timeout/mạng) -> dedup theo update_id
  // để không tạo issue trùng. check-then-set không atomic, nhưng retry của Telegram
  // cách nhau vài giây và thường vào cùng colo (read-your-writes) — đủ chắc.
  // CHỈ dedup cho chat trong allowlist: người lạ nhắn bot không được đốt quota
  // write KV (~1k/ngày). Câu từ chối có gửi trùng khi Telegram retry cũng vô hại.
  const preChatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (update.update_id != null && isAllowed(preChatId, env)) {
    const dupKey = `processed:upd:${update.update_id}`;
    if (await env.BOT_KV.get(dupKey)) {
      console.log("duplicate update, skipped", update.update_id);
      return;
    }
    await env.BOT_KV.put(dupKey, "1", { expirationTtl: 600 });
  }

  if (update.callback_query) return onCallback(update.callback_query, env);

  // Tin nhắn bị SỬA (edited_message) bỏ qua — xử lý lại sẽ tạo task trùng.
  const msg = update.message;
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
        : `⛔ Bạn không có quyền dùng bot này.\nChat ID của bạn: <code>${chatId}</code> — gửi cho admin nếu bạn cần NHẬN thông báo giao việc (admin gõ /team add).`,
    );
    return;
  }

  // Nhớ chat gần nhất để cron có chỗ gửi nhắc (fallback khi record thiếu chatId).
  await rememberOwnerChat(env, chatId);

  const text = msg.text.trim();
  if (!text) {
    await tg.sendMessage(env, chatId, "Nhắn nội dung việc giúp mình nhé (gõ /help để xem cách dùng).");
    return;
  }
  // Dán nhiều lệnh 1 lúc (mỗi dòng 1 lệnh) -> chạy lần lượt từng dòng.
  const batch = splitBatchCommands(text);
  if (batch) {
    for (const line of batch) await onCommand(line, chatId, env, msg);
    return;
  }
  if (text.startsWith("/")) return onCommand(text, chatId, env, msg);
  return onNaturalText(text, chatId, env, msg);
}

async function onCommand(text: string, chatId: number, env: Env, msg: any): Promise<void> {
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
    case "/team":
      return teamCommand(arg, chatId, env);
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

async function listProjects(chatId: number, env: Env): Promise<void> {
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

async function useProject(arg: string, chatId: number, env: Env): Promise<void> {
  const key = arg.trim().toUpperCase();
  if (!key) {
    await tg.sendMessage(env, chatId, "Cú pháp: /useproject KEY  (vd /useproject KAN)");
    return;
  }
  // Chặn key sai dạng trước khi gọi API / nội suy vào JQL (phòng thủ thêm).
  if (!validateProjectKey(key)) {
    await tg.sendMessage(env, chatId, `Key <b>${esc(key)}</b> không hợp lệ (chữ hoa + số, vd KAN). Gõ /projects để xem danh sách.`);
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

async function noteCommand(arg: string, chatId: number, env: Env): Promise<void> {
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

async function onNaturalText(text: string, chatId: number, env: Env, msg: any): Promise<void> {
  // 1. Reply vào tin có mã việc -> thao tác TRÊN task đó (đặt nhắc/đổi hạn/giao/ưu tiên/done/xoá/ghi chú).
  const replyKey = extractIssueKey(msg?.reply_to_message?.text);
  if (replyKey) return handleReplyToTask(text, chatId, env, replyKey);

  // 2. "xoá KAN-105" (có mã trong câu) -> xoá. Không phải câu "tạo/thêm/ghi".
  if (DELETE_WORD_RE.test(text) && !/^(tạo|thêm|ghi)\b/i.test(text)) {
    const key = extractIssueKey(text);
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
  // AI lỗi/không trả JSON -> đã lưu nguyên văn; báo để user biết mà tự đặt hạn.
  const warn = parsed.aiFallback
    ? "\n⚠️ AI không phân tích được câu này — đã lưu nguyên văn làm tiêu đề. Cần hạn giờ thì dùng /note <việc> // <giờ>."
    : "";
  await createTask(env, chatId, parsed.title, dueISO, warn, { priority, labels });
}

// Reply vào tin có mã việc = THAO TÁC trên task đó (không tạo task mới).
async function handleReplyToTask(text: string, chatId: number, env: Env, key: string): Promise<void> {
  // Hoàn thành
  if (DONE_WORD_RE.test(text)) {
    const name = await transitionDone(env, chatId, key);
    if (name) await tg.sendMessage(env, chatId, `✅ <b>Đã hoàn thành:</b> ${esc(key)} → ${esc(name)}`);
    return;
  }
  // Xoá
  if (DELETE_WORD_RE.test(text) && !/^(tạo|thêm|ghi)\b/i.test(text)) {
    return deleteTask(env, chatId, key);
  }
  // Giao việc: "giao cho X", "assign X", "giao t"
  const am = text.match(/(?:giao|assign)\s+(?:cho\s+|to\s+)?(.+)/i);
  if (am) return applyAssign(env, chatId, key, am[1].trim());
  // Ưu tiên: "ưu tiên cao", "priority high"
  const pm = text.match(/(?:ưu tiên|độ ưu tiên|priority)\s+(.+)/i);
  if (pm) return applyPriority(env, chatId, key, pm[1].trim().toLowerCase());
  // Có thời gian (tương đối / tự nhiên / tất định) -> đặt nhắc TRÊN task này.
  const rel = parseRelative(text, env);
  let dueISO = rel?.dueISO || null;
  if (!dueISO) dueISO = (await parseTask(text, env)).dueISO;
  if (!dueISO) dueISO = parseDueStrict(text, offsetMin(env), nowVN(env));
  if (dueISO) return applyDue(env, chatId, key, dueISO);
  // Còn lại: ghi text làm comment cho task (một dạng "cập nhật").
  try {
    await jira.addComment(env, key, text);
    await tg.sendMessage(env, chatId, `💬 Đã thêm ghi chú vào <b>${esc(key)}</b>: ${esc(text.slice(0, 60))}`);
  } catch (e: any) {
    await tg.sendMessage(
      env,
      chatId,
      `↩️ Reply <b>${esc(key)}</b> — mình hiểu: đặt nhắc ("3p nữa"/"mai 9h"), "giao cho &lt;tên&gt;", "ưu tiên cao", "xong", "xoá".`,
    );
  }
}

// ---- Lệnh sửa task ----

async function assignCommand(arg: string, chatId: number, env: Env): Promise<void> {
  const key = extractIssueKey(arg);
  const who = key ? arg.replace(key, "").trim() : "";
  if (!key || !who) {
    await tg.sendMessage(env, chatId, "Cú pháp: /assign KAN-12 me  (hoặc /assign KAN-12 &lt;tên&gt;)");
    return;
  }
  await applyAssign(env, chatId, key, who);
}

async function dueCommand(arg: string, chatId: number, env: Env): Promise<void> {
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
  await applyDue(env, chatId, key, dueISO);
}

async function prioCommand(arg: string, chatId: number, env: Env): Promise<void> {
  const key = extractIssueKey(arg);
  const raw = key ? arg.replace(key, "").trim().toLowerCase() : "";
  if (!key || !raw) {
    await tg.sendMessage(env, chatId, "Cú pháp: /prio KAN-12 &lt;cao nhất|cao|trung bình|thấp|thấp nhất&gt;");
    return;
  }
  await applyPriority(env, chatId, key, raw);
}

async function doneCommand(arg: string, chatId: number, env: Env, msg: any): Promise<void> {
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
  env: Env,
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
  const rec: RecurRecord = { id, kind: spec.kind, time: spec.time, text, chatId, nextISO };
  if (spec.kind === "weekly") rec.dow = spec.dow;
  await env.BOT_KV.put(`recur:${id}`, JSON.stringify(rec));
  await bumpSchedule(env); // lịch mới -> cron tick sau quét ngay

  const when = spec.kind === "daily" ? `mỗi ngày ${spec.time}` : `mỗi ${dowNameVN(spec.dow!)} lúc ${spec.time}`;
  await tg.sendMessage(
    env,
    chatId,
    `🔁 Đã đặt nhắc lặp: <b>${esc(text)}</b>\n⏰ ${when}\nLần tới: ${esc(formatVN(nextISO, offsetMin(env)))}\nGỡ: <code>/stoprecur ${id}</code>`,
    { reply_markup: recurButtons(id) },
  );
}

async function dailyCommand(arg: string, chatId: number, env: Env): Promise<void> {
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

async function weeklyCommand(arg: string, chatId: number, env: Env): Promise<void> {
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

async function listRecurring(chatId: number, env: Env): Promise<void> {
  const recs = await loadByPrefix<RecurRecord>(env, "recur:");
  if (!recs.length) {
    await tg.sendMessage(env, chatId, "Chưa có nhắc lặp nào. Tạo: <code>/daily 08:00 &lt;việc&gt;</code>");
    return;
  }
  const lines = recs
    .map((r) => {
      const when = r.kind === "daily" ? `mỗi ngày ${r.time}` : `mỗi ${dowNameVN(r.dow!)} ${r.time}`;
      return `• <b>${esc(r.text)}</b>\n  🔁 ${when} • gỡ: <code>/stoprecur ${esc(r.id)}</code>`;
    })
    .join("\n");
  await tg.sendMessage(env, chatId, `🔁 Nhắc lặp:\n${lines}`);
}

async function stopRecurCommand(arg: string, chatId: number, env: Env): Promise<void> {
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
