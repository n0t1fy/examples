// Send one verification code through NOTIFY, then poll until it settles.
// Node 18 or newer; no packages needed:  node node/send.mjs
import { randomInt, randomUUID } from "node:crypto";

// A setting from the environment, without surrounding spaces or line ends (a .env
// file saved on Windows ends every line in \r). An empty one counts as unset.
const setting = (name, fallback) => process.env[name]?.trim() || fallback;

const BASE_URL = setting("NOTIFY_BASE_URL", "https://api.n0t1fy.dev").replace(/\/+$/, "");
const API_KEY = setting("NOTIFY_API_KEY");
const LOCALE = setting("NOTIFY_LOCALE", "ka"); // "ka" (Georgian, the default) or "en"
// A test key never sends a real SMS, so any valid number works; this one becomes
// `delivered`. A live key sends a real SMS, so it needs NOTIFY_TO.
const TEST_RECIPIENT = "+995500000000";
// Give up on one request after this long, so a stuck network never blocks your app.
const REQUEST_TIMEOUT_MS = 15_000;
// Stop polling after this long. A test message usually settles within 30 seconds.
const POLL_LIMIT_MS = 120_000;

function stop(message) {
  console.error(message);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!API_KEY) {
  stop(
    "Set NOTIFY_API_KEY first. Get a test key with:\n" +
      "  curl -sS -X POST https://api.n0t1fy.dev/v1/test-keys",
  );
}
// Checked here, so that a mangled key is never sent, or printed in an error.
if (!/^sk_(test|live)_[A-Za-z0-9_-]+$/.test(API_KEY)) {
  stop(
    "NOTIFY_API_KEY is not a NOTIFY key: it starts with sk_test_ or sk_live_ and " +
      "then has only letters, digits, - and _. Copy it again.",
  );
}
// Plain http carries the key unencrypted, so it is only for a server on this
// machine. Without a scheme, a request could go out over plain http as well.
if (!/^(https:\/\/.|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(\/|$))/.test(BASE_URL)) {
  stop(
    "NOTIFY_BASE_URL must start with https://, or with http://localhost, " +
      "http://127.0.0.1 or http://[::1] for a server on your own machine.",
  );
}
const to = setting("NOTIFY_TO") || (API_KEY.startsWith("sk_test_") ? TEST_RECIPIENT : null);
if (!to) {
  stop("A live key sends a real SMS: set NOTIFY_TO to the +9955XXXXXXXX number expecting this code.");
}

// Returns { status, data }. `data` is the JSON body, or null when the body is not
// JSON (a proxy's error page, say). `status` is 0 when no answer came at all.
async function call(method, path, { body, idempotencyKey, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const headers = { Authorization: `Bearer ${API_KEY}` };
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let status, raw;
  try {
    const response = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    raw = await response.text();
  } catch (error) {
    // A refused localhost (tried as ::1 and 127.0.0.1) gives a cause with an empty
    // message but a code, such as ECONNREFUSED.
    console.error(`Request failed: ${error.cause?.message || error.cause?.code || error.message}`);
    return { status: 0, data: null };
  }
  try {
    return { status, data: JSON.parse(raw) };
  } catch {
    return { status, data: null };
  }
}

// A message has a string `id` and `status`, and NOTIFY's errors have an `error`
// object. Any other body came from something else, such as a proxy.
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isMessage = (data) =>
  isObject(data) && typeof data.id === "string" && typeof data.status === "string";
const errorIn = (data) => (isObject(data) && isObject(data.error) ? data.error : null);

// What came back, in one line.
function describe({ status, data }) {
  const error = errorIn(data);
  if (status === 0) return "No answer from NOTIFY";
  if (!error) {
    return `HTTP ${status}, and the body is not NOTIFY's (a proxy answered, or NOTIFY_BASE_URL is wrong)`;
  }
  return `HTTP ${status} ${error.code}: ${error.message} (request_id ${error.request_id})`;
}

// In your app, keep an HMAC of the code (never a plain hash) with the user and the
// number, to check what they type in: see "Checking the code" in the README.
const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
// One Idempotency-Key per logical message. A retry of this same send reuses it,
// so NOTIFY never sends the code twice.
const idempotencyKey = randomUUID();
const body = { to, template: "verification_code", variables: { code }, locale: LOCALE };

// No answer, or a 5xx: an earlier attempt may have gone through. Only NOTIFY's own
// 503 provider_unavailable says that nothing was sent.
const mayHaveBeenSent = ({ status, data }) =>
  (status === 0 || status >= 500) && errorIn(data)?.code !== "provider_unavailable";

let result;
for (let attempt = 1; ; attempt++) {
  result = await call("POST", "/v1/messages", { body, idempotencyKey });
  // Retry when no answer came, on a 500 or a gateway error, or on 503
  // provider_unavailable (nothing was sent). The same Idempotency-Key makes it
  // safe: if an earlier attempt did arrive, NOTIFY answers 200 with that message
  // and sends nothing.
  if (![0, 500, 502, 503, 504].includes(result.status) || attempt === 3) break;
  console.log(`${describe(result)}. Retrying in 5 seconds with the same Idempotency-Key...`);
  await sleep(5_000);
}
// 201: a new message. 200: a replay of a request already processed.
if ((result.status !== 201 && result.status !== 200) || !isMessage(result.data)) {
  if (mayHaveBeenSent(result)) {
    stop(
      `${describe(result)}: the SMS may or may not have been sent. Do not send a new code ` +
        `automatically. To try again, repeat this request with Idempotency-Key ${idempotencyKey}.`,
    );
  }
  stop(describe(result));
}

let message = result.data;
console.log(`Created ${message.id}: ${message.status}, ${message.segments} SMS`);

// Only `queued` and `submitted` can still change. Wait 2 s, then double, up to 30 s.
// A read that fails changes nothing: the message is still what it was. But when
// NOTIFY itself refuses the read (401 invalid_api_key, 403 project_suspended,
// 404 message_not_found), waiting will not help: stop and say why. Keep trying
// after no answer, a 429, a 5xx, or a body that is not NOTIFY's.
let wait = 2_000;
// The limit runs on the clock from now, and counts the reads as well as the waits.
const deadline = Date.now() + POLL_LIMIT_MS;
while (["queued", "submitted"].includes(message.status) && Date.now() < deadline) {
  await sleep(Math.min(wait, deadline - Date.now()));
  wait = Math.min(wait * 2, 30_000);
  // No read runs past the limit; the last one, at the limit, gets one second.
  const timeoutMs = Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
  const read = await call("GET", `/v1/messages/${message.id}`, { timeoutMs });
  if (read.status === 200 && isMessage(read.data)) {
    message = read.data;
    console.log(`  ${message.status}`);
  } else if (read.status >= 400 && read.status < 500 && read.status !== 429 && errorIn(read.data)) {
    stop(`Stopped checking ${message.id}, still ${message.status}: ${describe(read)}`);
  } else {
    console.log(`  could not read it (${describe(read)}); trying again`);
  }
}

switch (message.status) {
  case "delivered":
    console.log("Delivered.");
    break;
  case "undeliverable":
  case "failed":
    stop(`Not delivered: ${message.error.code}: ${message.error.message}`);
    break;
  case "unknown":
    stop("Unknown: the SMS may or may not have been sent. Do not send it again automatically.");
    break;
  default:
    stop(
      `Still ${message.status} after ${POLL_LIMIT_MS / 1000} s: unconfirmed, not failed. ` +
        `Do not send it again; read it later with GET /v1/messages/${message.id}.`,
    );
}
