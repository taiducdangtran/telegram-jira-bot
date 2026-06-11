// Test applyAssign — 3 đường giao việc, đặc biệt chế độ DM-only (khỏi tạo user Jira).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/telegram", () => ({
  tg: { sendMessage: vi.fn(async () => ({ ok: true })) },
  escapeHtml: (s: unknown) => String(s),
  taskButtons: () => ({}),
}));
vi.mock("../src/jira", () => ({
  jira: {
    myself: vi.fn(async () => ({ accountId: "boss", displayName: "Sếp" })),
    assign: vi.fn(async () => ({})),
    addComment: vi.fn(async () => ({})),
    searchAssignable: vi.fn(async () => []),
    getIssueFields: vi.fn(async () => ({ fields: { summary: "việc X", duedate: null } })),
    issueUrl: (_e: any, k: string) => "https://x/browse/" + k,
  },
}));
vi.mock("../src/store", () => ({
  getProjectKey: vi.fn(async () => "KAN"),
  markBotAction: vi.fn(async () => {}),
  clearBotAction: vi.fn(async () => {}),
  bumpSchedule: vi.fn(async () => {}),
  loadByPrefix: vi.fn(async () => []),
}));
vi.mock("../src/team", () => ({
  findMember: vi.fn(async () => null),
  notifyAssignment: vi.fn(async () => ({ ok: true })),
}));

import { applyAssign } from "../src/tasks";
import { jira } from "../src/jira";
import { tg } from "../src/telegram";
import { findMember, notifyAssignment } from "../src/team";

const ADMIN = 100;
const ENV: any = { TZ_OFFSET_MINUTES: "420" };

beforeEach(() => vi.clearAllMocks());

describe("applyAssign", () => {
  it("DM-only: người trong /team CHƯA link Jira -> ghi chú + DM, KHÔNG đụng Assignee", async () => {
    vi.mocked(findMember).mockResolvedValue({ alias: "Trang", chatId: 222, addedAtISO: "" } as any);
    await applyAssign(ENV, ADMIN, "KAN-1", "cho Trang"); // "cho" được bỏ
    expect(jira.addComment).toHaveBeenCalledWith(ENV, "KAN-1", expect.stringContaining("Trang"));
    expect(jira.assign).not.toHaveBeenCalled(); // không set Assignee
    expect(notifyAssignment).toHaveBeenCalledTimes(1); // có DM Trang
  });

  it("đã link Jira -> set Assignee bằng accountId + DM", async () => {
    vi.mocked(findMember).mockResolvedValue({
      alias: "Trang", chatId: 222, jiraAccountId: "acc-trang", jiraDisplayName: "Trang N", addedAtISO: "",
    } as any);
    await applyAssign(ENV, ADMIN, "KAN-2", "Trang");
    expect(jira.assign).toHaveBeenCalledWith(ENV, "KAN-2", "acc-trang");
    expect(jira.addComment).not.toHaveBeenCalled();
    expect(notifyAssignment).toHaveBeenCalledTimes(1);
  });

  it("không trong /team + Jira cũng không có -> hướng dẫn /team add, KHÔNG giao", async () => {
    vi.mocked(findMember).mockResolvedValue(null);
    vi.mocked(jira.searchAssignable).mockResolvedValue([]);
    await applyAssign(ENV, ADMIN, "KAN-3", "Người Lạ");
    expect(jira.assign).not.toHaveBeenCalled();
    const txt = vi.mocked(tg.sendMessage).mock.calls.at(-1)?.[2] as string;
    expect(txt).toContain("/team add");
  });

  it("'me' -> giao Jira cho chính mình", async () => {
    await applyAssign(ENV, ADMIN, "KAN-4", "me");
    expect(jira.myself).toHaveBeenCalled();
    expect(jira.assign).toHaveBeenCalledWith(ENV, "KAN-4", "boss");
    expect(notifyAssignment).not.toHaveBeenCalled();
  });

  it("DM-only nhưng người được giao chính là admin -> không tự DM mình", async () => {
    vi.mocked(findMember).mockResolvedValue({ alias: "Sếp", chatId: ADMIN, addedAtISO: "" } as any);
    await applyAssign(ENV, ADMIN, "KAN-5", "Sếp");
    expect(jira.addComment).toHaveBeenCalled();
    expect(notifyAssignment).not.toHaveBeenCalled();
  });

  it("'cho' rỗng -> hiện cú pháp", async () => {
    await applyAssign(ENV, ADMIN, "KAN-6", "cho");
    expect(jira.assign).not.toHaveBeenCalled();
    expect(jira.addComment).not.toHaveBeenCalled();
    const txt = vi.mocked(tg.sendMessage).mock.calls.at(-1)?.[2] as string;
    expect(txt).toContain("Cú pháp");
  });
});
