// Parse tin nhắn tiếng Việt -> { title, dueISO } bằng Workers AI.
// Nếu AI lỗi/không hiểu giờ, vẫn trả title = nguyên văn để KHÔNG mất việc.

import { vnNowDescription, offsetStr, offsetMin, normalizeDueISO } from "./time";
import type { Env } from "./types";

export type Intent = "create" | "query" | "chat";

export interface ParsedTask {
  action: Intent;
  title: string;
  dueISO: string | null;
  priority: string | null;
  assignee: string | null; // tên người được giao (nếu câu có "giao/nhắn cho X")
  note: string | null; // lời nhắn riêng cho người được giao (nếu câu có "nhắn/nhắc ...")
  aiFallback: boolean; // true = AI lỗi/không trả JSON -> title là nguyên văn tin nhắn
}

const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];

// Workers AI free đôi khi xếp hàng RẤT lâu. Worker chỉ được chạy nền ~30s sau khi
// trả response — AI ngốn hết phần đó là bot bị ngắt TRƯỚC KHI kịp nhắn trả lời
// (đã xảy ra thật: issue tạo xong mà tin xác nhận không bao giờ tới). Quá hạn này
// thì bỏ AI, đi đường fallback để chắc chắn còn thời gian tạo issue + trả lời.
const AI_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`AI timeout sau ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export async function parseTask(text: string, env: Env): Promise<ParsedTask> {
  const model = env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const off = offsetStr(offsetMin(env));
  const system = [
    "Bạn là trợ lý quản lý công việc, đọc tin nhắn tiếng Việt.",
    `Bây giờ (giờ Việt Nam, UTC${off}) là: ${vnNowDescription(env)}.`,
    "Trả về DUY NHẤT một JSON object, KHÔNG markdown, KHÔNG giải thích, đúng dạng:",
    `{"action": "create"|"query"|"chat", "title": string, "due": string hoặc null, "priority": string hoặc null, "assignee": string hoặc null, "note": string hoặc null}`,
    '- action: "create" nếu muốn TẠO/ghi một việc mới; "query" nếu HỎI hoặc muốn XEM danh sách việc đang có (vd "có task nào", "việc nào chưa làm", "đang tồn đọng gì", "liệt kê task"); "chat" nếu chỉ chào hỏi / không liên quan công việc. Phân vân mà câu là CÂU HỎI thì chọn "query".',
    "- title: nội dung việc, ngắn gọn, BỎ phần mô tả thời gian VÀ BỎ phần giao cho ai (chỉ cần khi action=create).",
    `- due: nếu có nhắc thời gian (mai, thứ 6, 3h chiều, 15:00...), tính ra mốc cụ thể theo giờ VN và ghi ISO 8601 kèm ${off}. Không có thì null.`,
    '- priority: "Highest"/"High"/"Medium"/"Low"/"Lowest" theo mức khẩn ("khẩn cấp"->Highest, "gấp"/"khẩn"->High, "không gấp"->Low). Không rõ -> null.',
    '- assignee: nếu câu có ý GIAO/nhắn việc cho ai đó (vd "giao cho Trang", "nhắn cho Cẩm Cần luôn", "cho Lam làm", "báo Uyên") thì ghi TÊN người đó (chỉ tên, bỏ "cho/anh/chị"). Không có thì null.',
    '- note: nếu câu có LỜI NHẮN riêng cho người được giao (vd "nhắn Uyên nhớ lên task trên ERP", "dặn Tú làm trước 5h", "nhắc nộp file gốc") thì viết lại lời nhắn đó NHƯ ĐANG NÓI TRỰC TIẾP với họ, ngắn gọn (vd "Nhớ lên task trên hệ thống ERP nha"). Bỏ chữ "nhắn/dặn/nhắc <tên>". Không có thì null.',
    'Quy ước khi không nói rõ giờ: "sáng"=09:00, "trưa"=12:00, "chiều"=15:00, "tối"=20:00.',
  ].join("\n");

  try {
    const resp: any = await withTimeout(
      env.AI.run(model as any, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
        max_tokens: 256,
        temperature: 0.1,
      }) as Promise<any>,
      AI_TIMEOUT_MS,
    );
    // Workers AI tuỳ model/đời runtime trả `response` là chuỗi HOẶC object (JSON đã
    // parse sẵn). Object mà đem indexOf() -> "s.indexOf is not a function" làm parse
    // chết MỌI tin -> bot rơi fallback liên tục. Ép về chuỗi để extractJson luôn chạy.
    const r = typeof resp === "string" ? resp : resp?.response;
    const raw = typeof r === "string" ? r : r != null ? JSON.stringify(r) : "";
    const obj = extractJson(raw);
    if (!obj) {
      // Model trả chữ thừa/JSON hỏng — log để soi bằng wrangler tail, đừng nuốt im lặng.
      console.error("AI parse: không bóc được JSON", String(raw).slice(0, 200));
      return { action: "create", title: text, dueISO: null, priority: null, assignee: null, note: null, aiFallback: true };
    }
    const action: Intent = obj.action === "query" || obj.action === "chat" ? obj.action : "create";
    const title = (obj.title && String(obj.title).trim()) || text;
    const dueISO = obj.due ? normalizeDueISO(String(obj.due), offsetMin(env)) : null;
    const priority = obj.priority && PRIORITIES.includes(String(obj.priority)) ? String(obj.priority) : null;
    const assignee = obj.assignee ? String(obj.assignee).trim() || null : null;
    const note = obj.note ? String(obj.note).trim() || null : null;
    return { action, title, dueISO, priority, assignee, note, aiFallback: false };
  } catch (e) {
    console.error("AI parse failed", e);
    return { action: "create", title: text, dueISO: null, priority: null, assignee: null, note: null, aiFallback: true };
  }
}

// Bóc object JSON đầu tiên từ output (model đôi khi kèm chữ thừa).
function extractJson(s: string): any | null {
  if (!s) return null;
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i < 0 || j < 0 || j < i) return null;
  try {
    return JSON.parse(s.slice(i, j + 1));
  } catch {
    return null;
  }
}
