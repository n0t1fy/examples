// A phone verification form for your sign-up or sign-in page: the page asks for a
// Georgian mobile number, NOTIFY texts it a code, and the page checks the code.
// Node 22 or newer; no packages needed:
//   NOTIFY_API_KEY=sk_test_... node verify-form/server.mjs
// then open http://localhost:3000. With a test key nothing is sent: use the test
// number +995512345670 and the code 000000. +995512345671 to +995512345674
// act out failures: see "Test recipients" in the README.
//
// The NOTIFY key stays here, on your server. The browser talks only to this
// server's two routes, POST /verify/start and POST /verify/check, never to NOTIFY.
// To use it in your app, copy those two routes and refused() into your backend, and
// index.html, form.js and form.css into your frontend. The README lists what else
// to keep: the Host check, the body limit, the response headers and the cookie.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

// A setting from the environment, without surrounding spaces or line ends (a .env
// file saved on Windows ends every line in \r). An empty one counts as unset.
const setting = (name, fallback) => process.env[name]?.trim() || fallback;

const BASE_URL = setting("NOTIFY_BASE_URL", "https://api.n0t1fy.dev").replace(/\/+$/, "");
const API_KEY = setting("NOTIFY_API_KEY");
const PORT = setting("PORT", "3000");
// The address people open this page at, such as https://www.example.ge: the page
// and the two routes on one host. Requests from any other site, or for any other
// host name, are refused.
const SITE_ORIGIN = setting("SITE_ORIGIN");
// A sign-in page should not keep a user waiting: give up on NOTIFY after this long.
const REQUEST_TIMEOUT_MS = 10_000;
// After a code is sent, "send a new code" waits this long.
const RESEND_AFTER_MS = 60_000;
// NOTIFY's codes work for ten minutes.
const CODE_LIFETIME_MS = 10 * 60_000;
// Your own limits, on top of NOTIFY's: every live code costs a credit, and a form
// that texts any number is what an abuser looks for. In production keep these
// counts in your database or Redis, and add a bot check (a CAPTCHA) to the phone
// step. NOTIFY itself allows 5 codes an hour and 10 in 24 hours to one number; its
// 24 hours come back as "too many codes" too.
const LIMITS = {
  number: [
    [1, RESEND_AFTER_MS], // one code a minute to one number,
    [5, 3_600_000], // five an hour, as NOTIFY,
  ],
  address: [[10, 3_600_000]], // and ten an hour from one address (see visitorAddress).
};
const SESSION_LIFETIME_MS = 30 * 60_000;
const MAX_SESSIONS = 10_000;
const MAX_BODY_BYTES = 1_024;

function stop(message) {
  console.error(message);
  process.exit(1);
}

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
if (!/^[0-9]{1,5}$/.test(PORT) || Number(PORT) > 65_535) {
  stop("PORT is a number from 0 to 65535, such as 3000.");
}
if (SITE_ORIGIN && !/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(SITE_ORIGIN)) {
  stop("SITE_ORIGIN is the page's address without a path, such as https://www.example.ge.");
}
const site = SITE_ORIGIN ? new URL(SITE_ORIGIN) : null;
const onThisMachine = (url) => ["localhost", "127.0.0.1"].includes(url.hostname);
// Plain http carries the number and the code unencrypted, so it is only for a page
// on this machine, as for NOTIFY_BASE_URL.
if (site?.protocol === "http:" && !onThisMachine(site)) {
  stop(
    "SITE_ORIGIN must start with https://, or with http://localhost or " +
      "http://127.0.0.1 for a page on this machine.",
  );
}
// With a test key the page tells a user who types a real number to use a test
// number and the code 000000. On a public page that tells everyone how to pass.
if (API_KEY.startsWith("sk_test_") && site && !onThisMachine(site)) {
  stop(
    "A test key on a public page shows every visitor the test numbers and their code, " +
      "000000. Use an sk_live_ key there, or leave SITE_ORIGIN unset to try the form " +
      "on this machine.",
  );
}

