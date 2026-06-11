// Test hàm thuần trong src/time.ts — chốt hành vi trước khi refactor.
// Mốc "bây giờ" cố định: 2026-06-10 10:00 giờ VN (= 2026-06-10T03:00:00Z, Thứ Tư).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  offsetMin, offsetStr, nowVN, isoFromMs, msFromVN, formatVN, ymd, hhmmVN,
  normalizeDueISO, parseDueStrict, nextDailyISO, nextWeeklyISO, parseDow, parseRelative,
} from "../src/time";

const MIN = 420; // UTC+7
const ENV = { TZ_OFFSET_MINUTES: "420" };
const NOW_UTC = Date.parse("2026-06-10T03:00:00Z"); // 10:00 VN, Thứ Tư

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_UTC);
});
afterEach(() => {
  vi.useRealTimers();
});

// nowVN trả Date mà các getter UTC* là "đồng hồ treo tường" VN.
const wallNow = () => nowVN(ENV);

describe("offsetMin / offsetStr", () => {
  it("đọc TZ_OFFSET_MINUTES, mặc định 420", () => {
    expect(offsetMin(ENV)).toBe(420);
    expect(offsetMin({})).toBe(420);
    expect(offsetMin({ TZ_OFFSET_MINUTES: "xyz" })).toBe(420);
    expect(offsetMin({ TZ_OFFSET_MINUTES: "-330" })).toBe(-330);
  });
  it("format offset", () => {
    expect(offsetStr(420)).toBe("+07:00");
    expect(offsetStr(-330)).toBe("-05:30");
  });
});

describe("isoFromMs / formatVN / ymd / hhmmVN", () => {
  const iso = "2026-06-12T15:00:00+07:00";
  it("round-trip ISO kèm offset VN", () => {
    expect(isoFromMs(Date.parse(iso), MIN)).toBe(iso);
    expect(isoFromMs(msFromVN(2026, 6, 12, 15, 0, MIN), MIN)).toBe(iso);
  });
  it("hiển thị dd/mm/yyyy HH:MM", () => {
    expect(formatVN(iso, MIN)).toBe("12/06/2026 15:00");
  });
  it("phần ngày và giờ-phút theo VN", () => {
    expect(ymd(iso, MIN)).toBe("2026-06-12");
    expect(hhmmVN(iso, MIN)).toBe("15:00");
    expect(ymd("rác", MIN)).toBeNull();
    expect(hhmmVN("rác", MIN)).toBeNull();
  });
  it("giữ đúng mốc tuyệt đối khi đổi múi giờ biểu diễn", () => {
    // 2026-06-12T08:00Z == 15:00 VN
    expect(isoFromMs(Date.parse("2026-06-12T08:00:00Z"), MIN)).toBe(iso);
  });
});

describe("normalizeDueISO", () => {
  it("có sẵn Z/offset -> giữ mốc tuyệt đối, biểu diễn theo VN", () => {
    expect(normalizeDueISO("2026-06-12T08:00:00Z", MIN)).toBe("2026-06-12T15:00:00+07:00");
    expect(normalizeDueISO("2026-06-12T15:00:00+07:00", MIN)).toBe("2026-06-12T15:00:00+07:00");
  });
  it("datetime không offset -> coi là giờ VN", () => {
    expect(normalizeDueISO("2026-06-12T15:00", MIN)).toBe("2026-06-12T15:00:00+07:00");
    expect(normalizeDueISO("2026-06-12 15:00", MIN)).toBe("2026-06-12T15:00:00+07:00");
  });
  it("chỉ có ngày -> 09:00 VN", () => {
    expect(normalizeDueISO("2026-06-12", MIN)).toBe("2026-06-12T09:00:00+07:00");
  });
  it("rác/null -> null", () => {
    expect(normalizeDueISO(null, MIN)).toBeNull();
    expect(normalizeDueISO(undefined, MIN)).toBeNull();
    expect(normalizeDueISO("không phải ngày", MIN)).toBeNull();
  });
});

