#!/usr/bin/env bash
# Xem trạng thái webhook hiện tại (URL, lỗi gần nhất, số update đang chờ).
# Dùng: ./scripts/webhook-info.sh <BOT_TOKEN>
set -euo pipefail
TOKEN="${1:?Thiếu BOT_TOKEN}"
curl -sS "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
echo
