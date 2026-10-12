# NOTIFY examples

Send transactional one-time codes by SMS to Georgian phone numbers (`+995`) from your
application: verification, sign-in and password-reset codes, in Georgian or English, through one
small HTTP API with honest delivery status.

**Not for marketing or bulk SMS.** NOTIFY sends three code templates to people who asked for
them. Messages go out under the shared sender name `NOTIFY`, unless a sender name of your own
has been approved for your project.

These examples use plain HTTP with no SDK: Node, Python and curl. Each one sends a verification
code with a test key, then polls the message until it settles. A test key never sends a real
SMS and costs nothing.

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
| `NOTIFY_TO` | The recipient, `+9955` and eight digits. Required with a live key; with a test key it defaults to `+995500000000`. |
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
+995500000000." With a test key nothing is really sent and nothing is charged. Use a test key
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
    "to": "+995500000000",
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

## Checking the code

NOTIFY sends the code; your application creates, stores and checks it:

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
| `+995500000001` | `201` with `failed`: the provider refused it. |
| `+995500000002` | `503 provider_unavailable`: retry-safe. |
| `+995500000003` | `201` with `unknown`: do not retry automatically. |
| `+995500000004` | `201` with `submitted`, then `undeliverable`. |
| Any other valid number | `201` with `submitted`, then `delivered`. |

Both later outcomes usually take 5 to 30 seconds. Try one: `NOTIFY_TO=+995500000004 node node/send.mjs`.

## Going live

A test key stays a test key. Real SMS need an `sk_live_…` key: sign in at
[n0t1fy.dev/login](https://n0t1fy.dev/login) with GitHub or Google, and create one on the
dashboard. A new account gets 100 free real SMS (up to 20 a day, while the free allowance
lasts); after that, see
[pricing](https://n0t1fy.dev/pricing). With a live key, these examples refuse to run until
`NOTIFY_TO` is set, so they never text a made-up number.

## For AI coding agents

Everything above works without a browser. The full contract, in formats made for you:

- [llms.txt](https://n0t1fy.dev/llms.txt): integration rules in one page
- [api.md](https://n0t1fy.dev/api.md): the API reference in Markdown
- [openapi.json](https://api.n0t1fy.dev/openapi.json): the OpenAPI document
- [MCP server](https://n0t1fy.dev/api#mcp-server): `https://api.n0t1fy.dev/mcp`, the same
  operations as tools

## Links

- API reference for people: [n0t1fy.dev/api](https://n0t1fy.dev/api)
- Interactive docs: [api.n0t1fy.dev/docs](https://api.n0t1fy.dev/docs)
- Pricing: [n0t1fy.dev/pricing](https://n0t1fy.dev/pricing)
- Questions: [contact@n0t1fy.dev](mailto:contact@n0t1fy.dev)

MIT licensed. NOTIFY is operated by Lean Systems.
