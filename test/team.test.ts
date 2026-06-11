// Test findMember/normName — chống hồi quy lỗi "DM nhầm người" (khớp substring 2 chiều).
import { describe, it, expect } from "vitest";
import { findMember, normName } from "../src/team";
import type { TeamMember } from "../src/types";

// KV stub tối giản trong RAM — đủ cho loadByPrefix (list + get).
function makeKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list(opts: any = {}) {
      let keys = [...store.keys()];
      if (opts?.prefix) keys = keys.filter((k) => k.startsWith(opts.prefix));
      return { keys: keys.map((name) => ({ name })), list_complete: true };
    },
  };
}

function envWith(members: TeamMember[]): any {
  const kv = makeKV();
  for (const m of members) kv.store.set(`team:${normName(m.alias)}`, JSON.stringify(m));
  return { BOT_KV: kv };
}

const TU: TeamMember = { alias: "Tú", chatId: 111, jiraAccountId: "acc-tu", jiraDisplayName: "Tú Nguyễn", addedAtISO: "" };
const TUAN: TeamMember = { alias: "Tuấn", chatId: 222, addedAtISO: "" };
const AN: TeamMember = { alias: "An", chatId: 333, addedAtISO: "" };
const MEN: TeamMember = { alias: "Mến", chatId: 444, addedAtISO: "" };

describe("normName", () => {
  it("bỏ dấu + đ->d + thường hoá", () => {
    expect(normName("Đức")).toBe("duc");
    expect(normName("Tú  Nguyễn")).toBe("tu nguyen");
    expect(normName("HẰNG")).toBe("hang");
  });
});

describe("findMember", () => {
  it("accountId thắng tuyệt đối", async () => {
    const env = envWith([TU, TUAN]);
    expect((await findMember(env, { accountId: "acc-tu" }))?.chatId).toBe(111);
  });
  it("alias khớp đúng (bỏ dấu)", async () => {
    const env = envWith([TU, TUAN]);
    expect((await findMember(env, { name: "Tuấn" }))?.chatId).toBe(222);
    expect((await findMember(env, { name: "tu" }))?.chatId).toBe(111);
  });
  it("khớp theo TỪ: alias 'Tú' ↔ tên Jira 'Tú Nguyễn', 'An' trong 'Nguyễn Văn An'", async () => {
    const env = envWith([TU, AN]);
    expect((await findMember(env, { name: "Tú Nguyễn" }))?.chatId).toBe(111);
    expect((await findMember(env, { name: "Nguyễn Văn An" }))?.chatId).toBe(333);
  });
  it("KHÔNG khớp substring: 'Tú' không ăn 'Tuấn', 'Thanh' không ăn 'An', 'me' không ăn 'Mến'", async () => {
    expect(await findMember(envWith([TUAN]), { name: "Tú" })).toBeNull();
    expect(await findMember(envWith([AN]), { name: "Thanh" })).toBeNull();
    expect(await findMember(envWith([MEN]), { name: "me" })).toBeNull();
  });
  it("query quá ngắn (<2 ký tự sau chuẩn hoá) -> null", async () => {
    expect(await findMember(envWith([TU, TUAN]), { name: "t" })).toBeNull();
  });
  it("không có ai / không tham số -> null", async () => {
    expect(await findMember(envWith([]), { name: "Tú" })).toBeNull();
    expect(await findMember(envWith([TU]), {})).toBeNull();
  });
});
