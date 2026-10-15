#!/bin/sh
# Send one verification code through NOTIFY with curl, then poll until it settles.
# Needs curl and jq:  sh curl/send.sh
set -eu

stop() {
  echo "$1" >&2
  exit 1
}

# setting NAME [DEFAULT]: the variable without surrounding spaces or line ends (a
# .env file saved on Windows ends every line in \r). An empty one counts as unset.
setting() {
  value=$( (printenv "$1" || true) | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  printf '%s' "${value:-${2:-}}"
}

BASE_URL=$(setting NOTIFY_BASE_URL https://api.n0t1fy.dev | sed 's:/*$::')
API_KEY=$(setting NOTIFY_API_KEY)
[ -n "$API_KEY" ] || stop "Set NOTIFY_API_KEY first. Get a test key with: curl -sS -X POST https://api.n0t1fy.dev/v1/test-keys"
# Checked here, so that a mangled key is never sent, or printed in an error.
NOT_A_KEY="NOTIFY_API_KEY is not a NOTIFY key: it starts with sk_test_ or sk_live_ and then has only letters, digits, - and _. Copy it again."
case "$API_KEY" in
  *[!A-Za-z0-9_-]*) stop "$NOT_A_KEY" ;;
  sk_test_?* | sk_live_?*) ;;
  *) stop "$NOT_A_KEY" ;;
esac
# Plain http carries the key unencrypted, so it is only for a server on this
# machine. Without a scheme, curl would guess http:// as well. An @ is refused,
# because a name before it is not the host.
BAD_BASE_URL="NOTIFY_BASE_URL must start with https://, or with http://localhost, http://127.0.0.1 or http://[::1] for a server on your own machine."
case "$BASE_URL" in
  https://?*) ;;
  *@*) stop "$BAD_BASE_URL" ;;
  http://localhost | http://localhost[:/]* | http://127.0.0.1 | http://127.0.0.1[:/]*) ;;
  http://\[::1\] | http://\[::1\][:/]*) ;;
  *) stop "$BAD_BASE_URL" ;;
esac
LOCALE=$(setting NOTIFY_LOCALE ka) # "ka" (Georgian, the default) or "en"
# A test key never sends a real SMS, so any valid number works; this one becomes
# `delivered`. A live key sends a real SMS, so it needs NOTIFY_TO.
case "$API_KEY" in
  sk_test_*) TO=$(setting NOTIFY_TO +995512345670) ;;
  *) TO=$(setting NOTIFY_TO) ;;
esac
[ -n "$TO" ] || stop "A live key sends a real SMS: set NOTIFY_TO to the +9955XXXXXXXX number expecting this code."
# Give up on one request after this long, so a stuck network never blocks your app.
REQUEST_TIMEOUT_SECONDS=15
POLL_LIMIT_SECONDS=120 # A test message usually settles within 30 seconds.

# In your app, keep an HMAC of the code (never a plain hash) with the user and the
# number, to check what they type in: see "Checking the code" in the README.
CODE=$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom) % 1000000 )))
# One Idempotency-Key per logical message. A retry of this same send reuses it,
# so NOTIFY never sends the code twice.
IDEMPOTENCY_KEY=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
PAYLOAD=$(jq -n --arg to "$TO" --arg code "$CODE" --arg locale "$LOCALE" \
  '{to: $to, template: "verification_code", variables: {code: $code}, locale: $locale}')

# request SECONDS CURL_ARGUMENTS...: sets STATUS and ANSWER (the response body),
# giving up after SECONDS. STATUS is 000 when no complete answer came; curl then
# says why. -q, which must come first, skips your ~/.curlrc: an option there such
# as --fail would turn NOTIFY's error answers into "no answer".
request() {
  seconds=$1
  shift
  if RESPONSE=$(curl -q -sS --max-time "$seconds" -w '\n%{http_code}' \
    -H "Authorization: Bearer $API_KEY" "$@"); then
    STATUS=$(printf '%s\n' "$RESPONSE" | tail -n 1)
    ANSWER=$(printf '%s\n' "$RESPONSE" | sed '$d')
  else
    STATUS=000
    ANSWER=
  fi
}

# Whether the last answer is a message: a string `id` and `status`. Any other
# body came from something other than NOTIFY, such as a proxy.
is_message() {
  printf '%s' "$ANSWER" | jq -e '(.id | type == "string") and (.status | type == "string")' >/dev/null 2>&1
}

# Whether the last answer is one of NOTIFY's errors: they have an `error` object.
is_error() {
  printf '%s' "$ANSWER" | jq -e '.error | type == "object"' >/dev/null 2>&1
}

