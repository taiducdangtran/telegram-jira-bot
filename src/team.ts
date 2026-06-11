// Registry đội: ai được giao việc thì bot DM Telegram cho người đó.
// KV: team:{alias-chuẩn-hoá} = TeamMember.
//
// LƯU Ý PHÂN QUYỀN: ALLOWED_CHAT_IDS vẫn là cổng lệnh/nút DUY NHẤT. Thành viên
// trong registry CHỈ NHẬN thông báo — không gửi lệnh, không bấm nút được.
// Telegram chỉ cho bot DM người đã bấm Start bot ít nhất một lần.

import { tg, escapeHtml as esc } from "./telegram";
import { jira } from "./jira";
import { loadByPrefix, getProjectKey } from "./store";
import type { Env, TeamMember } from "./types";

// Chuẩn hoá tên để so khớp: thường, bỏ dấu (NFD), đ->d, gọn khoảng trắng.
export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

export async function teamCommand(arg: string, chatId: number, env: Env): Promise<void> {
  const parts = arg.split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();
  const rest = parts.slice(1).join(" ").trim();
  switch (sub) {
    case "add":
      return teamAdd(rest, chatId, env);
    case "list":
    case "ls":
      return teamList(chatId, env);
    case "del":
    case "remove":
    case "rm":
      return teamDel(rest, chatId, env);
    default:
      await tg.sendMessage(
        env,
        chatId,
        "Cú pháp: <code>/team add &lt;tên&gt; &lt;chatId&gt;</code> · <code>/team list</code> · <code>/team del &lt;tên&gt;</code>\nThành viên bấm Start bot rồi nhắn bất kỳ — bot sẽ trả Chat ID để gửi cho bạn.",
      );
  }
}

async function teamAdd(arg: string, chatId: number, env: Env): Promise<void> {
  const parts = arg.split(/\s+/).filter(Boolean);
  const idTok = parts[parts.length - 1] || "";
  const alias = parts.slice(0, -1).join(" ").trim();
  if (!alias || !/^-?\d{5,15}$/.test(idTok)) {
    await tg.sendMessage(
      env,
      chatId,
      "Cú pháp: /team add &lt;tên&gt; &lt;chatId&gt;\nvd: <code>/team add Tú 123456789</code>\n(Tú bấm Start bot + nhắn bất kỳ để nhận Chat ID của mình.)",
    );
    return;
  }
  const member: TeamMember = { alias, chatId: Number(idTok), addedAtISO: new Date().toISOString() };
  // Tên khác nhau có thể trùng key sau khi bỏ dấu ("Tú"/"Tủ" -> team:tu) — báo khi ghi đè.
  const oldRaw = await env.BOT_KV.get(`team:${normName(alias)}`);
  const old: TeamMember | null = oldRaw ? JSON.parse(oldRaw) : null;
  // Best-effort khớp user Jira theo tên — để webhook "assignee đổi" (accountId) tra ra người này.
  try {
    const pk = await getProjectKey(env);
    if (pk) {
      const us = await jira.searchAssignable(env, pk, alias);
      if (us.length) {
        member.jiraAccountId = us[0].accountId;
        member.jiraDisplayName = us[0].displayName;
      }
    }
  } catch {
    /* không khớp được Jira thì DM khi /assign vẫn chạy */
  }
  await env.BOT_KV.put(`team:${normName(alias)}`, JSON.stringify(member));
  let msg = `✅ Đã thêm <b>${esc(alias)}</b> (chat <code>${esc(idTok)}</code>).`;
  msg += member.jiraDisplayName
    ? `\n🔗 Có sẵn user Jira "${esc(member.jiraDisplayName)}" — giao việc sẽ set luôn cột Assignee.`
    : `\n✓ Chế độ gọn: <code>/assign ${esc(alias)}</code> sẽ DM ${esc(alias)} + ghi chú lên Jira (khỏi cần tạo user Jira).`;
  if (old && old.chatId !== member.chatId) {
    msg += `\n⚠️ Đã GHI ĐÈ "${esc(old.alias)}" (chat ${old.chatId}) — hai tên trùng nhau sau khi bỏ dấu.`;
  }
  await tg.sendMessage(env, chatId, msg);
}