// The three files this server serves, read once. The page is never cached, like
// the routes' answers; the browser asks again for form.js and form.css on each
// visit, and downloads them again only when they changed (their ETag).
const PAGES = Object.fromEntries(
  [
    ["/", "index.html", "text/html; charset=utf-8", "no-store"],
    ["/form.js", "form.js", "text/javascript; charset=utf-8", "no-cache"],
    ["/form.css", "form.css", "text/css; charset=utf-8", "no-cache"],
  ].map(([path, file, type, cache]) => {
    const content = readFileSync(new URL(file, import.meta.url));
    const etag = `"${createHash("sha256").update(content).digest("base64url").slice(0, 22)}"`;
    return [path, { type, cache, content, etag }];
  }),
);

// --- Calling NOTIFY --------------------------------------------------------------

// Returns { status, data }. `data` is the JSON body, or null when the body is not
// JSON (a proxy's error page, say). `status` is 0 when no answer came at all.
async function notify(path, body, idempotencyKey) {
  const headers = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let status, raw;
  try {
    const response = await fetch(BASE_URL + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // NOTIFY never redirects these routes: a redirect came from something else,
      // and the number (or the code) must not follow it there.
      redirect: "error",
    });
    status = response.status;
    raw = await response.text();
  } catch (error) {
    console.error(`NOTIFY request failed: ${error.cause?.message || error.cause?.code || error.message}`);
    return { status: 0, data: null };
  }
  try {
    return { status, data: JSON.parse(raw) };
  } catch {
    return { status, data: null };
  }
}

// A verification has a string `id` and `status`, and NOTIFY's errors have an
// `error` object. Any other body came from something else, such as a proxy.
// +995591234567 becomes +9955••••••67, as NOTIFY shows a number.
const masked = (number) => `${number.slice(0, 5)}••••••${number.slice(-2)}`;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isVerification = (data) =>
  isObject(data) && typeof data.id === "string" && typeof data.status === "string";
const errorIn = (data) => (isObject(data) && isObject(data.error) ? data.error : null);

// For your log: what NOTIFY answered. NOTIFY's answers never hold the full number.
function describe({ status, data }) {
  const error = errorIn(data);
  if (status === 0) return "no answer";
  if (isVerification(data)) return `HTTP ${status}, ${data.id} is ${data.status} (${error?.code ?? "no error"})`;
  if (!error) {
    return `HTTP ${status}, and the body is not NOTIFY's (a proxy answered, or NOTIFY_BASE_URL is wrong)`;
  }
  return `HTTP ${status} ${error.code} (request_id ${error.request_id})`;
}

// --- Sessions and limits ---------------------------------------------------------

// One entry per browser, found by an HttpOnly cookie. It holds two records:
//   code: the code the user may type now. `id` and `to` are the verification's id
//         and the number NOTIFY sent it to, so a check always uses that number (the
//         browser sends only the code); `locale`, `key` and `at` are the start that
//         sent it, to repeat it; `approved` is the code typed, once NOTIFY approved it.
//   lost: a start whose answer never came, { to, locale, key, at }: the code may
//         have gone out, so "try again" repeats it with the same Idempotency-Key.
// A request reads a record once, before it waits on NOTIFY, and replaces it as a
// whole, never field by field, and only while the session still holds it: another
// request of the same browser, a second tab or a script, may change the session
// while NOTIFY answers.
//
// The sessions, like the counts below, live in this process's memory. In
// production keep both in your database or Redis: with two instances, a cluster
// or a serverless host, a check would find no code, and a restart forgets the
// lost starts, so the next try would send a second code.
const sessions = new Map();

