# Telegram → Jira bot

Bot Telegram để **ghi việc** và **nhắc lịch**. Nhắn cho bot bằng tiếng Việt tự nhiên
("mai 3h chiều gọi khách A") hoặc lệnh (`/note ... // 12/06 15:00`) → bot tạo **issue trên Jira**
và **tự nhắc bạn đúng giờ** qua Telegram, kèm nút **✅ Hoàn thành / ⏰ +1h / 🌅 Sáng mai**.

Chạy hoàn toàn trên **Cloudflare Workers** (miễn phí, 24/7). Không cần server riêng.

---

## Kiến trúc (1 phút)

```
Telegram  ──POST /webhook──▶  Cloudflare Worker ──REST──▶  Jira Cloud (tạo issue)
                                     │
                                     ├── Workers AI  (parse "mai 3h chiều" → giờ cụ thể)
                                     │
                                     └── KV  (lưu GIỜ nhắc + project/owner)
                                          ▲
   Cron Trigger (mỗi 5') ───────────────┘  quét KV, tới giờ thì bắn nhắc về Telegram
```

> **Vì sao KV giữ giờ nhắc?** Jira `duedate` chỉ có **ngày, không có giờ**. Nên giờ-phút
> được lưu trong KV (nguồn sự thật), còn Jira vẫn set `duedate` để hiển thị trên board.

---

## Cần chuẩn bị (3 thứ)

### 1. Telegram Bot token
1. Mở Telegram, chat với **@BotFather** → `/newbot`.
2. Đặt tên + username (kết thúc bằng `bot`). Copy **token** dạng `123456789:AA...`.

### 2. Jira Cloud (email + API token + base URL)
1. **Base URL**: chính là `https://<tên-site>.atlassian.net` của bạn.
2. **Email**: email tài khoản Atlassian.
3. **API token**: vào https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token** → copy.
4. **Project key**: mở project trong Jira, key là tiền tố mã issue (vd issue `KAN-12` → key là `KAN`).
   Không nhớ cũng được — lát gõ `/projects` trong bot để xem.

### 3. Tài khoản Cloudflare (miễn phí)
Đăng ký tại https://dash.cloudflare.com nếu chưa có.

---

## Cài đặt & deploy

```bash
cd "telegram-jira-bot"
npm install
npx wrangler login            # mở trình duyệt đăng nhập Cloudflare

# Tạo KV namespace → copy "id" in ra rồi dán vào wrangler.jsonc (kv_namespaces[0].id)
npx wrangler kv namespace create BOT_KV
```

Mở **`wrangler.jsonc`** sửa:
- `kv_namespaces[0].id` → id vừa tạo.
- `vars.JIRA_BASE_URL` → `https://<tên-site>.atlassian.net`.
- (tuỳ chọn) `vars.JIRA_PROJECT_KEY` → key mặc định, hoặc để trống rồi chọn bằng `/useproject`.
- (tuỳ chọn) `vars.JIRA_ISSUE_TYPE` → mặc định `Task`; đổi nếu project dùng loại khác.