describe("parseDueStrict", () => {
  const parse = (s: string) => parseDueStrict(s, MIN, wallNow());

  it("DD/MM HH:MM", () => {
    expect(parse("12/06 15:00")).toBe("2026-06-12T15:00:00+07:00");
  });
  it("ISO date + giờ kiểu VN", () => {
    expect(parse("2026-06-12 15:00")).toBe("2026-06-12T15:00:00+07:00");
    expect(parse("12/6/26 9h")).toBe("2026-06-12T09:00:00+07:00");
  });
  it("chuẩn hoá 9h30 / 15h / 9g5", () => {
    // 09:30 đã qua (now 10:00) -> đẩy sang mai; 15:00 còn trong hôm nay.
    expect(parse("9h30")).toBe("2026-06-11T09:30:00+07:00");
    expect(parse("15h")).toBe("2026-06-10T15:00:00+07:00");
    expect(parse("9g5")).toBe("2026-06-11T09:05:00+07:00");
  });
  it("chỉ có ngày -> 09:00", () => {
    expect(parse("12/06")).toBe("2026-06-12T09:00:00+07:00");
  });
  it("DD/MM không kèm năm mà đã qua -> năm sau", () => {
    expect(parse("01/01 10:00")).toBe("2027-01-01T10:00:00+07:00");
  });
  it("ngày không tồn tại -> null", () => {
    expect(parse("31/06 10:00")).toBeNull();
    expect(parse("29/02 10:00")).toBeNull(); // 2026 không nhuận
    expect(parse("32/01 10:00")).toBeNull();
  });
  it("giờ/phút ngoài khoảng -> null", () => {
    expect(parse("25:00")).toBeNull();
    expect(parse("9:99")).toBeNull();
  });
  it("'3h chiều' mơ hồ -> null (nhường đường AI)", () => {
    expect(parse("3h chiều")).toBeNull();
    expect(parse("8h tối")).toBeNull();
  });
  it("không hiểu -> null", () => {
    expect(parse("")).toBeNull();
    expect(parse("hôm nào đó")).toBeNull();
  });
});

describe("nextDailyISO / nextWeeklyISO", () => {
  it("daily: giờ đã qua hôm nay -> mai, chưa qua -> hôm nay", () => {
    expect(nextDailyISO("08:00", ENV)).toBe("2026-06-11T08:00:00+07:00");
    expect(nextDailyISO("23:00", ENV)).toBe("2026-06-10T23:00:00+07:00");
  });
  it("weekly: luôn ở tương lai", () => {
    // 2026-06-10 là Thứ Tư (dow=3). 09:00 hôm nay đã qua -> tuần sau.
    expect(nextWeeklyISO(3, "09:00", ENV)).toBe("2026-06-17T09:00:00+07:00");
    expect(nextWeeklyISO(3, "23:00", ENV)).toBe("2026-06-10T23:00:00+07:00");
    expect(nextWeeklyISO(1, "09:00", ENV)).toBe("2026-06-15T09:00:00+07:00"); // Thứ Hai
    expect(nextWeeklyISO(0, "09:00", ENV)).toBe("2026-06-14T09:00:00+07:00"); // Chủ Nhật
  });
  it("kết quả luôn > bây giờ", () => {
    for (const d of [0, 1, 2, 3, 4, 5, 6]) {
      const iso = nextWeeklyISO(d, "10:00", ENV);
      expect(Date.parse(iso)).toBeGreaterThan(Date.now());
    }
  });
});

describe("parseDow", () => {
  it("hiểu t2..t7, cn, thuX, số 2..8", () => {
    expect(parseDow("t2")).toBe(1);
    expect(parseDow("T6")).toBe(5);
    expect(parseDow("cn")).toBe(0);
    expect(parseDow("chủ nhật".normalize("NFD").replace(/[̀-ͯ]/g, ""))).toBe(0); // "chu nhat" -> sau khi bỏ space: "chunhat"
    expect(parseDow("thu 2")).toBe(1);
    expect(parseDow("8")).toBe(0);
    expect(parseDow("2")).toBe(1);
    expect(parseDow("t8")).toBeNull();
    expect(parseDow("xyz")).toBeNull();
  });
});

describe("parseRelative", () => {
  it("'X phút nữa' -> mốc tương lai + text đã gỡ cụm giờ", () => {
    const r = parseRelative("3 phút nữa gọi shipper", ENV);
    expect(r).not.toBeNull();
    expect(r!.dueISO).toBe("2026-06-10T10:03:00+07:00");
    expect(r!.text).toBe("gọi shipper");
  });
  it("viết tắt '3p nữa', '2g nữa'", () => {
    expect(parseRelative("3p nữa test", ENV)!.dueISO).toBe("2026-06-10T10:03:00+07:00");
    expect(parseRelative("2g nữa họp", ENV)!.dueISO).toBe("2026-06-10T12:00:00+07:00");
  });
  it("'2 tiếng nữa', '1 ngày sau'", () => {
    expect(parseRelative("2 tiếng nữa họp team", ENV)!.dueISO).toBe("2026-06-10T12:00:00+07:00");
    expect(parseRelative("1 ngày sau nộp báo cáo", ENV)!.dueISO).toBe("2026-06-11T10:00:00+07:00");
  });
  it("số 0/âm hoặc không có cụm thời gian -> null", () => {
    expect(parseRelative("0 phút nữa làm gì đó", ENV)).toBeNull();
    expect(parseRelative("làm báo cáo", ENV)).toBeNull();
  });
});