// A session lasts 30 minutes from its last use, and so does its cookie. On an https
// site the cookie is Secure and named __Host-, which only this host may set.
const HTTPS = site?.protocol === "https:";
const COOKIE = HTTPS ? "__Host-verify_session" : "verify_session";
const COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`);

function setCookie(response, id) {
  const lifetime = SESSION_LIFETIME_MS / 1000;
  response.setHeader(
    "Set-Cookie",
    `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime}${HTTPS ? "; Secure" : ""}`,
  );
}

function sessionOf(request, response, now) {
  const match = COOKIE_PATTERN.exec(request.headers.cookie || "");
  const session = match && sessions.get(match[1]);
  if (!session || now - session.seen >= SESSION_LIFETIME_MS) return null;
  session.seen = now;
  setCookie(response, match[1]);
  return session;
}

// Made only once NOTIFY took a start (or nobody knows whether it did), so that
// refused starts leave nothing behind. Whether there is room is asked before.
function newSession(response, now) {
  const id = randomBytes(32).toString("base64url");
  const session = { seen: now };
  sessions.set(id, session);
  setCookie(response, id);
  return session;
}

function hasRoom(now) {
  if (sessions.size >= MAX_SESSIONS) sweep(now, true);
  return sessions.size < MAX_SESSIONS;
}

// The visitor's address, for the limits. An IPv6 visitor often holds a whole /64
// network, so those addresses count as one. Behind a reverse proxy this is the
// proxy's address, so every visitor would share one limit: take the address your
// own proxy appends to X-Forwarded-For instead (the last entry, behind one proxy),
// never an entry the visitor could have written. In Express, that is
// app.set("trust proxy", 1) and request.ip.
function visitorAddress(request) {
  const address = request.socket.remoteAddress || "";
  if (!address.includes(":")) return address;
  if (address.startsWith("::ffff:") && address.includes(".")) return address.slice(7);
  const [head, tail = ""] = address.split("%")[0].split("::");
  const left = head.split(":").filter(Boolean);
  const right = tail.split(":").filter(Boolean);
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

// Each recent start, per number and per address: when it was counted, and its
// Idempotency-Key, so that a start NOTIFY refused can be taken back out.
const starts = new Map();
const LONGEST_WINDOW_MS = Math.max(...Object.values(LIMITS).flat().map(([, windowMs]) => windowMs));

function recent(slot, now) {
  const counted = (starts.get(slot) || []).filter(({ at }) => now - at < LONGEST_WINDOW_MS);
  if (counted.length) starts.set(slot, counted);
  else starts.delete(slot);
  return counted;
}

// Old sessions and counts go, at most once a minute (and at once when the session
// table is full). Otherwise every number ever typed would stay in memory.
let sweptAt = 0;
function sweep(now, force = false) {
  if (!force && now - sweptAt < 60_000) return;
  sweptAt = now;
  for (const [id, session] of sessions) {
    if (now - session.seen >= SESSION_LIFETIME_MS) sessions.delete(id);
  }
  for (const slot of starts.keys()) recent(slot, now); // drops a slot with no recent start
}

// The moment a new start is allowed again in this slot: `now` or earlier if it is.
function freeAt(slot, rules, now) {
  const times = recent(slot, now).map(({ at }) => at);
  let at = 0;
  for (const [limit, windowMs] of rules) {
    const inWindow = times.filter((time) => now - time < windowMs);
    if (inWindow.length >= limit) at = Math.max(at, inWindow[inWindow.length - limit] + windowMs);
  }
  return at;
}

// --- The two routes --------------------------------------------------------------

// Copy this with the two routes: each calls it first. Only this page may call them,
// so another site's page cannot make its visitors' browsers ask for codes: the
// routes need no cookie, so without it a start would work from any page. A JSON
// content type also matters: a page on another site cannot send one without asking
// first, and nothing here says yes, while many frameworks read a text/plain body as
// JSON all the same.
// The answer says only "forbidden"; your log says why.
function refused(request, response) {
  const where = `Refused ${request.url.slice(0, 100)}`;
  const origin = request.headers.origin ?? "";
  if (!origins.includes(origin)) {
    console.error(`${where}: the Origin ${JSON.stringify(origin.slice(0, 100))} is not the page's`);
    reply(response, 403, { error: "forbidden" });
    return true;
  }
  const type = request.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) {
    console.error(`${where}: the Content-Type ${JSON.stringify(type.slice(0, 100))} is not JSON`);
    reply(response, 415, { error: "forbidden" });
    return true;
  }
  return false;
}

