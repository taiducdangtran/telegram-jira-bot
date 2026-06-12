// Thao tác trên task Jira: tạo, đặt hạn, giao, đổi ưu tiên, hoàn thành, xoá, liệt kê.

import { tg, escapeHtml as esc, taskButtons } from "./telegram";
import { jira } from "./jira";
import { offsetMin, formatVN, ymd } from "./time";
import { matchPriority, cleanAssignee, sanitizeLabel } from "./util";
import { getProjectKey, loadByPrefix, markBotAction, clearBotAction, bumpSchedule } from "./store";
import { findMember, notifyAssignment } from "./team";
import type { Env, DueRecord, TeamMember } from "./types";

export const DONE_RE = /done|hoàn thành|resolved|complete|đã xong|closed|xong|finish/i;

export async function createTask(
  env: Env,
  chatId: number,
  title: string,
  dueISO: string | null,
  warn: string,
  opts: { priority?: string | null; labels?: string[] } = {},
): Promise<string | null> {
  const projectKey = await getProjectKey(env);
  if (!projectKey) {
    await tg.sendMessage(env, chatId, "⚠️ Chưa chọn project Jira. Gõ /projects rồi /useproject KEY.");
    return null;
  }
  // Jira summary tối đa 255 ký tự; gọn khoảng trắng + cắt để không bị Jira 400.
  title = String(title).replace(/\s+/g, " ").trim().slice(0, 250);
  if (!title) {
    await tg.sendMessage(env, chatId, "Thiếu nội dung việc.");
    return null;
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
      const rec: DueRecord = { issueKey: issue.key, dueISO, chatId, summary: title, url, fired: false };
      await env.BOT_KV.put(`due:${issue.key}`, JSON.stringify(rec));
      await bumpSchedule(env); // lịch mới -> cron tick sau quét ngay
      extra = { reply_markup: taskButtons(issue.key) };
    }
    if (dropped.length) warn = (warn || "") + `\n⚠️ Project không hỗ trợ ${dropped.join(" & ")}, đã bỏ qua.`;
    head += `\n🔗 ${esc(url)}${warn || ""}`;
    await tg.sendMessage(env, chatId, head, extra);
    return issue.key;
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
    return null;
  }
}

