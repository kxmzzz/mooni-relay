#!/bin/bash
# ตรวจ worker พร็อกซี่ที่ deploy แล้ว — พิมพ์แค่ status/body ไม่พิมพ์ตัวรหัส
BASE="https://site-4429ace01a9f4280b63a94de8c1c421e.freebuff.page"
KEY=$(cat /c/server/.secrets/proxy-key.txt)

probe() {
  local label="$1"; shift
  local code
  code=$(curl -s -o /tmp/proxy-body.txt -w "%{http_code}" "$@")
  printf '%-18s status=%s body=%s\n' "$label" "$code" "$(head -c 70 /tmp/proxy-body.txt | tr -d '\n')"
}

probe "root"        "$BASE/"
probe "no-key"      "$BASE/v10/gateway"
probe "wrong-key"   "$BASE/wrong-key/v10/gateway"
probe "real-GET"    "$BASE/$KEY/v10/gateway"
probe "real-POST"   -X POST -H 'content-type: application/json' --data '{"a":1}' "$BASE/$KEY/v10/oauth2/token"
probe "real-multipart" -X POST -F 'file=@/c/server/package.json' "$BASE/$KEY/v10/webhooks/1/2"