// "591 23 45 67", "+995 591 234 567" and "00995591234567" all become +995591234567.
function georgianMobile(value) {
  if (typeof value !== "string") return null;
  // Spaces and punctuation, and the invisible marks some apps add to a copied number.
  let digits = value.replace(/[\s().\-\p{Cf}]/gu, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^5[0-9]{8}$/.test(digits)) digits = "995" + digits;
  return /^9955[0-9]{8}$/.test(digits) ? "+" + digits : null;
}

// A start this browser already made for this number, to repeat instead of sending
// a second code: the one whose answer never came (while its code could still
// work), or the one that sent the code it holds, while a new code would still wait
// (the page lost the answer, or was reloaded). With the same Idempotency-Key and
// body, NOTIFY answers with the original code and sends nothing, so a repeat needs
// no limit. It keeps its own language: the page's may have changed meanwhile.
function repeatable(session, to, now) {
  const { lost, code } = session ?? {};
  if (lost?.to === to && now - lost.at < CODE_LIFETIME_MS) return lost;
  if (code?.to === to && !code.approved && now < code.resendAt) return code;
  return null;
}

async function start(request, response, body, now) {
  if (refused(request, response)) return;
  const to = georgianMobile(body.phone);
  if (!to) return reply(response, 400, { error: "bad_number" });
  sweep(now);
  let session = sessionOf(request, response, now);
  const repeat = repeatable(session, to, now);
  // Any other start is a new code, and must pass the limits.
  const attempt = repeat ?? {
    to,
    locale: body.locale === "en" ? "en" : "ka",
    key: randomUUID(),
    at: now,
  };
  const { locale, key } = attempt;
  const slots = [
    [`number:${to}`, LIMITS.number],
    [`address:${visitorAddress(request)}`, LIMITS.address],
  ];
  // When a new code is allowed, by the same limits that judge it.
  const nextAt = () => Math.max(...slots.map(([slot, rules]) => freeAt(slot, rules, now)));
  if (!repeat) {
    const numberAt = freeAt(slots[0][0], LIMITS.number, now);
    const until = nextAt();
    if (until > now) {
      // The number's own hour, as NOTIFY names its: too many codes for this number.
      const hour = until === numberAt && until - now > RESEND_AFTER_MS;
      const kind = hour ? "too_many_codes" : "wait";
      return reply(response, 429, { error: kind, retry_after: secondsUntil(until, now) });
    }
    if (!session && !hasRoom(now)) return reply(response, 503, { error: "failed" });
    // Counted before the wait on NOTIFY, so that parallel requests cannot all pass.
    for (const [slot] of slots) starts.set(slot, [...recent(slot, now), { at: now, key }]);
  }

  const result = await notify("/v1/verifications", { to, locale }, key);
  const { status, data } = result;
  const error = errorIn(data);
  const sent = (status === 201 || status === 200) && isVerification(data) && data.status === "pending";
  const unsure = status === 0 || status >= 500;
  if ((sent || unsure) && !session) session = newSession(response, now);
  // No answer, or a 5xx: the code may or may not have gone out. Keep this start, so
  // that the user's "try again" repeats it instead of sending a second code. Any
  // other answer settles it.
  if (unsure) {
    session.lost = Object.freeze({ to, locale, key, at: attempt.at });
  } else if (repeat && session.lost === repeat) {
    session.lost = null;
  }

  // 201: a new code was sent. 200: a repeat of a start already made.
  if (sent) {
    const resendAt = nextAt();
    if (session.code?.id !== data.id) {
      session.code = Object.freeze({ id: data.id, to, locale, key, at: attempt.at, resendAt });
    }
    return reply(response, 200, {
      sent_to: data.to, // as NOTIFY masks it: +9955••••••67
      resend_after: secondsUntil(resendAt, now),
    });
  }
  // A repeat whose code has ended meanwhile (it expired, or another browser's start
  // for this number replaced it): forget it, and ask again as a new start would.
  if (repeat && isVerification(data) && ["expired", "canceled"].includes(data.status)) {
    if (session.code === repeat) session.code = null;
    return start(request, response, body, now);
  }
  // Anything else is a refusal, or no answer. Your log gets the reason; the user
  // gets one sentence.
  console.error(`Starting a verification failed: ${describe(result)}`);
  // NOTIFY refused it (a 4xx, or an SMS the provider refused): nothing was sent, so
  // it counts against no limit, as at NOTIFY.
  if ((status >= 400 && status < 500) || (isVerification(data) && data.status === "failed")) {
    for (const [slot] of slots) starts.set(slot, recent(slot, now).filter((start) => start.key !== key));
  }
  // NOTIFY's limit for this number. Its limits for the whole project (a free
  // trial's day, a minute's sends) get the general sentence: the user cannot help.
  if (error?.code === "too_many_verifications") {
    const until = Date.parse(error.retry_at) || now + RESEND_AFTER_MS; // no time named: a minute
    const retryAfter = Math.max(1, secondsUntil(until, now));
    return reply(response, 429, { error: "too_many_codes", retry_after: retryAfter });
  }
  // A refused number: as a 400, or as a 201 whose SMS the provider refused.
  if (error?.code === "invalid_recipient") return reply(response, 400, { error: "bad_number" });
  if (error?.code === "test_number_required") {
    return reply(response, 400, { error: "test_number_required" });
  }
  return reply(response, 502, { error: "failed" });
}

