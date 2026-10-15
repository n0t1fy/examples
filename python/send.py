"""Send one verification code through NOTIFY, then poll until it settles.

Python 3.9 or newer; no packages needed:  python3 python/send.py
"""

import http.client
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid


def setting(name, default=None):
    """An environment variable without surrounding spaces or line ends (a .env file
    saved on Windows ends every line in \\r). An empty one counts as unset."""
    return (os.environ.get(name) or "").strip() or default


BASE_URL = setting("NOTIFY_BASE_URL", "https://api.n0t1fy.dev").rstrip("/")
API_KEY = setting("NOTIFY_API_KEY")
LOCALE = setting("NOTIFY_LOCALE", "ka")  # "ka" (Georgian, the default) or "en"
# A test key never sends a real SMS, so any valid number works; this one becomes
# `delivered`. A live key sends a real SMS, so it needs NOTIFY_TO.
TEST_RECIPIENT = "+995512345670"
# Give up on one request after this long, so a stuck network never blocks your app.
REQUEST_TIMEOUT_SECONDS = 15
# Stop polling after this long. A test message usually settles within 30 seconds.
POLL_LIMIT_SECONDS = 120


def call(method, path, body=None, idempotency_key=None, timeout=REQUEST_TIMEOUT_SECONDS):
    """Returns (status, data). data is the JSON body, or None when the body is not
    JSON (a proxy's error page, say). status is 0 when no answer came at all."""
    headers = {"Authorization": f"Bearer {API_KEY}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    result = {}

    def send():
        # The outer try also covers an error body that breaks off while it is read.
        try:
            request = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    result["answer"] = response.status, response.read()
            except urllib.error.HTTPError as error:  # 4xx and 5xx are answers too
                result["answer"] = error.code, error.read()
        except (ValueError, OSError, http.client.HTTPException) as error:  # handled below
            result["error"] = error

    # urlopen's timeout starts again with every byte that arrives, so a server that
    # sends its answer one byte at a time could hold it for good. Run the request in
    # a thread and stop waiting for it at the time limit.
    thread = threading.Thread(target=send, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        print(f"Request failed: no complete answer within {timeout:.0f} s", file=sys.stderr)
        return 0, None
    error = result.get("error")
    if isinstance(error, ValueError):
        # A setting no request can carry. Its text may hold the key, so name the
        # settings instead of printing it.
        sys.exit("Request failed: check NOTIFY_BASE_URL and NOTIFY_API_KEY.")
    if error:  # refused, dropped or timed out
        print(f"Request failed: {error}", file=sys.stderr)
        return 0, None
    status, raw = result["answer"]
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def is_message(data):
    """A message has a string id and status. Any other body is not NOTIFY's answer."""
    return (
        isinstance(data, dict)
        and isinstance(data.get("id"), str)
        and isinstance(data.get("status"), str)
    )


def is_error(data):
    """NOTIFY's errors have an `error` object. Any other body came from something else."""
    return isinstance(data, dict) and isinstance(data.get("error"), dict)


def describe(status, data):
    """What came back, in one line."""
    if status == 0:
        return "No answer from NOTIFY"
    if not is_error(data):
        return (
            f"HTTP {status}, and the body is not NOTIFY's (a proxy answered, or "
            "NOTIFY_BASE_URL is wrong)"
        )
    error = data["error"]
    return (
        f"HTTP {status} {error.get('code')}: {error.get('message')} "
        f"(request_id {error.get('request_id')})"
    )


def may_have_been_sent(status, data):
    """No answer, or a 5xx: an earlier attempt may have gone through. Only NOTIFY's
    own 503 provider_unavailable says that nothing was sent."""
    unavailable = is_error(data) and data["error"].get("code") == "provider_unavailable"
    return (status == 0 or status >= 500) and not unavailable


def main():
    if not API_KEY:
        sys.exit(
            "Set NOTIFY_API_KEY first. Get a test key with:\n"
            "  curl -sS -X POST https://api.n0t1fy.dev/v1/test-keys"
        )
    # Checked here, so that a mangled key is never sent, or printed in an error.
    if not re.fullmatch(r"sk_(test|live)_[A-Za-z0-9_-]+", API_KEY):
        sys.exit(
            "NOTIFY_API_KEY is not a NOTIFY key: it starts with sk_test_ or sk_live_ and "
            "then has only letters, digits, - and _. Copy it again."
        )
    # Plain http carries the key unencrypted, so it is only for a server on this
    # machine. Without a scheme, a request could go out over plain http as well.
    if not re.match(r"https://.|http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|\Z)", BASE_URL):
        sys.exit(
            "NOTIFY_BASE_URL must start with https://, or with http://localhost, "
            "http://127.0.0.1 or http://[::1] for a server on your own machine."
        )
    to = setting("NOTIFY_TO") or (TEST_RECIPIENT if API_KEY.startswith("sk_test_") else None)
    if not to:
        sys.exit(
            "A live key sends a real SMS: set NOTIFY_TO to the +9955XXXXXXXX number "
            "expecting this code."
        )

    # In your app, keep an HMAC of the code (never a plain hash) with the user and the
    # number, to check what they type in: see "Checking the code" in the README.
    code = f"{secrets.randbelow(1_000_000):06d}"
    # One Idempotency-Key per logical message. A retry of this same send reuses it,
    # so NOTIFY never sends the code twice.
    idempotency_key = str(uuid.uuid4())
    body = {"to": to, "template": "verification_code", "variables": {"code": code}, "locale": LOCALE}

    for attempt in range(1, 4):
        status, data = call("POST", "/v1/messages", body, idempotency_key)
        # Retry when no answer came, on a 500 or a gateway error, or on 503
        # provider_unavailable (nothing was sent). The same Idempotency-Key makes it
        # safe: if an earlier attempt did arrive, NOTIFY answers 200 with that
        # message and sends nothing.
        if status not in (0, 500, 502, 503, 504) or attempt == 3:
            break
        print(f"{describe(status, data)}. Retrying in 5 seconds with the same Idempotency-Key...")
        time.sleep(5)
    # 201: a new message. 200: a replay of a request already processed.
    if status not in (200, 201) or not is_message(data):
        if may_have_been_sent(status, data):
            sys.exit(
                f"{describe(status, data)}: the SMS may or may not have been sent. Do not "
                "send a new code automatically. To try again, repeat this request with "
                f"Idempotency-Key {idempotency_key}."
            )
        sys.exit(describe(status, data))

    message = data
    print(f"Created {message['id']}: {message['status']}, {message['segments']} SMS")

    # Only `queued` and `submitted` can still change. Wait 2 s, then double, up to 30 s.
    # A read that fails changes nothing: the message is still what it was. But when
    # NOTIFY itself refuses the read (401 invalid_api_key, 403 project_suspended,
    # 404 message_not_found), waiting will not help: stop and say why. Keep trying
    # after no answer, a 429, a 5xx, or a body that is not NOTIFY's.
    wait = 2
    # The limit runs on the clock from now, and counts the reads as well as the waits.
    deadline = time.monotonic() + POLL_LIMIT_SECONDS
    while message["status"] in ("queued", "submitted") and time.monotonic() < deadline:
        time.sleep(min(wait, max(deadline - time.monotonic(), 0)))
        wait = min(wait * 2, 30)
        # No read runs past the limit; the last one, at the limit, gets one second.
        timeout = max(1, min(REQUEST_TIMEOUT_SECONDS, deadline - time.monotonic()))
        status, data = call("GET", f"/v1/messages/{message['id']}", timeout=timeout)
        if status == 200 and is_message(data):
            message = data
            print(f"  {message['status']}")
        elif 400 <= status < 500 and status != 429 and is_error(data):
            sys.exit(
                f"Stopped checking {message['id']}, still {message['status']}: "
                f"{describe(status, data)}"
            )
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
