// Tiện ích thời gian theo múi giờ Việt Nam (UTC+7, không có DST nên offset cố định).
import type { TzEnv } from "./types";

// Mọi mốc giờ "đầy đủ" được lưu dạng ISO 8601 kèm offset, ví dụ 2026-06-12T15:00:00+07:00.

const DOW = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function offsetMin(env: TzEnv): number {
  const v = parseInt(env?.TZ_OFFSET_MINUTES ?? "420", 10);
  return Number.isFinite(v) ? v : 420;
}

export function offsetStr(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// Date có các getter UTC* trả về "đồng hồ treo tường" giờ VN.
export function nowVN(env: TzEnv): Date {
  return new Date(Date.now() + offsetMin(env) * 60000);
}

// Từ giờ treo tường VN (y, mo[1-12], d, h, mi) -> mốc UTC (ms thật).
export function msFromVN(y: number, mo: number, d: number, h: number, mi: number, min: number): number {
  return Date.UTC(y, mo - 1, d, h, mi, 0) - min * 60000;
}

// ms thật -> chuỗi ISO kèm offset VN.
export function isoFromMs(ms: number, min: number): string {
  const d = new Date(ms + min * 60000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${offsetStr(min)}`
  );
}

// Hiển thị thân thiện: dd/mm/yyyy HH:MM (giờ VN).
export function formatVN(iso: string, min: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + min * 60000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Phần ngày YYYY-MM-DD (giờ VN) — để set Jira duedate.
export function ymd(iso: string, min: number): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + min * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Mô tả "bây giờ" cho prompt AI (kèm thứ trong tuần).
export function vnNowDescription(env: TzEnv): string {
  const d = nowVN(env);
  return `${DOW[d.getUTCDay()]}, ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Chuẩn hoá chuỗi "due" mà AI trả về thành ISO kèm offset VN.
// - Có sẵn offset/Z  -> giữ nguyên mốc tuyệt đối.
// - Datetime không offset -> coi là giờ VN.
// - Chỉ có ngày -> mặc định 09:00 VN.
export function normalizeDueISO(s: string | null | undefined, min: number): string | null {
  if (!s || typeof s !== "string") return null;
  s = s.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : isoFromMs(ms, min);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (m) return isoFromMs(msFromVN(+m[1], +m[2], +m[3], +m[4], +m[5], min), min);
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return isoFromMs(msFromVN(+m[1], +m[2], +m[3], 9, 0, min), min);
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : isoFromMs(ms, min);
}

function normYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

// Parser TẤT ĐỊNH (không dùng AI) cho cú pháp /note ... // <thời gian>.
// Hỗ trợ: 2026-06-12 15:00 | 12/06 15:00 | 12/6/26 9h | 15:00 | 9h30 | 9h5 | 15h
// Trả về ISO kèm offset, hoặc null nếu không hiểu / giờ-ngày không hợp lệ.
export function parseDueStrict(input: string, min: number, now: Date): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();

  // "3h chiều" là mơ hồ với parser số -> để đường AI lo, ở đây trả null (sẽ cảnh báo).
  if (/\d{1,2}\s*[hg]?\s*(chiều|tối|trưa|sáng)/.test(s)) return null;

  // Chuẩn hoá giờ kiểu VN: "15h"->"15:00", "9h30"->"9:30", "9h5"->"9:05", "9g30"->"9:30"
  s = s
    .replace(/(\d{1,2})\s*[hg]\s*(\d{1,2})\b/g, (_m, h, mi) => `${h}:${String(mi).padStart(2, "0")}`)
    .replace(/(\d{1,2})\s*[hg](?![:\d])/g, "$1:00");

  let day: number | undefined, month: number | undefined, year: number | undefined;
  let yearInferred = false;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    year = +m[1]; month = +m[2]; day = +m[3];
  } else if ((m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
    day = +m[1]; month = +m[2];
    yearInferred = !m[3];
    year = m[3] ? normYear(+m[3]) : now.getUTCFullYear();
  }

  let hour: number | undefined, minute: number | undefined;
  const tm = s.match(/(\d{1,2}):(\d{2})/);
  if (tm) { hour = +tm[1]; minute = +tm[2]; }

  if (day === undefined && hour === undefined) return null;
  // Chặn giờ/phút ngoài khoảng (25:00, 09:99) — Date.UTC sẽ "cuộn" âm thầm nếu không chặn.
  if (hour !== undefined && (hour > 23 || (minute ?? 0) > 59)) return null;

  // Chỉ có giờ -> hôm nay; nếu đã qua thì đẩy sang mai.
  if (day === undefined) {
    const ms0 = msFromVN(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), hour!, minute ?? 0, min);
    const ms = ms0 <= Date.now() ? ms0 + 86400000 : ms0;
    return isoFromMs(ms, min);
  }
  if (hour === undefined) { hour = 9; minute = 0; }
  if (minute === undefined) minute = 0;
  if (month! < 1 || month! > 12 || day < 1 || day > 31) return null;

  let ms = msFromVN(year!, month!, day, hour, minute, min);
  // Ngày dương lịch không tồn tại (31/06, 29/02 năm thường) -> Date.UTC cuộn sang tháng sau: loại.
  const back = new Date(ms + min * 60000);
  if (back.getUTCMonth() + 1 !== month! || back.getUTCDate() !== day) return null;
  // DD/MM không kèm năm mà đã trôi qua trong năm nay -> hiểu là năm sau.
  if (yearInferred && ms < now.getTime()) {
    ms = msFromVN(year! + 1, month!, day, hour, minute, min);
  }
  return isoFromMs(ms, min);
}

// ---- Hỗ trợ nhắc lặp (recurring) ----

// "HH:MM" theo giờ VN từ một ISO.
export function hhmmVN(iso: string, min: number): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + min * 60000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Lần xảy ra kế tiếp của mốc "HH:MM" hằng ngày (giờ VN), luôn ở tương lai.
export function nextDailyISO(time: string, env: TzEnv): string {
  const [h, mi] = time.split(":").map(Number);
  const min = offsetMin(env);
  const n = nowVN(env);
  let ms = msFromVN(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), h, mi, min);
  if (ms <= Date.now()) ms += 86400000;
  return isoFromMs(ms, min);
}