async function teamList(chatId: number, env: Env): Promise<void> {
  const members = await loadByPrefix<TeamMember>(env, "team:");
  if (!members.length) {
    await tg.sendMessage(env, chatId, "Chưa có ai trong đội. Thêm: <code>/team add &lt;tên&gt; &lt;chatId&gt;</code>");
    return;
  }
  const lines = members
    .map((m) => `• <b>${esc(m.alias)}</b> — chat ${esc(String(m.chatId))}${m.jiraDisplayName ? ` — Jira: ${esc(m.jiraDisplayName)}` : " — chưa khớp Jira"}`)
    .join("\n");
  await tg.sendMessage(env, chatId, `👥 <b>Đội (${members.length})</b>:\n${lines}\n\nGỡ: <code>/team del &lt;tên&gt;</code>`);
}

async function teamDel(arg: string, chatId: number, env: Env): Promise<void> {
  const name = arg.trim();
  if (!name) {
    await tg.sendMessage(env, chatId, "Cú pháp: /team del &lt;tên&gt; (xem tên bằng /team list).");
    return;
  }
  const key = `team:${normName(name)}`;
  const v = await env.BOT_KV.get(key);
  if (!v) {
    await tg.sendMessage(env, chatId, `Không thấy "${esc(name)}" trong đội. Gõ /team list để xem.`);
    return;
  }
  await env.BOT_KV.delete(key);
  await tg.sendMessage(env, chatId, `✅ Đã xoá <b>${esc(name)}</b> khỏi đội.`);
}

// "a b c" chứa "b c" theo TỪ trọn vẹn? (chặn kiểu substring: "tu" ăn nhầm "tuấn",
// "an" ăn nhầm "thanh" — DM sai người là phá hỏng cả tính năng)
function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

// Tìm thành viên: ưu tiên accountId Jira (chính xác tuyệt đối), rồi alias/tên khớp
// đúng (đã bỏ dấu), cuối cùng khớp theo TỪ trọn vẹn (alias "Tú" ↔ tên "Tú Nguyễn").
// Không khớp mờ hơn nữa — thà không DM còn hơn DM nhầm người.
export async function findMember(
  env: Env,
  q: { accountId?: string | null; name?: string | null },
): Promise<TeamMember | null> {
  const members = await loadByPrefix<TeamMember>(env, "team:");
  if (!members.length) return null;
  if (q.accountId) {
    const hit = members.find((m) => m.jiraAccountId === q.accountId);
    if (hit) return hit;
  }
  if (q.name) {
    const n = normName(q.name);
    if (n.length >= 2) {
      const exact = members.find(
        (m) => normName(m.alias) === n || (m.jiraDisplayName && normName(m.jiraDisplayName) === n),
      );
      if (exact) return exact;
      const byWord = members.find((m) => {
        const a = normName(m.alias);
        const d = m.jiraDisplayName ? normName(m.jiraDisplayName) : "";
        return containsWords(n, a) || containsWords(a, n) || (!!d && (containsWords(n, d) || containsWords(d, n)));
      });
      if (byWord) return byWord;
    }
  }
  return null;
}

// DM người được giao việc. KHÔNG kèm nút: callback của người ngoài allowlist bị chặn,
// nút chết chỉ gây bực — v1 thông báo thuần. Trả response để caller báo admin khi fail.
export async function notifyAssignment(
  env: Env,
  member: TeamMember,
  key: string,
  summary: string,
  dueText: string | null,
): Promise<any> {
  const due = dueText ? `\n⏰ Hạn: ${esc(dueText)}` : "";
  return tg.sendMessage(
    env,
    member.chatId,
    `📋 <b>Bạn được giao việc</b>\n📌 ${esc(summary)}\n🔖 ${esc(key)}${due}\n🔗 ${esc(jira.issueUrl(env, key))}`,
  );
}
