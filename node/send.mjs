// Send one verification code through NOTIFY, then poll until it settles.
// Node 18 or newer; no packages needed:  node node/send.mjs
import { randomInt, randomUUID } from "node:crypto";

// An empty setting counts as unset.
const BASE_URL = (process.env.NOTIFY_BASE_URL || "https://api.n0t1fy.dev").replace(/\/+$/, "");
const API_KEY = process.env.NOTIFY_API_KEY;
const LOCALE = process.env.NOTIFY_LOCALE || "ka"; // "ka" (Georgian, the default) or "en"
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
const to = process.env.NOTIFY_TO || (API_KEY.startsWith("sk_test_") ? TEST_RECIPIENT : null);
if (!to) {
  stop("A live key sends a real SMS: set NOTIFY_TO to the +9955XXXXXXXX number expecting this code.");
}

// Returns { status, data }. `data` is the JSON body, or null when the body is not
// JSON (a proxy's error page, say). `status` is 0 when no answer came at all.
async function call(method, path, { body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${API_KEY}` };
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let status, raw;
  try {
    const response = await fetch(BASE_URL + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    raw = await response.text();
  } catch (error) {
    console.error(`Request failed: ${error.cause?.message ?? error.message}`);
    return { status: 0, data: null };
  }
  try {
    return { status, data: JSON.parse(raw) };
  } catch {
    return { status, data: null };
  }
}

function describe({ status, data }) {
  const error = data?.error;
  if (status === 0) return "No answer from NOTIFY: the request may or may not have arrived";
  if (!error) {
    return `HTTP ${status} without a NOTIFY error (a proxy answered, or NOTIFY_BASE_URL is wrong): the request may or may not have arrived`;
  }
  return `HTTP ${status} ${error.code}: ${error.message} (request_id ${error.request_id})`;
}

// In your app, keep a hash of the code with the user, to check what they type in.
const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
// One Idempotency-Key per logical message. A retry of this same send reuses it,
// so NOTIFY never sends the code twice.
const idempotencyKey = randomUUID();
const body = { to, template: "verification_code", variables: { code }, locale: LOCALE };

let result;
for (let attempt = 1; ; attempt++) {
  result = await call("POST", "/v1/messages", { body, idempotencyKey });
  // Retry when no answer came, on a gateway error, or on 503 provider_unavailable
  // (nothing was sent). The same Idempotency-Key makes it safe: if an earlier
  // attempt did arrive, NOTIFY answers 200 with that message and sends nothing.
  if (![0, 502, 503, 504].includes(result.status) || attempt === 3) break;
  console.log(`${describe(result)}. Retrying in 5 seconds with the same Idempotency-Key...`);
  await sleep(5_000);
}
// 201: a new message. 200: a replay of a request already processed.
if ((result.status !== 201 && result.status !== 200) || !result.data) stop(describe(result));

let message = result.data;
console.log(`Created ${message.id}: ${message.status}, ${message.segments} SMS`);

// Only `queued` and `submitted` can still change. Wait 2 s, then double, up to 30 s.
// A read that fails changes nothing: the message is still what it was.
let wait = 2_000;
const deadline = Date.now() + POLL_LIMIT_MS;
while (["queued", "submitted"].includes(message.status) && Date.now() < deadline) {
  await sleep(Math.min(wait, deadline - Date.now()));
  wait = Math.min(wait * 2, 30_000);
  const read = await call("GET", `/v1/messages/${message.id}`);
  if (read.status === 200 && read.data) {
    message = read.data;
    console.log(`  ${message.status}`);
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
