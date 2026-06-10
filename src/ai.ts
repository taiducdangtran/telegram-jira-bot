// Parse tin nhắn tiếng Việt -> { title, dueISO } bằng Workers AI.
// Nếu AI lỗi/không hiểu giờ, vẫn trả title = nguyên văn để KHÔNG mất việc.

import { vnNowDescription, offsetStr, offsetMin, normalizeDueISO } from "./time";

export interface ParsedTask {
  title: string;
  dueISO: string | null;
  priority: string | null;
}

const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];

export async function parseTask(text: string, env: any): Promise<ParsedTask> {
  const model = env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const off = offsetStr(offsetMin(env));
  const system = [
    "Bạn là trợ lý trích xuất công việc từ tin nhắn tiếng Việt.",
    `Bây giờ (giờ Việt Nam, UTC${off}) là: ${vnNowDescription(env)}.`,
    "Trả về DUY NHẤT một JSON object, KHÔNG markdown, KHÔNG giải thích, đúng dạng:",
    `{"title": string, "due": string hoặc null, "priority": string hoặc null}`,
    "- title: nội dung việc, ngắn gọn, BỎ phần mô tả thời gian.",
    `- due: nếu người dùng có nhắc thời gian (mai, thứ 6, 3h chiều, 15:00, cuối tháng...), hãy tính ra mốc cụ thể theo giờ VN và ghi ISO 8601 kèm ${off}. Nếu không có thời gian thì để null.`,
    '- priority: một trong "Highest"/"High"/"Medium"/"Low"/"Lowest" theo mức khẩn ("khẩn cấp"/"rất gấp"->Highest, "gấp"/"khẩn"/"ưu tiên cao"->High, "ưu tiên thấp"/"không gấp"->Low). Không rõ -> null.',
    'Quy ước khi không nói rõ giờ: "sáng"=09:00, "trưa"=12:00, "chiều"=15:00, "tối"=20:00.',
  ].join("\n");

  try {
    const resp: any = await env.AI.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      max_tokens: 256,
      temperature: 0.1,
    });
    const raw = typeof resp === "string" ? resp : resp?.response ?? "";
    const obj = extractJson(raw);
    if (!obj) return { title: text, dueISO: null, priority: null };
    const title = (obj.title && String(obj.title).trim()) || text;
    const dueISO = obj.due ? normalizeDueISO(String(obj.due), offsetMin(env)) : null;
    const priority = obj.priority && PRIORITIES.includes(String(obj.priority)) ? String(obj.priority) : null;
    return { title, dueISO, priority };
  } catch (e) {
    console.error("AI parse failed", e);
    return { title: text, dueISO: null, priority: null };
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
