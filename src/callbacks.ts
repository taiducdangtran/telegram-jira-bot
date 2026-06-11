// Xử lý nút bấm (callback_query): hoàn thành / hoãn / dừng nhắc lặp.

import { tg, escapeHtml as esc } from "./telegram";
import { jira } from "./jira";
import { offsetMin, nowVN, formatVN, ymd, isoFromMs, msFromVN } from "./time";
import { safeParse } from "./util";
import { isAllowed, markBotAction, clearBotAction, bumpSchedule } from "./store";
import { transitionDone } from "./tasks";
import type { Env, DueRecord } from "./types";

export async function onCallback(cq: any, env: Env): Promise<void> {
  const data: string = cq.data || "";
  const chatId: number | undefined = cq.message?.chat?.id;
  const messageId: number | undefined = cq.message?.message_id;

  // Telegram chỉ nhận MỘT answerCallbackQuery cho mỗi lần bấm — gói lại để
  // mọi nhánh (kể cả lỗi sau khi đã answer) không answer lần hai.
  let answered = false;
  const answer = async (text: string) => {
    if (answered) return;
    answered = true;
    await tg.answerCallback(env, cq.id, text);
  };

  // Nút bấm cũng phải qua allowlist (đường này KHÔNG đi qua isAllowed của onUpdate).
  // chatId thiếu (tin quá cũ, Telegram không gửi kèm message) -> cũng từ chối.
  if (chatId == null || !isAllowed(chatId, env)) {
    await answer("⛔ Không có quyền.");
    return;
  }

  const [action, idOrKey, extraArg] = data.split(":");

  try {
    if (action === "rstop") {
      await env.BOT_KV.delete(`recur:${idOrKey}`);
      await answer("✖ Đã dừng nhắc lặp.");
      if (chatId && messageId) {
        await tg.editText(env, chatId, messageId, "✖ <b>Đã dừng nhắc lặp.</b>", { reply_markup: { inline_keyboard: [] } });
      }
      return;
    }

    if (action === "done") {
      const cur = await env.BOT_KV.get(`due:${idOrKey}`);
      const rec: DueRecord | null = cur ? safeParse(cur) : null;
      const name = await transitionDone(env, chatId, idOrKey);
      if (!name) {
        await answer("Không thấy trạng thái Done.");
        return;
      }
      await answer(`✅ ${idOrKey} → ${name}`);
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
      const rec: DueRecord | null = cur ? safeParse(cur) : null;
      if (!rec) {
        await answer("Việc này không còn trong danh sách nhắc.");
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
      delete rec.firedAtMs; // không xoá thì guard "vừa bắn 10'" sẽ nuốt nhắc hoãn ngắn
      await env.BOT_KV.put(`due:${idOrKey}`, JSON.stringify(rec));
      await bumpSchedule(env); // lịch đổi -> cron tick sau quét ngay
      try {
        const y = ymd(newISO, offsetMin(env));
        await markBotAction(env, idOrKey, "due"); // webhook Jira dội về sẽ biết là echo
        if (y) await jira.setDueDate(env, idOrKey, y);
      } catch {
        // set duedate là phụ; KV mới quyết định giờ nhắc — nhưng gỡ cờ echo kẻo
        // 2' sau sửa hạn thật trên Jira bị nuốt thông báo.
        await clearBotAction(env, idOrKey, "due").catch(() => {});
      }
      await answer(`⏰ Hoãn tới ${formatVN(newISO, offsetMin(env))}`);
      return;
    }

    await answer("");
  } catch (e: any) {
    await answer("Lỗi: " + String(e.message || "").slice(0, 150));
  }
}
