// Bọc mỏng Telegram Bot API (chỉ những method bot này cần).
import type { Env } from "./types";


function api(env: Env, method: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function call(env: Env, method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(api(env, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!(data as any).ok) {
    console.error("telegram", method, JSON.stringify(data));
    // LƯỚI AN TOÀN: Telegram từ chối vì HTML/entities hỏng (mã 400 "can't parse
    // entities") -> đừng để tin câm lặng. Gửi lại bản KHÔNG parse_mode, đã bỏ thẻ &
    // giải mã entity để đọc sạch. Một chuỗi lỗi không bao giờ làm bot im nữa.
    const desc = String((data as any)?.description || "");
    if (
      "text" in payload && payload.parse_mode &&
      Number((data as any)?.error_code) === 400 && /parse|entit|tag/i.test(desc)
    ) {
      const { parse_mode, ...rest } = payload;
      const plain = stripHtml(String(payload.text ?? ""));
      const res2 = await fetch(api(env, method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...rest, text: plain }),
      });
      const data2 = await res2.json().catch(() => ({ ok: false }));
      if (!(data2 as any).ok) console.error("telegram retry-plain", method, JSON.stringify(data2));
      return data2;
    }
  }
  return data;
}

// Bỏ thẻ HTML + giải mã entity để hiển thị dạng văn bản thuần (dùng cho lưới an toàn).
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Telegram giới hạn 4096 ký tự/tin nhắn — cắt bớt để không bị 400 (mất tin im lặng).
function clamp(text: string): string {
  return text.length > 4000 ? text.slice(0, 3997) + "…" : text;
}

export const tg = {
  sendMessage: (env: Env, chatId: number | string, text: string, extra: Record<string, unknown> = {}) =>
    call(env, "sendMessage", {
      chat_id: chatId,
      text: clamp(text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    }),

  answerCallback: (env: Env, id: string, text = "") =>
    call(env, "answerCallbackQuery", { callback_query_id: id, text }),

  editText: (env: Env, chatId: number | string, messageId: number, text: string, extra: Record<string, unknown> = {}) =>
    call(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: clamp(text),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    }),
};

// Nút bấm dưới mỗi việc có hạn: hoàn thành / hoãn 1h / dời sáng mai.
// callback_data tối đa 64 byte; issueKey kiểu "KAN-12" thừa sức nằm gọn.
export function taskButtons(issueKey: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Hoàn thành", callback_data: `done:${issueKey}` },
        { text: "⏰ +1h", callback_data: `snooze:${issueKey}:60` },
        { text: "🌅 Sáng mai", callback_data: `snmorn:${issueKey}` },
      ],
    ],
  };
}

// Nút dưới mỗi nhắc lặp: dừng hẳn chuỗi lặp đó.
export function recurButtons(id: string) {
  return { inline_keyboard: [[{ text: "✖ Dừng lặp", callback_data: `rstop:${id}` }]] };
}
