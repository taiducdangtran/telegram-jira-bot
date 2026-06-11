// Kiểu dùng chung: Env (bindings + vars + secrets) và các record lưu trong KV.

export interface Env {
  // Bindings (wrangler.jsonc)
  BOT_KV: KVNamespace;
  AI: Ai;

  // Vars (wrangler.jsonc -> vars)
  JIRA_BASE_URL: string;
  JIRA_PROJECT_KEY?: string;
  JIRA_ISSUE_TYPE?: string;
  TIMEZONE?: string;
  TZ_OFFSET_MINUTES?: string;
  REMINDER_LEAD_MINUTES?: string;
  ALLOWED_CHAT_IDS?: string;
  AI_MODEL?: string;

  // Secrets (wrangler secret put ...)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  JIRA_WEBHOOK_SECRET?: string; // cho route /jira-webhook (Jira -> Telegram sync)
}

// time.ts chỉ cần offset — giữ hẹp để test không phải dựng cả Env.
export type TzEnv = Pick<Env, "TZ_OFFSET_MINUTES">;

// KV `due:{ISSUE-KEY}` — nhắc một-lần. KV là nguồn sự thật cho GIỜ nhắc.
export interface DueRecord {
  issueKey: string;
  dueISO: string;
  chatId: number;
  summary: string;
  url: string;
  fired: boolean;
  firedAtMs?: number; // mốc đã bắn nhắc — guard chống bắn trùng do KV eventual consistency
}

// KV `recur:{id}` — nhắc lặp (không tạo issue mỗi lần).
export interface RecurRecord {
  id: string;
  kind: "daily" | "weekly";
  time: string; // "HH:MM" giờ VN
  dow?: number; // 0(CN)..6(T7), chỉ weekly
  text: string;
  chatId: number;
  nextISO: string;
}

// Hành động bot tự làm trên Jira — để webhook Jira dội về biết là echo.
export type BotActionKind = "done" | "delete" | "due" | "assign";

// KV `team:{alias}` — thành viên nhận DM khi được giao việc.
export interface TeamMember {
  alias: string;
  chatId: number;
  jiraAccountId?: string;
  jiraDisplayName?: string;
  addedAtISO: string;
}
