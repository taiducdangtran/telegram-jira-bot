// Test runScheduled — chống hồi quy 2 lỗi nghiêm trọng:
//  1. Nhắc trùng (mark-trước-gửi + firedAtMs guard).
//  2. Vòng lặp revert đốt quota khi gửi fail VĨNH VIỄN (403/400) — phải bỏ cuộc,
//     chỉ retry (có throttle) với lỗi TẠM THỜI (429/5xx).
// Kèm: hint idx:scan — tick không thể có việc tới hạn thì KHÔNG list KV.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/telegram", () => ({
  tg: {
    sendMessage: vi.fn(async () => ({ ok: true })),
    answerCallback: vi.fn(async () => ({ ok: true })),
    editText: vi.fn(async () => ({ ok: true })),
  },
  escapeHtml: (s: unknown) => String(s),
  taskButtons: () => ({}),
  recurButtons: () => ({}),
}));

import { runScheduled } from "../src/cron";
import { tg } from "../src/telegram";
import type { DueRecord, RecurRecord } from "../src/types";

const send = vi.mocked(tg.sendMessage);

function makeKV() {
  const store = new Map<string, string>();
  const kv = {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async (opts: any = {}) => {
      let keys = [...store.keys()];
      if (opts?.prefix) keys = keys.filter((k) => k.startsWith(opts.prefix));
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    }),
  };
  return kv;
}

const NOW = Date.parse("2026-06-10T03:00:00Z"); // 10:00 VN

function makeEnv() {
  const kv = makeKV();
  const env: any = { BOT_KV: kv, REMINDER_LEAD_MINUTES: "0", TZ_OFFSET_MINUTES: "420" };
  kv.store.set("config:owner_chat", "999");
  return { env, kv };
}

function seedDue(kv: ReturnType<typeof makeKV>, key: string, dueMsFromNow: number, extra: Partial<DueRecord> = {}) {
  const rec: DueRecord = {
    issueKey: key, chatId: 111, summary: "việc test", url: "https://x/browse/" + key,
    dueISO: new Date(NOW + dueMsFromNow).toISOString(), fired: false, ...extra,
  };
  kv.store.set(`due:${key}`, JSON.stringify(rec));
  return rec;
}

const readDue = (kv: ReturnType<typeof makeKV>, key: string): DueRecord => JSON.parse(kv.store.get(`due:${key}`)!);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  send.mockClear();
  send.mockResolvedValue({ ok: true } as any);
});
afterEach(() => vi.useRealTimers());

describe("runScheduled — nhắc một-lần", () => {
  it("tới hạn -> gửi đúng 1 lần, tick sau không gửi lại", async () => {
    const { env, kv } = makeEnv();
    seedDue(kv, "KAN-1", -60_000); // quá hạn 1'
    await runScheduled(env);
    expect(send).toHaveBeenCalledTimes(1);
    const rec = readDue(kv, "KAN-1");
    expect(rec.fired).toBe(true);
    expect(rec.firedAtMs).toBeTypeOf("number");

    vi.setSystemTime(NOW + 60_000);
    await runScheduled(env);
    expect(send).toHaveBeenCalledTimes(1); // không nhắc trùng
  });

  it("lỗi VĨNH VIỄN (403) -> bỏ cuộc, giữ fired=true, không retry/không đốt write", async () => {
    const { env, kv } = makeEnv();
    seedDue(kv, "KAN-2", -60_000);
    send.mockResolvedValue({ ok: false, error_code: 403, description: "bot was blocked" } as any);
    await runScheduled(env);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readDue(kv, "KAN-2").fired).toBe(true); // không mở lại

    const putsAfterFirst = kv.put.mock.calls.length;
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(NOW + i * 60_000);
      await runScheduled(env);
    }
    expect(send).toHaveBeenCalledTimes(1); // không gửi lại
    // các tick sau chỉ được phép ghi hint (nếu có) — không mark/revert record nữa
    const recPuts = kv.put.mock.calls.slice(putsAfterFirst).filter(([k]) => String(k).startsWith("due:"));
    expect(recPuts.length).toBe(0);
  });

  it("lỗi TẠM THỜI (429) -> mở lại nhưng throttle 10', sau đó thử lại", async () => {
    const { env, kv } = makeEnv();
    seedDue(kv, "KAN-3", -60_000);
    send.mockResolvedValueOnce({ ok: false, error_code: 429 } as any);
    await runScheduled(env);
    expect(send).toHaveBeenCalledTimes(1);
    const rec = readDue(kv, "KAN-3");
    expect(rec.fired).toBe(false);
    expect(rec.firedAtMs).toBeTypeOf("number"); // giữ lại để throttle

    vi.setSystemTime(NOW + 2 * 60_000); // trong cửa sổ throttle
    await runScheduled(env);
    expect(send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 11 * 60_000); // hết cửa sổ -> thử lại, lần này ok
    await runScheduled(env);
    expect(send).toHaveBeenCalledTimes(2);
    expect(readDue(kv, "KAN-3").fired).toBe(true);
  });

  it("hint idx:scan: chưa thể có việc tới hạn -> tick sau KHÔNG list KV", async () => {
    const { env, kv } = makeEnv();
    seedDue(kv, "KAN-4", 5 * 60_000); // 5' nữa mới tới hạn
    await runScheduled(env); // quét lần đầu (chưa có hint), không gửi
    expect(send).not.toHaveBeenCalled();
    expect(kv.list).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 60_000);
    await runScheduled(env); // hint bảo 4' nữa -> khỏi quét
    expect(kv.list).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 5 * 60_000 + 1000); // tới hạn -> quét + bắn
    await runScheduled(env);
    expect(kv.list).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lịch mới + bumpSchedule (xoá hint) -> tick sau quét ngay dù vừa quét xong", async () => {
    const { env, kv } = makeEnv();
    await runScheduled(env); // không có gì -> hint nextMs=null
    expect(kv.list).toHaveBeenCalledTimes(1);

    seedDue(kv, "KAN-5", 90_000);
    kv.store.delete("idx:scan"); // mô phỏng bumpSchedule() từ createTask
    vi.setSystemTime(NOW + 60_000);
    await runScheduled(env);
    expect(kv.list).toHaveBeenCalledTimes(2); // quét lại ngay vì hint mất

    vi.setSystemTime(NOW + 2 * 60_000); // 120s >= due 90s -> bắn
    await runScheduled(env);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("runScheduled — nhắc lặp", () => {
  it("tới giờ -> gửi + dời nextISO sang tương lai", async () => {
    const { env, kv } = makeEnv();
    const rec: RecurRecord = {
      id: "r1", kind: "daily", time: "09:00", text: "uống vitamin", chatId: 111,
      nextISO: new Date(NOW - 60_000).toISOString(),
    };
    kv.store.set("recur:r1", JSON.stringify(rec));
    await runScheduled(env);
    expect(send).toHaveBeenCalledTimes(1);
    const after: RecurRecord = JSON.parse(kv.store.get("recur:r1")!);
    expect(Date.parse(after.nextISO)).toBeGreaterThan(Date.now());
  });
});
