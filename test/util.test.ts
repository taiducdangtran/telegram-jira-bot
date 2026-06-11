// Test hàm thuần trong src/util.ts.
import { describe, it, expect } from "vitest";
import {
  extractLabels, detectPriority, extractIssueKey, looksLikeQuery, looksLikeGreeting,
  parseClock, matchPriority, validateProjectKey, safeParse, p2,
} from "../src/util";

describe("extractLabels", () => {
  it("gỡ #tag khỏi text, gom thành labels", () => {
    const r = extractLabels("nộp báo cáo gấp #sales #q3_2026");
    expect(r.labels).toEqual(["sales", "q3_2026"]);
    expect(r.text).toBe("nộp báo cáo gấp");
  });
  it("tag tiếng Việt có dấu", () => {
    const r = extractLabels("họp #kếtoán xong gửi mail");
    expect(r.labels).toEqual(["kếtoán"]);
    expect(r.text).toBe("họp xong gửi mail");
  });
  it("không có tag -> giữ nguyên", () => {
    const r = extractLabels("làm việc bình thường");
    expect(r.labels).toEqual([]);
    expect(r.text).toBe("làm việc bình thường");
  });
});

describe("detectPriority", () => {
  it("khẩn cấp/urgent -> Highest", () => {
    expect(detectPriority("việc khẩn cấp")).toBe("Highest");
    expect(detectPriority("urgent: deploy")).toBe("Highest");
  });
  it("gấp/khẩn/quan trọng -> High", () => {
    expect(detectPriority("nộp báo cáo gấp")).toBe("High");
    expect(detectPriority("việc quan trọng")).toBe("High");
  });
  it("không gấp -> Low; bình thường -> null", () => {
    expect(detectPriority("không gấp đâu")).toBe("Low");
    expect(detectPriority("gọi khách A")).toBeNull();
  });
});

describe("extractIssueKey", () => {
  it("bắt mã dạng KAN-12", () => {
    expect(extractIssueKey("xoá KAN-105 đi")).toBe("KAN-105");
    expect(extractIssueKey("✅ Đã tạo: ...\n🔖 AB2-7")).toBe("AB2-7");
  });
  it("không có mã -> null", () => {
    expect(extractIssueKey("không có gì")).toBeNull();
    expect(extractIssueKey(undefined)).toBeNull();
    expect(extractIssueKey("kan-12 thường")).toBeNull(); // phải viết hoa
  });
});

describe("looksLikeQuery", () => {
  it("câu hỏi về task -> true", () => {
    expect(looksLikeQuery("có task nào chưa làm không?")).toBe(true);
    expect(looksLikeQuery("liệt kê việc tồn đọng")).toBe(true);
    expect(looksLikeQuery("còn việc nào đang làm không")).toBe(true);
  });
  it("câu tạo việc -> false", () => {
    expect(looksLikeQuery("tạo task gọi khách")).toBe(false);
    expect(looksLikeQuery("mai 3h chiều gọi khách A")).toBe(false);
  });
});

describe("looksLikeGreeting", () => {
  it("chào hỏi ngắn -> true", () => {
    expect(looksLikeGreeting("hi")).toBe(true);
    expect(looksLikeGreeting("chào bot")).toBe(true);
    expect(looksLikeGreeting("cảm ơn nhé")).toBe(true);
  });
  it("nội dung việc -> false", () => {
    expect(looksLikeGreeting("ok nhưng mai nhớ gọi khách A lúc 3h chiều nhé")).toBe(false); // dài
    expect(looksLikeGreeting("gọi khách A")).toBe(false);
  });
});

describe("parseClock", () => {
  it("hiểu 8:00 / 08:00 / 8h / 8h30 / 8g30", () => {
    expect(parseClock("8:00")).toEqual([8, 0]);
    expect(parseClock("08:05")).toEqual([8, 5]);
    expect(parseClock("8h")).toEqual([8, 0]);
    expect(parseClock("8h30")).toEqual([8, 30]);
    expect(parseClock("8g30")).toEqual([8, 30]);
  });
  it("ngoài khoảng / rác -> null", () => {
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("8:99")).toBeNull();
    expect(parseClock("tám giờ")).toBeNull();
  });
});

describe("matchPriority", () => {
  it("khớp đúng cụm", () => {
    expect(matchPriority("cao nhất")).toBe("Highest");
    expect(matchPriority("khẩn cấp")).toBe("Highest");
    expect(matchPriority("cao")).toBe("High");
    expect(matchPriority("trung bình")).toBe("Medium");
    expect(matchPriority("thấp nhất")).toBe("Lowest");
    expect(matchPriority("thấp")).toBe("Low");
  });
  it("khớp includes: 'ưu tiên rất cao' -> Highest", () => {
    expect(matchPriority("ưu tiên rất cao")).toBe("Highest");
  });
  it("phủ định: 'không gấp' -> Low (không dính nhầm 'gấp' -> High)", () => {
    expect(matchPriority("không gấp")).toBe("Low");
    expect(matchPriority("ưu tiên thấp")).toBe("Low");
  });
  it("không khớp -> null", () => {
    expect(matchPriority("vô địch")).toBeNull();
  });
});

describe("validateProjectKey", () => {
  it("key hợp lệ", () => {
    expect(validateProjectKey("KAN")).toBe(true);
    expect(validateProjectKey("AB2")).toBe(true);
    expect(validateProjectKey("PROJ123456".slice(0, 10))).toBe(true);
  });
  it("key bẩn / sai dạng -> false (chặn nội suy JQL)", () => {
    expect(validateProjectKey("")).toBe(false);
    expect(validateProjectKey("K")).toBe(false); // quá ngắn
    expect(validateProjectKey("kan")).toBe(false);
    expect(validateProjectKey('KAN" OR 1=1')).toBe(false);
    expect(validateProjectKey("2AB")).toBe(false); // phải bắt đầu bằng chữ
    expect(validateProjectKey("AAAAAAAAAAAA")).toBe(false); // quá dài
  });
});

describe("safeParse / p2", () => {
  it("safeParse trả null khi JSON hỏng", () => {
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeParse("{hỏng")).toBeNull();
  });
  it("p2 pad 2 chữ số", () => {
    expect(p2(5)).toBe("05");
    expect(p2(12)).toBe("12");
  });
});