async function check(request, response, body, now) {
  if (refused(request, response)) return;
  const session = sessionOf(request, response, now);
  // Read once, here, before the wait: NOTIFY's answer below is about this code and
  // this number, whatever else this browser asks for meanwhile.
  const pending = session?.code;
  if (!pending) return reply(response, 409, { error: "no_code" });
  const code = typeof body.code === "string" ? body.code.replace(/[\s\p{Cf}]/gu, "") : "";
  // Checked here as well, so that a code that cannot be right never reaches NOTIFY.
  if (!/^[0-9]{6}$/.test(code)) return reply(response, 400, { error: "bad_code" });
  // This code is over: forget it, unless a newer code has taken its place.
  const forget = () => {
    if (session.code === pending) session.code = null;
  };

  // Approved already, and the page asks again: it lost the answer. The same code,
  // while it would still work, gets the same answer, without NOTIFY (which would
  // say the code was used). Any other code ends it: one guess, not a million.
  if (pending.approved) {
    if (code === pending.approved && now - pending.at < CODE_LIFETIME_MS) {
      return confirmed(response, pending);
    }
    forget();
    return reply(response, 409, { error: "code_ended" });
  }

  // The number is the one this code was sent to. Never retry a check by yourself:
  // every check spends one of the five attempts.
  const { id, to } = pending;
  const result = await notify(`/v1/verifications/${id}/check`, { to, code });
  const { status, data } = result;
  if (status === 200 && isVerification(data) && data.status === "approved") {
    // Kept, as approved, in case the page loses this answer and asks again.
    if (session.code === pending) session.code = Object.freeze({ ...pending, approved: code });
    return confirmed(response, { id, to });
  }
  const error = errorIn(data);
  if (error?.code === "incorrect_code") return reply(response, 422, { error: "incorrect_code" });
  console.error(`Checking ${id} failed: ${describe(result)}`);
  // The code cannot work any more. A 404 means NOTIFY does not know it: a key of
  // the other mode (test or live), or a verification deleted with its account.
  const over = [
    "too_many_attempts",
    "verification_expired",
    "verification_closed",
    "verification_not_found",
  ];
  if (over.includes(error?.code)) {
    forget();
    return reply(response, 409, { error: "code_ended" });
  }
  // Everything else means "not verified": no answer, a 5xx, a body that is not
  // NOTIFY's, NOTIFY's limit on checks for the whole project, recipient_mismatch (a
  // bug). If the answer was lost, the code may have been used up: a second try then
  // says to ask for a new one.
  return reply(response, 502, { error: "failed" });
}

