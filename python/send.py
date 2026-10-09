"""Send one verification code through NOTIFY, then poll until it settles.

Python 3.9 or newer; no packages needed:  python3 python/send.py
"""

import http.client
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid


def setting(name, default=None):
    """An environment variable; an empty one counts as unset."""
    return os.environ.get(name) or default


BASE_URL = setting("NOTIFY_BASE_URL", "https://api.n0t1fy.dev").rstrip("/")
API_KEY = setting("NOTIFY_API_KEY")
LOCALE = setting("NOTIFY_LOCALE", "ka")  # "ka" (Georgian, the default) or "en"
# A test key never sends a real SMS, so any valid number works; this one becomes
# `delivered`. A live key sends a real SMS, so it needs NOTIFY_TO.
TEST_RECIPIENT = "+995500000000"
# Give up on one request after this long, so a stuck network never blocks your app.
REQUEST_TIMEOUT_SECONDS = 15
# Stop polling after this long. A test message usually settles within 30 seconds.
POLL_LIMIT_SECONDS = 120


def call(method, path, body=None, idempotency_key=None):
    """Returns (status, data). data is the JSON body, or None when the body is not
    JSON (a proxy's error page, say). status is 0 when no answer came at all."""
    headers = {"Authorization": f"Bearer {API_KEY}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    request = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                status, raw = response.status, response.read()
        except urllib.error.HTTPError as error:  # 4xx and 5xx are answers too
            status, raw = error.code, error.read()
    except (OSError, http.client.HTTPException) as error:  # refused, dropped or timed out
        print(f"Request failed: {error}", file=sys.stderr)
        return 0, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def describe(status, data):
    error = data.get("error") if isinstance(data, dict) else None
    if status == 0:
        return "No answer from NOTIFY: the request may or may not have arrived"
    if not isinstance(error, dict):
        return (
            f"HTTP {status} without a NOTIFY error (a proxy answered, or NOTIFY_BASE_URL "
            "is wrong): the request may or may not have arrived"
        )
    return (
        f"HTTP {status} {error.get('code')}: {error.get('message')} "
        f"(request_id {error.get('request_id')})"
    )


def main():
    if not API_KEY:
        sys.exit(
            "Set NOTIFY_API_KEY first. Get a test key with:\n"
            "  curl -sS -X POST https://api.n0t1fy.dev/v1/test-keys"
        )
    to = setting("NOTIFY_TO") or (TEST_RECIPIENT if API_KEY.startswith("sk_test_") else None)
    if not to:
        sys.exit(
            "A live key sends a real SMS: set NOTIFY_TO to the +9955XXXXXXXX number "
            "expecting this code."
        )

    # In your app, keep a hash of the code with the user, to check what they type in.
    code = f"{secrets.randbelow(1_000_000):06d}"
    # One Idempotency-Key per logical message. A retry of this same send reuses it,
    # so NOTIFY never sends the code twice.
    idempotency_key = str(uuid.uuid4())
    body = {"to": to, "template": "verification_code", "variables": {"code": code}, "locale": LOCALE}

    for attempt in range(1, 4):
        status, data = call("POST", "/v1/messages", body, idempotency_key)
        # Retry when no answer came, on a gateway error, or on 503 provider_unavailable
        # (nothing was sent). The same Idempotency-Key makes it safe: if an earlier
        # attempt did arrive, NOTIFY answers 200 with that message and sends nothing.
        if status not in (0, 502, 503, 504) or attempt == 3:
            break
        print(f"{describe(status, data)}. Retrying in 5 seconds with the same Idempotency-Key...")
        time.sleep(5)
    # 201: a new message. 200: a replay of a request already processed.
    if status not in (200, 201) or data is None:
        sys.exit(describe(status, data))

    message = data
    print(f"Created {message['id']}: {message['status']}, {message['segments']} SMS")

    # Only `queued` and `submitted` can still change. Wait 2 s, then double, up to 30 s.
    # A read that fails changes nothing: the message is still what it was.
    wait = 2
    deadline = time.monotonic() + POLL_LIMIT_SECONDS
    while message["status"] in ("queued", "submitted") and time.monotonic() < deadline:
        time.sleep(min(wait, max(deadline - time.monotonic(), 0)))
        wait = min(wait * 2, 30)
        status, data = call("GET", f"/v1/messages/{message['id']}")
        if status == 200 and data is not None:
            message = data
            print(f"  {message['status']}")
        else:
            print(f"  could not read it ({describe(status, data)}); trying again")

    if message["status"] == "delivered":
        print("Delivered.")
    elif message["status"] in ("undeliverable", "failed"):
        sys.exit(f"Not delivered: {message['error']['code']}: {message['error']['message']}")
    elif message["status"] == "unknown":
        sys.exit("Unknown: the SMS may or may not have been sent. Do not send it again automatically.")
    else:
        sys.exit(
            f"Still {message['status']} after {POLL_LIMIT_SECONDS} s: unconfirmed, not failed. "
            f"Do not send it again; read it later with GET /v1/messages/{message['id']}."
        )


if __name__ == "__main__":
    main()