Đặt các **secret** (không nằm trong file, an toàn hơn):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN       # token từ BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # tự đặt 1 chuỗi dài, vd: openssl rand -hex 32
npx wrangler secret put JIRA_EMAIL               # email Atlassian
npx wrangler secret put JIRA_API_TOKEN           # API token Jira
```

Deploy:

```bash
npm run deploy
# In ra URL dạng: https://telegram-jira-bot.<account>.workers.dev
```

Đăng ký webhook (dùng đúng `TELEGRAM_WEBHOOK_SECRET` ở trên):

```bash
chmod +x scripts/*.sh
./scripts/set-webhook.sh "<BOT_TOKEN>" "https://telegram-jira-bot.<account>.workers.dev" "<WEBHOOK_SECRET>"
./scripts/webhook-info.sh "<BOT_TOKEN>"   # kiểm tra: url đúng, pending_update_count=0, không có last_error
```

---

## Dùng bot

> Lần đầu bot sẽ báo "chưa cấu hình quyền" kèm Chat ID của bạn — làm bước **Bảo mật** bên dưới
> (đặt `ALLOWED_CHAT_IDS` rồi deploy lại) trước khi dùng.

Trong Telegram, chat với bot của bạn:

```
/start                          → hướng dẫn
/projects                       → liệt kê project Jira
/useproject KAN                 → chọn project để ghi việc

# Ghi việc (một lần)
mai 3h chiều gọi khách A        → tạo issue + tự nhắc 15:00 ngày mai
thứ 6 nộp báo cáo gấp #sales     → issue priority High + nhãn "sales"
/note Thanh toán hoá đơn        → ghi nhanh, không hạn
/note Họp team // 12/06 09:30   → ghi kèm hạn chính xác (không cần AI)
/list                           → việc một-lần đang chờ nhắc

# Nhắc lặp 🔁 (ping lặp lại, KHÔNG tạo issue mỗi lần)
/daily 08:00 Uống vitamin       → nhắc mỗi ngày 08:00
/weekly t2 09:00 Họp đầu tuần   → nhắc mỗi thứ Hai 09:00
mỗi ngày 8h uống thuốc          → tương đương /daily (câu tự nhiên)
/recurring                      → xem các nhắc lặp + id để gỡ
/stoprecur <id>                 → gỡ một nhắc lặp

# Hoàn thành ✅
/done KAN-12                    → chuyển issue sang Done
(reply tin có mã việc) /done    → hoặc nhắn "xong" khi reply
```

**Priority & nhãn:** từ khoá "gấp/khẩn/ưu tiên cao" → priority (High/Highest), "không gấp/ưu tiên
thấp" → Low; `#tag` bất kỳ → Jira label. Project không hỗ trợ field nào thì bot tự bỏ qua field đó.

Khi tới giờ, bot gửi tin nhắc kèm nút: **✅ Hoàn thành** (chuyển issue sang Done) ·
**⏰ +1h** · **🌅 Sáng mai**. Nhắc lặp có nút **✖ Dừng lặp**.

---

## Bảo mật — BẮT BUỘC

Bot **khoá mặc định** (fail-closed): khi `ALLOWED_CHAT_IDS` còn trống, bot từ chối mọi người.
Webhook secret chỉ chặn người gọi thẳng URL Worker — nó **không** phân quyền giữa các user Telegram,
nên `ALLOWED_CHAT_IDS` là hàng rào quyền duy nhất.

Cách mở khoá cho riêng bạn:
1. Nhắn bất kỳ cho bot → bot trả về **Chat ID** của bạn (vì đang bị khoá).
2. Đặt vào `wrangler.jsonc`:
   ```jsonc
   "ALLOWED_CHAT_IDS": "123456789"   // nhiều người thì ngăn cách bằng dấu phẩy
   ```
3. `npm run deploy` lại. Xong — chỉ chat id trong danh sách mới dùng được (cả tin nhắn lẫn nút bấm).

---

## Tinh chỉnh (`wrangler.jsonc` → `vars`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `REMINDER_LEAD_MINUTES` | `0` | Nhắc trước hạn bao nhiêu phút (vd `30` = nhắc sớm 30'). |
| `triggers.crons` | `*/5 * * * *` | Tần suất quét. Với mặc định `*/5`, tin nhắc đến **trong vòng 0–5 phút sau hạn**; đặt `REMINDER_LEAD_MINUTES=5` hoặc đổi cron sang `*/1 * * * *` để sát giờ hơn. |
| `AI_MODEL` | llama-3.3-70b | Model Workers AI parse tiếng Việt. |
| `JIRA_ISSUE_TYPE` | `Task` | Loại issue tạo ra. |
| `TZ_OFFSET_MINUTES` | `420` | Lệch múi giờ (VN = 420 = UTC+7). |

---

## Phát triển local

```bash
cp .dev.vars.example .dev.vars   # điền token vào .dev.vars (KHÔNG commit)
npm run dev                      # chạy Worker local; dùng ngrok nếu muốn nhận webhook thật
npm run check                    # build thử (dry-run), không deploy
npm run tail                     # xem log realtime của Worker đã deploy
```

## Lỗi thường gặp

- **Tạo issue báo lỗi issuetype**: project của bạn không có loại `Task`. Gõ lại việc, bot sẽ
  liệt kê các loại hợp lệ → sửa `JIRA_ISSUE_TYPE` cho khớp rồi deploy lại.
- **Bot không trả lời**: chạy `./scripts/webhook-info.sh <token>` xem `last_error_message`.
  Hay gặp: sai `TELEGRAM_WEBHOOK_SECRET` (403) hoặc chưa deploy.
- **Nút ✅ báo "không thấy trạng thái Done"**: workflow project dùng tên khác (vd "Hoàn tất").
  Bot sẽ in danh sách trạng thái; đổi tên cột trong Jira hoặc cập nhật `DONE_RE` trong
  `src/handlers.ts`.
