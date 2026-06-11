// Test parseTask — quan trọng nhất: AI treo lâu phải bị cắt sau AI_TIMEOUT_MS
// và trả fallback (sự cố thật: AI xếp hàng ~30s -> worker bị ngắt trước khi trả lời).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseTask } from "../src/ai";

const baseEnv = (run: (...args: any[]) => Promise<any>): any => ({
  AI: { run },
  TZ_OFFSET_MINUTES: "420",
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-06-10T03:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("parseTask", () => {
  it("AI trả JSON chuẩn -> parse đủ trường, aiFallback=false", async () => {
    const env = baseEnv(async () => ({
      response: '{"action":"create","title":"gọi khách A","due":"2026-06-12T15:00:00+07:00","priority":"High","assignee":null}',
    }));
    const r = await parseTask("mai gọi khách A gấp", env);
    expect(r).toEqual({
      action: "create", title: "gọi khách A",
      dueISO: "2026-06-12T15:00:00+07:00", priority: "High", assignee: null, aiFallback: false,
    });
  });

  it("trích được assignee khi câu có 'giao cho X'", async () => {
    const env = baseEnv(async () => ({
      response: '{"action":"create","title":"quay video sản phẩm","due":null,"priority":null,"assignee":"Trang"}',
    }));
    const r = await parseTask("quay video sản phẩm giao cho Trang", env);
    expect(r.assignee).toBe("Trang");
    expect(r.title).toBe("quay video sản phẩm");
  });

  it("AI treo quá 12s -> cắt, fallback nguyên văn, KHÔNG chờ mãi", async () => {
    const env = baseEnv(() => new Promise(() => {})); // không bao giờ resolve
    const p = parseTask("5 phút nữa test", env);
    await vi.advanceTimersByTimeAsync(12_001);
    const r = await p;
    expect(r.aiFallback).toBe(true);
    expect(r.title).toBe("5 phút nữa test");
    expect(r.action).toBe("create");
  });

  it("AI trả rác không phải JSON -> fallback + aiFallback=true", async () => {
    const env = baseEnv(async () => ({ response: "Xin chào! Tôi nghĩ rằng..." }));
    const r = await parseTask("nộp báo cáo", env);
    expect(r.aiFallback).toBe(true);
    expect(r.title).toBe("nộp báo cáo");
  });

  it("AI throw -> fallback, không vỡ", async () => {
    const env = baseEnv(async () => { throw new Error("quota exceeded"); });
    const r = await parseTask("họp team", env);
    expect(r.aiFallback).toBe(true);
    expect(r.title).toBe("họp team");
  });
});
