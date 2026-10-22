# NOTIFY examples

Send transactional one-time codes by SMS to Georgian phone numbers (`+995`) from your
application: verification, sign-in and password-reset codes, in Georgian or English, through one
small HTTP API with honest delivery status.

**Not for marketing or bulk SMS.** NOTIFY sends three code templates to people who asked for
them. Messages go out under the shared sender name `NOTIFY`, unless a sender name of your own
has been approved for your project.

These examples use plain HTTP with no SDK: Node, Python and curl. Each one sends a verification
code with a test key, then polls the message until it settles. A test key never sends a real
SMS and costs nothing. [`verify-form/`](#a-verification-form-to-copy) is a whole verification
step for a sign-up or sign-in page: the page, and the two server routes behind it.

## 1. Get a test key (no account)

```bash
curl -sS -X POST https://api.n0t1fy.dev/v1/test-keys
```

Copy `api_key` from the response (`sk_test_…`; it is shown once) and export it:

```bash
export NOTIFY_API_KEY=sk_test_your_key_here
```

Or copy `.env.example` to `.env`, fill it in, and load it with `set -a; . ./.env; set +a`.
`.env` is in `.gitignore`: never commit a key.

## 2. Run an example

```bash
node node/send.mjs          # Node 18 or newer
python3 python/send.py      # Python 3.9 or newer
sh curl/send.sh             # curl and jq
```

Each prints something like:

```text
Created msg_01K…: submitted, 1 SMS
  submitted
  delivered
Delivered.
```

Settings, all optional except the key:

| Variable | Meaning |
| --- | --- |
| `NOTIFY_API_KEY` | Your key. Required. |
| `NOTIFY_TO` | The recipient, `+9955` and eight digits. Required with a live key; with a test key it defaults to `+995512345670`. |
| `NOTIFY_LOCALE` | `ka` (Georgian, the default) or `en`. |
| `NOTIFY_BASE_URL` | Defaults to `https://api.n0t1fy.dev`. It must start with `https://`. Plain `http://` carries the key unencrypted, so it is accepted only for a server on your own machine: `http://localhost`, `http://127.0.0.1` or `http://[::1]`. |

## Or let your coding agent try it (MCP)

NOTIFY also runs a hosted MCP server, so Claude Code and other MCP clients can get a test key,
send a test code and read its status as tools. There is nothing to install and no key to set up
first:

```bash
claude mcp add --transport http notify https://api.n0t1fy.dev/mcp
```

Then ask your agent: "Get a NOTIFY test key and send a test verification code to
+995512345670." With a test key nothing is really sent and nothing is charged. Use a test key
with the MCP server; your application's own code holds the live key. The settings for
`.mcp.json` and other clients are at
[n0t1fy.dev/api#mcp-server](https://n0t1fy.dev/api#mcp-server). The tools are for trying NOTIFY
while you build: your application's own code calls the HTTP API, as the programs here do.

## 3. The same with curl, step by step

Send a code. Generate a new `Idempotency-Key` for every new message (`uuidgen` comes with macOS
and most Linux systems; any unique string works), and reuse it only to retry that same request:
within 24 hours, NOTIFY then answers with the original message instead of sending a second SMS.
This one asks for the English text:

```bash
curl -sS -X POST https://api.n0t1fy.dev/v1/messages \
  -H "Authorization: Bearer $NOTIFY_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  --data '{
    "to": "+995512345670",
    "template": "verification_code",
    "variables": { "code": "482913" },
    "locale": "en"
  }'
```

Leave out `"locale"` for the Georgian text. There is no free-text field: the three templates are
`verification_code` and `login_code` (variable `code`, 4 to 8 digits) and `password_reset_code`
(`code` and `minutes`). Every variable value is a JSON string.

The answer is `201` with a message object. Read its `status`: `201` means the message exists,
not that it arrived.

```json
{ "id": "msg_01K…", "object": "message", "to": "+9955••••••00", "status": "submitted", "segments": 1, … }
```

Then read the message until it settles:

```bash
curl -sS https://api.n0t1fy.dev/v1/messages/msg_01K… \
  -H "Authorization: Bearer $NOTIFY_API_KEY"
```

## Statuses, and when to stop polling

NOTIFY does not call your application back: read the message to learn what happened.

| `status` | Meaning | Changes later? |
| --- | --- | --- |
| `queued` | Waiting to be handed to the provider. Brief. | Usually |
| `submitted` | The provider accepted it. **Not yet confirmed on the phone.** | Usually |
| `delivered` | Confirmed delivered. | No |
| `undeliverable` | Confirmed not delivered; see `error`. | No |
| `failed` | Refused; nothing will be delivered. See `error`. | No |
| `unknown` | It may or may not have been sent. **Do not send it again automatically.** | No |

Poll only while the status is `queued` or `submitted`. Start after about 2 seconds and double the
wait, up to 30 seconds. **Always set a time limit** (the examples use two minutes). When it
passes, record the message as unconfirmed and do not send it again. A read that gets no answer,
a `429` or a `5xx` changes nothing: keep polling. A read refused with `401`, `403` or `404` will
not change by waiting: stop, and log the `error.code`.

A `503 provider_unavailable` means nothing was sent: retry with the same `Idempotency-Key`. No
answer at all, or another `5xx`, means the SMS may or may not have been sent: retry the same
request with the same `Idempotency-Key`, and never send a new code automatically. The examples
retry no answer and a `500`, `502`, `503` or `504`, three attempts 5 seconds apart, and stop at
once on any other `5xx`. Any other error answers with `error.code`, an
`error.message` that says what to change, and a `request_id` to quote when you ask for help.

## Let NOTIFY check the code

NOTIFY can also make the code, send it and check what the user types, so your application never
stores a code at all:

1. `POST /v1/verifications` with `{ "to": "+995591234567" }` and a new `Idempotency-Key`. NOTIFY
   sends a random six-digit code and answers `201` with a verification `id`. Show the code field
   at once.
2. `POST /v1/verifications/{id}/check` with the same number and the code the user typed:
   `{ "to": "+995591234567", "code": "482913" }`.

Let the user in only when a check answers `200` with status `approved`; treat every other
answer, a timeout and a network error as not approved. A code works for 10 minutes and five
checks, once, and a new start for the same number replaces it. Do not retry a check by itself:
every check spends an attempt.

With a test key, use the test numbers `+995512345670` to `+995512345679`: their code is always
`000000`, and nothing is sent.

```bash
curl -q -sS -X POST https://api.n0t1fy.dev/v1/verifications \
  -H "Authorization: Bearer $NOTIFY_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  --data '{ "to": "+995512345670" }'
```

```bash
curl -q -sS -X POST https://api.n0t1fy.dev/v1/verifications/ver_your_id_here/check \
  -H "Authorization: Bearer $NOTIFY_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{ "to": "+995512345670", "code": "000000" }'
```

The [API reference](https://n0t1fy.dev/api#verifications) lists every answer.

## A verification form to copy

`verify-form/` is a phone verification step you can copy into your sign-up or sign-in page: a
page that asks for a Georgian mobile number and the code NOTIFY texts to it, and the two server
routes behind it. Node 22 or newer, no packages:

```bash
node verify-form/server.mjs
```

Open `http://localhost:3000`. With a test key, use the test number `+995512345670` and the code
`000000`; nothing is sent. `+995512345671` to `+995512345674` act out failures (see
[Test recipients](#test-recipients)).

How it is built, and what to keep when you copy it:

- **The key stays on the server.** The page talks only to its own server, `POST /verify/start`
  and `POST /verify/check`, never to NOTIFY.
- **The browser sends only the number, the code and its language.** The server keeps the number
  the code was sent to in the session, and a check always uses that number.
- **Only a check's `200` with status `approved` confirms the number.** Every other answer, a
  timeout included, is "not confirmed". A check is never retried by itself.
- **"Try again" repeats a start instead of sending a second code**: a start that got no answer
  (for ten minutes, while its code could still work), or the start of the code the browser
  already holds, while a new code would still wait (the page lost the answer, or was reloaded).
  The repeat has the same `Idempotency-Key`, number and language, so NOTIFY answers with the
  original code and sends nothing. A check whose approval the page lost gets the same answer when
  the same code is typed again; any other code ends it.
- **The form keeps its own limits, on top of NOTIFY's**: one code a minute and five an hour to one
  number (NOTIFY's own hour is five too, and its ten in 24 hours also comes back as "too many
  codes"), and ten an hour from one address, where an IPv6 `/64` network counts as one address.
  "Send a new code" opens when these limits would allow a new code. A start NOTIFY refuses (no
  credits left, an SMS the provider refused, a limit of NOTIFY's) counts against none of them, as
  at NOTIFY, and every refusal is logged with NOTIFY's error code and `request_id`. Add a bot
  check (a CAPTCHA) to the phone step: every live code costs a credit, and a form that texts any
  number is what an abuser looks for.
- **Sessions and counts live in the server's memory.** A session (the number, the code the user
  may type, a lost start) is made only once NOTIFY takes a start, and lasts 30 minutes from its
  last use, as its cookie does. In production keep the sessions and the counts in your database
  or Redis: with two instances, a cluster or a serverless host, a check would find no session,
  and a restart forgets lost starts, so the next try would send a second code.
- **Behind a reverse proxy, the address is the proxy's.** Change `visitorAddress()` in
  `server.mjs` to read the address your own proxy appends to `X-Forwarded-For` (the last entry,
  behind one proxy), never an entry the visitor could have written; in Express,
  `app.set("trust proxy", 1)` and `request.ip`. Otherwise every visitor shares one address, and
  the whole site gets ten codes an hour.
- **Only its own page may call the routes.** Each route first calls `refused()`, which answers
  `403` when the `Origin` header is not the page's, and `415` when the request is not
  `Content-Type: application/json`, which a page on another site cannot send without asking
  first. The routes need no cookie, and many frameworks read a `text/plain` body as JSON all the
  same, so without `refused()` any site could make its visitors' browsers ask for codes.
- **The user never sees an error code**: one sentence in English or Georgian for each case. When a
  limit is reached, the sentence says how long to wait and goes when the wait ends, and the
  "Send a new code" button stays off until then, counting down its last 90 seconds.

To use it in your app, copy the two routes and `refused()` into your backend, and `index.html`,
`form.js` and `form.css` into your frontend. Keep what the rest of `server.mjs` does around them,
in your framework's own way:

- the `Host` check: a request for any other host name gets `421`, which stops a DNS rebinding
  attack (another site's name pointed at your server). Serve the page and the routes on one
  host, and behind a reverse proxy pass the `Host` header through (nginx:
  `proxy_set_header Host $host;`, Apache: `ProxyPreserveHost On`), or every request gets `421`;
- a body of at most 1 KiB, and a JSON object;
- these response headers: `Content-Security-Policy` with `default-src 'none'`, `script-src
  'self'`, `style-src 'self'`, `connect-src 'self'`, `form-action 'self'`, `base-uri 'none'` and
  `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`;
  and `Cache-Control: no-store` on the routes' answers;
- the session cookie: `HttpOnly`, `SameSite=Strict`, and on an `https` site `Secure` and the
  `__Host-` prefix, which only your host may set;
- a live key on a public site: `server.mjs` refuses to start with a test key when `SITE_ORIGIN` is
  a public address, because the page's hint then tells every visitor the test number and its
  code, and `000000` lets anyone through. That check runs at start-up, outside the two routes, so
  your own backend must make it too: never deploy a test key.

Each refusal (`403`, `415`, `421`, `413`, `400`) answers a short error and logs its reason.

At the comment "This is where your app records `to`" in `server.mjs`, store `to` for your user:
the number the code was sent to, read once before the check waited on NOTIFY. Never read the
number from the session again there: another request of the same browser may have changed it
meanwhile. If that signs the user in, start a fresh session of your app there rather than keep
the one from before the sign-in. The settings, beside `NOTIFY_API_KEY` and `NOTIFY_BASE_URL`:

| Variable | Meaning |
| --- | --- |
| `SITE_ORIGIN` | The address people open the page at, such as `https://www.example.ge`, where the routes answer too. Without it, only `http://localhost` and `http://127.0.0.1` on this port are allowed. Plain `http://` is for this machine only. With a public address the server needs a live key: it refuses a test key, whose hint would tell every visitor the test numbers and their code. |
| `PORT` | A number from `0` to `65535`; defaults to `3000`. |
| `HOST` | Defaults to `127.0.0.1`, this machine only. |

## Checking the code

If your application makes its own codes and sends them with `POST /v1/messages`, as these
examples do, it creates, stores and checks them:

- Create it with a cryptographically secure generator, as these examples do.
- Store only an HMAC of it (a hash keyed with a secret only your server knows), with its user,
  the number it was sent to, what it is for, an expiry of about ten minutes, and a count of
  wrong attempts. A new code replaces the previous one for the same user and purpose.
- Limit sends per phone number, per user and per IP address (for example one a minute and five
  an hour per phone number): every live SMS costs a credit.
- Compare the typed code in constant time. Reject one that has expired, was made for another
  purpose, or is checked for a number other than the number it was sent to. Discard it after
  about five wrong attempts, and delete it on success, so each code works only once.
- Let the user type the code as soon as the send returns `201` (or `200`, when a retry with the
  same `Idempotency-Key` gets the original message) and the status is not `failed`: do not wait
  for `delivered`. These examples poll until the message settles only to show every status;
  a sign-in page should not. After `undeliverable`, or `failed` with `invalid_recipient`, ask
  the user to check the number; any other `failed` code is a problem on your side or NOTIFY's.

The [API reference](https://n0t1fy.dev/api#checking-codes) explains each step.

## Test recipients

With a test key, these numbers act out the cases your code must handle:

| Recipient | What happens |
| --- | --- |
| `+995512345671` | `201` with `failed`: the provider refused it. |
| `+995512345672` | `503 provider_unavailable`: retry-safe. |
| `+995512345673` | `201` with `unknown`: do not retry automatically. |
| `+995512345674` | `201` with `submitted`, then `undeliverable`. |
| Any other valid number | `201` with `submitted`, then `delivered`. |

Both later outcomes usually take 5 to 30 seconds. Try one: `NOTIFY_TO=+995512345674 node node/send.mjs`.

## Going live

A test key stays a test key. Real SMS need an `sk_live_…` key: sign in at
[n0t1fy.dev/login](https://n0t1fy.dev/login) with GitHub or Google, and create one on the
dashboard. A new account gets 100 free real SMS (up to 20 a day, while the free allowance
lasts); after that, see
[pricing](https://n0t1fy.dev/pricing). With a live key, the three send programs refuse to run
until `NOTIFY_TO` is set, so they never text a made-up number. The verification form refuses a
test key when `SITE_ORIGIN` is a public address: with a test key, its page tells a user who types
a real number the test numbers and their code.

## For AI coding agents

Everything above works without a browser, apart from the form's page. The full contract, in
formats made for you:

- [llms.txt](https://n0t1fy.dev/llms.txt): integration rules in one page
- [api.md](https://n0t1fy.dev/api.md): the API reference in Markdown
- [openapi.json](https://api.n0t1fy.dev/openapi.json): the OpenAPI document
- [MCP server](https://n0t1fy.dev/api#mcp-server): `https://api.n0t1fy.dev/mcp`, the same
  operations as tools, `start_verification` and `check_verification` included

## Links

- API reference for people: [n0t1fy.dev/api](https://n0t1fy.dev/api)
- Interactive docs: [api.n0t1fy.dev/docs](https://api.n0t1fy.dev/docs)
- Pricing: [n0t1fy.dev/pricing](https://n0t1fy.dev/pricing)
- Questions: [contact@n0t1fy.dev](mailto:contact@n0t1fy.dev)

MIT licensed. NOTIFY is operated by Lean Systems.
