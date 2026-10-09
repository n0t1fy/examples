#!/bin/sh
# Send one verification code through NOTIFY with curl, then poll until it settles.
# Needs curl and jq:  sh curl/send.sh
set -eu

# An empty setting counts as unset.
BASE_URL="${NOTIFY_BASE_URL:-https://api.n0t1fy.dev}"
BASE_URL="${BASE_URL%/}"
: "${NOTIFY_API_KEY:?Set NOTIFY_API_KEY first. Get a test key with: curl -sS -X POST https://api.n0t1fy.dev/v1/test-keys}"
LOCALE="${NOTIFY_LOCALE:-ka}" # "ka" (Georgian, the default) or "en"
# A test key never sends a real SMS, so any valid number works; this one becomes
# `delivered`. A live key sends a real SMS, so it needs NOTIFY_TO.
case "$NOTIFY_API_KEY" in
  sk_test_*) TO="${NOTIFY_TO:-+995500000000}" ;;
  *) TO="${NOTIFY_TO:?A live key sends a real SMS: set NOTIFY_TO to the +9955XXXXXXXX number expecting this code.}" ;;
esac
# Give up on one request after this long, so a stuck network never blocks your app.
REQUEST_TIMEOUT_SECONDS=15
POLL_LIMIT_SECONDS=120 # A test message usually settles within 30 seconds.

# In your app, keep a hash of the code with the user, to check what they type in.
CODE=$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom) % 1000000 )))
# One Idempotency-Key per logical message. A retry of this same send reuses it,
# so NOTIFY never sends the code twice.
IDEMPOTENCY_KEY=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
PAYLOAD=$(jq -n --arg to "$TO" --arg code "$CODE" --arg locale "$LOCALE" \
  '{to: $to, template: "verification_code", variables: {code: $code}, locale: $locale}')

# request CURL_ARGUMENTS...: sets STATUS and ANSWER (the response body).
# STATUS is 000 when no complete answer came; curl then says why.
request() {
  if RESPONSE=$(curl -sS --max-time "$REQUEST_TIMEOUT_SECONDS" -w '\n%{http_code}' \
    -H "Authorization: Bearer $NOTIFY_API_KEY" "$@"); then
    STATUS=$(printf '%s\n' "$RESPONSE" | tail -n 1)
    ANSWER=$(printf '%s\n' "$RESPONSE" | sed '$d')
  else
    STATUS=000
    ANSWER=
  fi
}

# What went wrong with the last request, in one line.
describe() {
  if [ "$STATUS" = 000 ]; then
    echo "No answer from NOTIFY: the request may or may not have arrived"
  elif printf '%s' "$ANSWER" | jq -e '.error | type == "object"' >/dev/null 2>&1; then
    printf '%s' "$ANSWER" | jq -r --arg status "$STATUS" \
      '"HTTP \($status) \(.error.code): \(.error.message) (request_id \(.error.request_id))"'
  else
    echo "HTTP $STATUS without a NOTIFY error (a proxy answered, or NOTIFY_BASE_URL is wrong): the request may or may not have arrived"
  fi
}

attempt=1
while :; do
  request -X POST "$BASE_URL/v1/messages" \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H 'Content-Type: application/json' --data "$PAYLOAD"
  # Retry when no answer came, on a gateway error, or on 503 provider_unavailable
  # (nothing was sent). The same Idempotency-Key makes it safe: if an earlier
  # attempt did arrive, NOTIFY answers 200 with that message and sends nothing.
  case "$STATUS" in 000 | 502 | 503 | 504) ;; *) break ;; esac
  [ "$attempt" -lt 3 ] || break
  echo "$(describe). Retrying in 5 seconds with the same Idempotency-Key..."
  attempt=$((attempt + 1))
  sleep 5
done
# 201: a new message. 200: a replay of a request already processed.
if { [ "$STATUS" != 201 ] && [ "$STATUS" != 200 ]; } || ! printf '%s' "$ANSWER" | jq -e .id >/dev/null 2>&1; then
  describe >&2
  exit 1
fi

MESSAGE=$ANSWER
ID=$(printf '%s' "$MESSAGE" | jq -r .id)
STATE=$(printf '%s' "$MESSAGE" | jq -r .status)
echo "Created $ID: $STATE, $(printf '%s' "$MESSAGE" | jq -r .segments) SMS"

# Only `queued` and `submitted` can still change. Wait 2 s, then double, up to 30 s.
# A read that fails changes nothing: the message is still what it was.
wait=2
waited=0
while { [ "$STATE" = queued ] || [ "$STATE" = submitted ]; } && [ "$waited" -lt "$POLL_LIMIT_SECONDS" ]; do
  left=$((POLL_LIMIT_SECONDS - waited))
  [ "$wait" -le "$left" ] || wait=$left
  sleep "$wait"
  waited=$((waited + wait))
  wait=$((wait * 2 > 30 ? 30 : wait * 2))
  request "$BASE_URL/v1/messages/$ID"
  if [ "$STATUS" = 200 ] && NEW_STATE=$(printf '%s' "$ANSWER" | jq -er .status 2>/dev/null); then
    MESSAGE=$ANSWER
    STATE=$NEW_STATE
    echo "  $STATE"
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