export async function listUpcoming(chatId: number, env: Env): Promise<void> {
  const recs = await loadByPrefix<DueRecord>(env, "due:");
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

export async function listPending(chatId: number, env: Env): Promise<void> {
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

// DM người được giao (lấy summary + hạn từ Jira). Báo admin nếu DM hỏng.
// `note` = lời nhắn riêng của sếp cho người này (nếu có).
async function dmAssignee(env: Env, adminChatId: number, member: TeamMember, key: string, note: string | null = null): Promise<void> {
  if (member.chatId === adminChatId) return; // đừng DM chính người đang thao tác
  let summary = key;
  let dueText: string | null = null;
  try {
    const f = (await jira.getIssueFields(env, key, ["summary", "duedate"]))?.fields;
    summary = f?.summary || key;
    dueText = f?.duedate || null; // Jira duedate chỉ có ngày YYYY-MM-DD
  } catch {
    /* thiếu summary thì DM bằng key */
  }
  const resp: any = await notifyAssignment(env, member, key, summary, dueText, note);
  if (!resp || resp.ok === false) {
    await tg.sendMessage(env, adminChatId, `⚠️ Đã giao nhưng không DM được ${esc(member.alias)} (chưa bấm Start bot? Chat ID sai?).`);
  }
}

// Giao 1 issue. Ba đường:
//  - "me"            -> set Assignee Jira = mình.
//  - trong /team, ĐÃ link Jira -> set Assignee Jira = người đó + DM.
//  - trong /team, CHƯA link Jira (chế độ gọn, khỏi tạo user Jira) -> ghi chú lên Jira + DM,
//    KHÔNG đụng cột Assignee.
//  - không trong /team -> thử tìm user Jira thật của project.
export async function applyAssign(env: Env, chatId: number, key: string, whoRaw: string, note: string | null = null): Promise<void> {
  const who = cleanAssignee(whoRaw); // "cho Trang" -> "Trang"
  if (!who) {
    await tg.sendMessage(env, chatId, "Cú pháp: /assign KAN-12 me  (hoặc /assign KAN-12 &lt;tên&gt;)");
    return;
  }

  // Giao cho chính mình.
  if (/^(me|tôi|toi|mình|minh|tui|t|bản thân)$/i.test(who)) {
    try {
      const m = await jira.myself(env);
      await markBotAction(env, key, "assign");
      await jira.assign(env, key, m.accountId);
      await tg.sendMessage(env, chatId, `✅ Đã giao <b>${esc(key)}</b> cho ${esc(m.displayName || "bạn")}.`);
    } catch (e: any) {
      await clearBotAction(env, key, "assign").catch(() => {});
      await tg.sendMessage(env, chatId, `❌ Lỗi giao việc:\n<code>${esc(e.message).slice(0, 300)}</code>`);
    }
    return;
  }

  const member = await findMember(env, { name: who });

  // Có trong /team nhưng CHƯA link Jira -> chế độ DM-only: ghi chú + DM, không set Assignee.
  if (member && !member.jiraAccountId) {
    try {
      await jira.addComment(env, key, `📌 Giao cho ${member.alias} (qua Telegram bot).`).catch(() => {});
      // Gắn nhãn người được giao -> Board hiện "ai làm" dù không set cột Assignee.
      await jira.addLabels(env, key, [sanitizeLabel(member.alias)]).catch(() => {});
      await tg.sendMessage(env, chatId, `✅ Đã giao <b>${esc(key)}</b> cho ${esc(member.alias)} — đã DM + ghi chú lên Jira (cột Assignee giữ nguyên).`);
      await dmAssignee(env, chatId, member, key, note);
    } catch (e: any) {
      await tg.sendMessage(env, chatId, `❌ Lỗi giao việc:\n<code>${esc(e.message).slice(0, 300)}</code>`);
    }
    return;
  }

  // Còn lại: cần set Assignee Jira (member đã link Jira, hoặc user Jira thật của project).
  try {
    let accountId: string, name: string;
    if (member?.jiraAccountId) {
      accountId = member.jiraAccountId;
      name = member.jiraDisplayName || member.alias;
    } else {
      const us = await jira.searchAssignable(env, await getProjectKey(env), who);
      if (!us.length) {
        await tg.sendMessage(
          env,
          chatId,
          `Không thấy "${esc(who)}" trong đội. Thêm: <code>/team add ${esc(who)} &lt;chatId&gt;</code> (nhân viên bấm Start bot để lấy Chat ID), rồi giao lại.\nHoặc giao cho bạn: <code>/assign ${esc(key)} me</code>.`,
        );
        return;
      }
      accountId = us[0].accountId;
      name = us[0].displayName;
    }
    await markBotAction(env, key, "assign"); // webhook Jira dội về sẽ biết là echo (tránh DM đôi)
    await jira.assign(env, key, accountId);
    // Gắn thêm nhãn người được giao -> Board lọc theo người được, đồng nhất với chế độ gọn.
    await jira.addLabels(env, key, [sanitizeLabel(name)]).catch(() => {});
    await tg.sendMessage(env, chatId, `✅ Đã giao <b>${esc(key)}</b> cho ${esc(name)}.`);
    try {
      const target = member || (await findMember(env, { accountId, name }));
      if (target) await dmAssignee(env, chatId, target, key, note);
    } catch (e) {
      console.error("notify assignee failed", key, e);
    }
  } catch (e: any) {
    await clearBotAction(env, key, "assign").catch(() => {}); // lệnh fail -> gỡ cờ echo
    await tg.sendMessage(env, chatId, `❌ Lỗi giao việc:\n<code>${esc(e.message).slice(0, 300)}</code>`);
  }
}

// Đặt/đổi hạn cho 1 issue + bật nhắc trong KV.
export async function applyDue(env: Env, chatId: number, key: string, dueISO: string): Promise<void> {
  try {
    const y = ymd(dueISO, offsetMin(env));
    await markBotAction(env, key, "due"); // webhook Jira dội về sẽ biết là echo
    if (y) await jira.setDueDate(env, key, y);
    let summary = key;
    try {
      summary = (await jira.getIssueFields(env, key, ["summary"]))?.fields?.summary || key;
    } catch {
      /* không lấy được summary thì dùng key */
    }
    const rec: DueRecord = { issueKey: key, dueISO, chatId, summary, url: jira.issueUrl(env, key), fired: false };
    await env.BOT_KV.put(`due:${key}`, JSON.stringify(rec));
    await bumpSchedule(env); // lịch đổi -> cron tick sau quét ngay
    await tg.sendMessage(
      env,
      chatId,
      `⏰ Đã đặt nhắc <b>${esc(key)}</b>: ${esc(formatVN(dueISO, offsetMin(env)))} — ${esc(String(summary).slice(0, 50))}.`,
      { reply_markup: taskButtons(key) },
    );
  } catch (e: any) {
    await clearBotAction(env, key, "due").catch(() => {}); // lệnh fail -> gỡ cờ echo
    await tg.sendMessage(env, chatId, `❌ Lỗi đặt hạn:\n<code>${esc(e.message).slice(0, 300)}</code>`);
  }
}

// Đặt độ ưu tiên cho 1 issue theo từ khoá tiếng Việt/English.
export async function applyPriority(env: Env, chatId: number, key: string, raw: string): Promise<void> {
  const name = matchPriority(raw);
  if (!name) {
    await tg.sendMessage(env, chatId, "Mức ưu tiên: cao nhất / cao / trung bình / thấp / thấp nhất.");
    return;
  }
  try {
    await jira.setPriority(env, key, name);
    await tg.sendMessage(env, chatId, `✅ <b>${esc(key)}</b> priority → ${esc(name)}.`);
  } catch (e: any) {
    await tg.sendMessage(env, chatId, `❌ Lỗi đặt priority (project có thể không bật field này):\n<code>${esc(e.message).slice(0, 300)}</code>`);
  }
}

// Chuyển issue sang trạng thái Done; trả về tên trạng thái, hoặc false nếu không có.
export async function transitionDone(env: Env, chatId: number, issueKey: string): Promise<string | false> {
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
  await markBotAction(env, issueKey, "done"); // webhook Jira dội về sẽ biết là echo
  try {
    await jira.transition(env, issueKey, t.id);
  } catch (e) {
    await clearBotAction(env, issueKey, "done").catch(() => {}); // lệnh fail -> gỡ cờ echo
    throw e;
  }
  await env.BOT_KV.delete(`due:${issueKey}`);
  return t.name;
}

// Xoá hẳn issue khỏi Jira (vĩnh viễn) + gỡ nhắc liên quan.
export async function deleteTask(env: Env, chatId: number, key: string): Promise<void> {
  try {
    let summary = key;
    try {
      summary = (await jira.getIssueFields(env, key, ["summary"]))?.fields?.summary || key;
    } catch {
      /* lấy được summary thì hay, không thì thôi */
    }
    await markBotAction(env, key, "delete"); // webhook Jira dội về sẽ biết là echo
    await jira.deleteIssue(env, key);
    await env.BOT_KV.delete(`due:${key}`);
    await tg.sendMessage(env, chatId, `🗑️ Đã xoá <b>${esc(key)}</b> — ${esc(String(summary).slice(0, 60))}.`);
  } catch (e: any) {
    await clearBotAction(env, key, "delete").catch(() => {}); // lệnh fail -> gỡ cờ echo
    await tg.sendMessage(env, chatId, `❌ Lỗi xoá ${esc(key)} (cần quyền Delete issue):\n<code>${esc(e.message).slice(0, 300)}</code>`);
  }
}
