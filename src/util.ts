// Hàm thuần dùng chung: parse/extract text, validate. KHÔNG đụng KV/Telegram/Jira
// — để test được bằng vitest thường và tránh import vòng.

export const p2 = (n: number) => String(n).padStart(2, "0");

export function safeParse(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}

// #hashtag -> labels (Jira label không có dấu cách); trả về text đã gỡ tag.
export function extractLabels(text: string): { labels: string[]; text: string } {
  const labels: string[] = [];
  const cleaned = String(text).replace(/(^|\s)#([\p{L}\d_]{1,50})/gu, (_m, sp, tag) => {
    labels.push(tag);
    return sp;
  });
  return { labels, text: cleaned.replace(/\s+/g, " ").trim() };
}

// Đoán priority từ từ khoá tiếng Việt (dùng cho /note; đường AI tự đoán riêng).
// Low kiểm tra TRƯỚC High: "không gấp" chứa từ "gấp" — để sau sẽ dính nhầm High.
export function detectPriority(text: string): string | null {
  const t = String(text).toLowerCase();
  if (/khẩn cấp|rất gấp|cực gấp|gấp lắm|urgent|asap/.test(t)) return "Highest";
  if (/ưu tiên thấp|không gấp|thong thả|từ từ|lúc nào cũng được/.test(t)) return "Low";
  if (/\bgấp\b|khẩn|ưu tiên cao|quan trọng/.test(t)) return "High";
  return null;
}

export function extractIssueKey(text: string | undefined): string | null {
  if (!text) return null;
  const m = String(text).match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : null;
}

// Câu hỏi/tra cứu việc ("có task nào tồn đọng không?") -> nên LIỆT KÊ, không tạo task.
export function looksLikeQuery(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^(tạo|thêm|ghi|nhắc|add|new)\b/.test(t)) return false; // rõ ràng là tạo việc
  const taskWord = /(task|việc|cần làm|tồn đọng|chưa (làm|xong|hoàn)|đang làm|deadline|hạn chót|to-?do|đầu việc)/.test(t);
  const question =
    /\?\s*$/.test(t) ||
    /(không|chưa)\s*\??$/.test(t) ||
    /^(có |còn |bao nhiêu|mấy |liệt kê|xem |cho .*xem|thống kê|danh sách|list\b|show\b)/.test(t);
  return taskWord && question;
}

// Chào hỏi / xác nhận ngắn -> không phải task.
export function looksLikeGreeting(text: string): boolean {
  const t = text.trim();
  return t.length <= 20 && /^(hi|hello|hey|chào|chao|alo|ok|oke|okê|okay|cảm ơn|cám ơn|thanks?|tks|ừ|uh|ờ|vâng|dạ|yes|yeah)\b/i.test(t);
}

// "8:00" | "08:00" | "8h" | "8h30" -> [h, m] hợp lệ, hoặc null.
export function parseClock(tok: string): [number, number] | null {
  const m = tok.match(/^(\d{1,2})(?::|h|g)(\d{2})?$/i);
  if (!m) return null;
  const h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (h > 23 || mi > 59) return null;
  return [h, mi];
}

// Thứ tự QUAN TRỌNG: cụm dài/đặc thù trước cụm ngắn (cho nhánh includes phía dưới).
// Cụm PHỦ ĐỊNH ("không gấp") phải đứng TRƯỚC "gấp" — không thì includes dính nhầm High.
const PRIO_MAP: [string, string][] = [
  ["không gấp", "Low"], ["ưu tiên thấp", "Low"],
  ["khẩn cấp", "Highest"], ["rất cao", "Highest"], ["cao nhất", "Highest"], ["highest", "Highest"],
  ["gấp", "High"], ["khẩn", "High"], ["cao", "High"], ["high", "High"],
  ["trung bình", "Medium"], ["tb", "Medium"], ["vừa", "Medium"], ["medium", "Medium"],
  ["thấp nhất", "Lowest"], ["lowest", "Lowest"],
  ["thấp", "Low"], ["low", "Low"],
];

// Từ khoá tiếng Việt/English -> tên priority Jira, hoặc null nếu không khớp.
export function matchPriority(raw: string): string | null {
  const hit = PRIO_MAP.find(([k]) => k === raw) || PRIO_MAP.find(([k]) => raw.includes(k));
  return hit ? hit[1] : null;
}

// Nhiều lệnh dán 1 lúc (mỗi dòng 1 lệnh) -> tách ra chạy lần lượt.
// Chỉ coi là "batch" khi có >=2 dòng bắt đầu bằng "/" (tránh cắt nhầm ghi chú nhiều dòng).
export function splitBatchCommands(text: string): string[] | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const cmds = lines.filter((l) => l.startsWith("/"));
  return cmds.length >= 2 ? cmds : null;
}

// Bỏ "cho"/"to" đứng đầu khi giao việc: "cho Trang" -> "Trang", "cho" -> "".
// Dùng \b để không cắt nhầm tên dính liền ("Chương" giữ nguyên).
export function cleanAssignee(raw: string): string {
  return String(raw).replace(/^(cho|to)\b\s*/i, "").trim();
}

// Project key Jira hợp lệ: chữ hoa đầu, chữ hoa/số phía sau, tối đa 10 ký tự.
// Phòng thủ trước khi nội suy vào JQL (/useproject đã xác thực qua API rồi).
export function validateProjectKey(key: string): boolean {
  return /^[A-Z][A-Z0-9]{1,9}$/.test(key);
}
