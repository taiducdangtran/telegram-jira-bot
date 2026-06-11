// Cloudflare Worker entrypoint.
//  - fetch:     nhận webhook Telegram (POST /webhook) + webhook Jira (POST /jira-webhook),
//               trả 200 ngay, xử lý nền.
//  - scheduled: Cron Trigger quét KV và bắn nhắc lịch.

import { onUpdate } from "./handlers";
import { runScheduled } from "./cron";
import { onJiraWebhook } from "./jira-webhook";
import type { Env } from "./types";

// So sánh constant-time để không rò rỉ secret qua thời gian phản hồi.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false; // độ dài secret là cố định & công khai
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/webhook") {
      // Xác thực webhook: header phải khớp secret đã đăng ký với Telegram.
      const header = req.headers.get("x-telegram-bot-api-secret-token");
      const secret = env.TELEGRAM_WEBHOOK_SECRET;
      if (!secret || header === null || !timingSafeEqual(header, secret)) {
        return new Response("forbidden", { status: 403 });
      }
      let update: any;
      try {
        update = await req.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      // Trả 200 thật nhanh để Telegram không retry; việc nặng làm trong waitUntil.
      ctx.waitUntil(onUpdate(update, env).catch((e) => console.error("onUpdate", e)));
      return new Response("ok");
    }

    if (req.method === "POST" && url.pathname === "/jira-webhook") {
      // Jira webhook không gửi được custom header -> secret nằm ở query (?s=...).
      const s = url.searchParams.get("s") || "";
      const secret = env.JIRA_WEBHOOK_SECRET;
      if (!secret || !timingSafeEqual(s, secret)) {
        return new Response("forbidden", { status: 403 });
      }
      let payload: any;
      try {
        payload = await req.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      // Luôn trả 200 nhanh — Jira tự TẮT webhook nào hay lỗi/chậm.
      ctx.waitUntil(onJiraWebhook(payload, env).catch((e) => console.error("jiraWebhook", e)));
      return new Response("ok");
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("Telegram → Jira bot is running.");
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env).catch((e) => console.error("scheduled", e)));
  },
};