// Lần xảy ra kế tiếp của (thứ trong tuần, HH:MM) theo giờ VN, luôn ở tương lai.
export function nextWeeklyISO(dow: number, time: string, env: TzEnv): string {
  const [h, mi] = time.split(":").map(Number);
  const min = offsetMin(env);
  const n = nowVN(env);
  for (let i = 0; i < 8; i++) {
    const ms = msFromVN(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate() + i, h, mi, min);
    const d = new Date(ms + min * 60000);
    if (d.getUTCDay() === dow && ms > Date.now()) return isoFromMs(ms, min);
  }
  return isoFromMs(msFromVN(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate() + 7, h, mi, min), min);
}

// "t2".."t7", "cn", hoặc số 2..8 -> 0(CN)..6(T7). null nếu không hiểu.
export function parseDow(token: string): number | null {
  const t = token.trim().toLowerCase().replace(/[.\s]/g, "");
  const map: Record<string, number> = {
    cn: 0, chunhat: 0, t2: 1, t3: 2, t4: 3, t5: 4, t6: 5, t7: 6,
    thu2: 1, thu3: 2, thu4: 3, thu5: 4, thu6: 5, thu7: 6,
    "2": 1, "3": 2, "4": 3, "5": 4, "6": 5, "7": 6, "8": 0,
  };
  return t in map ? map[t] : null;
}

export function dowNameVN(d: number): string {
  return DOW[((d % 7) + 7) % 7];
}

// "3 phút nữa", "2 tiếng nữa", "1 ngày sau" -> mốc tương lai + text đã gỡ cụm thời gian.
// Trả null nếu không khớp.
export function parseRelative(text: string, env: TzEnv): { dueISO: string; text: string } | null {
  const m = text.match(/(\d+)\s*(phút|phut|p|tiếng|tieng|giờ|gio|g|h|ngày|ngay)\s*(nữa|nua|sau|tới|toi)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2].toLowerCase();
  const isMin = ["phút", "phut", "p"].includes(u);
  const isHour = ["tiếng", "tieng", "giờ", "gio", "g", "h"].includes(u);
  const ms = Date.now() + (isMin ? n * 60000 : isHour ? n * 3600000 : n * 86400000);
  const cleaned = text.replace(m[0], " ").replace(/\s+/g, " ").trim();
  return { dueISO: isoFromMs(ms, offsetMin(env)), text: cleaned };
}
