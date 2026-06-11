#!/usr/bin/env bash
# Đăng ký webhook Telegram trỏ về Worker.
# Dùng: ./scripts/set-webhook.sh <BOT_TOKEN> <WORKER_URL> <WEBHOOK_SECRET>
#   vd: ./scripts/set-webhook.sh 123:ABC https://telegram-jira-bot.xxx.workers.dev my-secret
set -euo pipefail

TOKEN="${1:?Thiếu BOT_TOKEN}"
URL="${2:?Thiếu WORKER_URL}"
SECRET="${3:?Thiếu WEBHOOK_SECRET}"

curl -sS "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  --data-urlencode "url=${URL%/}/webhook" \
  --data-urlencode "secret_token=${SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' \
  -d "drop_pending_updates=true"
echo