// NOTIFY approved the code sent to `to`, in this request or in an earlier one whose
// answer the page lost (the user then typed the same code again).
// This is where your app records `to` as this user's verified number, or signs
// them in: then start a fresh session of your app, rather than keep the one from
// before the sign-in. `to` was read before the check waited on NOTIFY: never read
// the number from the session or the browser again here.
function confirmed(response, { id, to }) {
  console.log(`Verified ${id}`);
  return reply(response, 200, { verified: masked(to) });
}

// --- The server ------------------------------------------------------------------

// Waits go to the page in whole seconds, rounded up, which it counts on its own
// clock: a phone's clock may be minutes off.
const secondsUntil = (at, now) => Math.max(0, Math.ceil((at - now) / 1000));

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function reply(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

// The body as text, or null when it is larger than MAX_BODY_BYTES.
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) resolve(null);
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

let origins = [];

// Only the page's own host name: this refuses a DNS rebinding attack, where another
// site's name is pointed at this server. Behind a reverse proxy, pass the Host
// header through (nginx: proxy_set_header Host $host; Apache: ProxyPreserveHost
// On), or every request gets 421.
function ownHost(request) {
  const host = (request.headers.host ?? "").toLowerCase();
  return origins.some((origin) => {
    const url = new URL(origin);
    return host === url.host || host === `${url.hostname}:${url.protocol === "https:" ? 443 : 80}`;
  });
}

// Refused before the routes: the answer is short, and your log says why.
function refuse(request, response, status, error, why) {
  console.error(`Refused ${request.method} ${request.url.slice(0, 100)}: ${why}`);
  reply(response, status, { error });
}

const server = createServer(async (request, response) => {
  for (const [name, value] of Object.entries(HEADERS)) response.setHeader(name, value);
  if (!ownHost(request)) {
    const host = JSON.stringify((request.headers.host ?? "").slice(0, 100));
    return refuse(request, response, 421, "forbidden", `the Host ${host} is not the page's`);
  }
  const path = request.url.split("?")[0];
  if (request.method === "GET" && PAGES[path]) {
    const { type, cache, content, etag } = PAGES[path];
    response.setHeader("Cache-Control", cache);
    response.setHeader("ETag", etag);
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304);
      return response.end();
    }
    response.writeHead(200, { "Content-Type": type });
    return response.end(content);
  }
  const route = { "/verify/start": start, "/verify/check": check }[path];
  if (request.method !== "POST" || !route) return reply(response, 404, { error: "not_found" });
  // The routes check the Origin and the content type themselves, first thing.
  const raw = await readBody(request);
  if (raw === null) {
    response.setHeader("Connection", "close");
    return refuse(request, response, 413, "failed", "the body is larger than 1 KiB");
  }
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  if (!isObject(body)) return refuse(request, response, 400, "failed", "the body is not a JSON object");
  try {
    await route(request, response, body, Date.now());
  } catch (error) {
    console.error(`Unexpected error: ${error.message}`);
    if (!response.headersSent) reply(response, 500, { error: "failed" });
  }
});

// This machine only. Behind your own web server, set SITE_ORIGIN to your site.
server.listen(Number(PORT), setting("HOST", "127.0.0.1"), () => {
  const port = server.address().port;
  // As browsers send it: the host in lower case, without :443 or :80.
  origins = site ? [site.origin] : [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  console.log(`Open ${origins[0]}`);
});