# What came back from the last request, in one line.
describe() {
  if [ "$STATUS" = 000 ]; then
    echo "No answer from NOTIFY"
  elif is_error; then
    printf '%s' "$ANSWER" | jq -r --arg status "$STATUS" \
      '"HTTP \($status) \(.error.code): \(.error.message) (request_id \(.error.request_id))"'
  else
    echo "HTTP $STATUS, and the body is not NOTIFY's (a proxy answered, or NOTIFY_BASE_URL is wrong)"
  fi
}

# No answer, or a 5xx: an earlier attempt may have gone through. Only NOTIFY's own
# 503 provider_unavailable says that nothing was sent.
may_have_been_sent() {
  case "$STATUS" in 000 | 5??) ;; *) return 1 ;; esac
  ! printf '%s' "$ANSWER" | jq -e '.error.code == "provider_unavailable"' >/dev/null 2>&1
}

attempt=1
while :; do
  request "$REQUEST_TIMEOUT_SECONDS" -X POST "$BASE_URL/v1/messages" \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H 'Content-Type: application/json' --data "$PAYLOAD"
  # Retry when no answer came, on a 500 or a gateway error, or on 503
  # provider_unavailable (nothing was sent). The same Idempotency-Key makes it
  # safe: if an earlier attempt did arrive, NOTIFY answers 200 with that message
  # and sends nothing.
  case "$STATUS" in 000 | 500 | 502 | 503 | 504) ;; *) break ;; esac
  [ "$attempt" -lt 3 ] || break
  echo "$(describe). Retrying in 5 seconds with the same Idempotency-Key..."
  attempt=$((attempt + 1))
  sleep 5
done
# 201: a new message. 200: a replay of a request already processed.
if { [ "$STATUS" != 201 ] && [ "$STATUS" != 200 ]; } || ! is_message; then
  if may_have_been_sent; then
    stop "$(describe): the SMS may or may not have been sent. Do not send a new code automatically. To try again, repeat this request with Idempotency-Key $IDEMPOTENCY_KEY."
  fi
  stop "$(describe)"
fi

MESSAGE=$ANSWER
ID=$(printf '%s' "$MESSAGE" | jq -r .id)
STATE=$(printf '%s' "$MESSAGE" | jq -r .status)
echo "Created $ID: $STATE, $(printf '%s' "$MESSAGE" | jq -r .segments) SMS"

# Only `queued` and `submitted` can still change. Wait 2 s, then double, up to 30 s.
# A read that fails changes nothing: the message is still what it was. But when
# NOTIFY itself refuses the read (401 invalid_api_key, 403 project_suspended,
# 404 message_not_found), waiting will not help: stop and say why. Keep trying
# after no answer, a 429, a 5xx, or a body that is not NOTIFY's.
wait=2
# The limit runs on the clock from now, and counts the reads as well as the waits.
deadline=$(($(date +%s) + POLL_LIMIT_SECONDS))
while { [ "$STATE" = queued ] || [ "$STATE" = submitted ]; } && [ "$(date +%s)" -lt "$deadline" ]; do
  left=$((deadline - $(date +%s)))
  [ "$wait" -le "$left" ] || wait=$left
  sleep "$wait"
  wait=$((wait * 2 > 30 ? 30 : wait * 2))
  # No read runs past the limit; the last one, at the limit, gets one second.
  left=$((deadline - $(date +%s)))
  [ "$left" -ge 1 ] || left=1
  [ "$left" -le "$REQUEST_TIMEOUT_SECONDS" ] || left=$REQUEST_TIMEOUT_SECONDS
  request "$left" "$BASE_URL/v1/messages/$ID"
  if [ "$STATUS" = 200 ] && is_message; then
    MESSAGE=$ANSWER
    STATE=$(printf '%s' "$MESSAGE" | jq -r .status)
    echo "  $STATE"
  elif [ "$STATUS" -ge 400 ] && [ "$STATUS" -lt 500 ] && [ "$STATUS" != 429 ] && is_error; then
    stop "Stopped checking $ID, still $STATE: $(describe)"
  else
    echo "  could not read it ($(describe)); trying again"
  fi
done

case "$STATE" in
  delivered) echo "Delivered." ;;
  undeliverable | failed)
    echo "Not delivered: $(printf '%s' "$MESSAGE" | jq -r '"\(.error.code): \(.error.message)"')" >&2
    exit 1 ;;
  unknown)
    echo "Unknown: the SMS may or may not have been sent. Do not send it again automatically." >&2
    exit 1 ;;
  *)
    echo "Still $STATE after $POLL_LIMIT_SECONDS s: unconfirmed, not failed. Do not send it again; read it later with GET /v1/messages/$ID." >&2
    exit 1 ;;
esac
