#!/usr/bin/env bash
# Đăng ký Jira webhook trỏ về Worker — dùng endpoint LEGACY /rest/webhooks/1.0
# (chỉ chạy được khi tài khoản là SITE ADMIN; endpoint mới /rest/api/3/webhook
# chỉ dành cho Connect/OAuth app, Basic auth sẽ bị 403).
#
# Nếu lệnh này trả 403/404: đăng ký bằng tay trong Jira admin UI —
#   Settings (⚙️) → System → WebHooks → Create a WebHook
#   URL:   <WORKER_URL>/jira-webhook?s=<JIRA_WEBHOOK_SECRET>
#   JQL:   project = <PROJECT_KEY>
#   Events: Issue → updated, deleted
#
# Dùng: ./scripts/register-jira-webhook.sh <JIRA_BASE_URL> <EMAIL> <API_TOKEN> <WORKER_URL> <JIRA_WEBHOOK_SECRET> [PROJECT_KEY]
#   vd: ./scripts/register-jira-webhook.sh https://xxx.atlassian.net me@mail.com tok123 https://telegram-jira-bot.xxx.workers.dev my-secret KAN
set -euo pipefail

BASE="${1:?Thiếu JIRA_BASE_URL (vd https://xxx.atlassian.net)}"
EMAIL="${2:?Thiếu JIRA_EMAIL}"
TOKEN="${3:?Thiếu JIRA_API_TOKEN}"
URL="${4:?Thiếu WORKER_URL}"
SECRET="${5:?Thiếu JIRA_WEBHOOK_SECRET}"
PROJECT="${6:-KAN}"

curl -sS -u "${EMAIL}:${TOKEN}" -H "Content-Type: application/json" \
  "${BASE%/}/rest/webhooks/1.0/webhook" \
  -d @- <<JSON
{
  "name": "telegram-jira-bot",
  "url": "${URL%/}/jira-webhook?s=${SECRET}",
  "events": ["jira:issue_updated", "jira:issue_deleted"],
  "filters": { "issue-related-events-section": "project = ${PROJECT}" },
  "excludeBody": false
}
JSON
echo
echo "Nếu thấy 403/404 ở trên: đăng ký bằng Jira admin UI (xem comment đầu file)."
