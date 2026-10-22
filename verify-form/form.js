// The browser half of the verification form. It talks only to its own server
// (POST /verify/start and POST /verify/check), never to NOTIFY, so no key is ever
// in the browser. Text is set with textContent only, never as HTML. It is a
// module: its names stay its own, whatever else your page loads.

// What the user reads, in English and Georgian. The user never sees an error code.
// English says "1 second" but "2 seconds"; Georgian keeps one form after a number.
const TEXT = {
  en: {
    title: "Confirm your phone number",
    phoneLabel: "Mobile number",
    send: "Send code",
    sent: "We sent a code to your phone. Enter it below.",
    codeLabel: "Code",
    verify: "Verify",
    resend: "Send a new code",
    resendIn: "Send a new code in {seconds} s",
    change: "Use another number",
    verified: "Your phone number is confirmed.",
    bad_number: "Enter a Georgian mobile number, such as 5XX XX XX XX.",
    bad_code: "Enter the six-digit code.",
    incorrect_code: "That code is not right. Check it and try again.",
    code_ended: "That code no longer works. Ask for a new one.",
    too_many_codes: {
      one: "Too many codes were requested for this number. You can ask for a new one in {minutes} minute.",
      other: "Too many codes were requested for this number. You can ask for a new one in {minutes} minutes.",
    },
    waitSeconds: {
      one: "Please wait {seconds} second and try again.",
      other: "Please wait {seconds} seconds and try again.",
    },
    waitMinutes: "Please try again in {minutes} minutes.",
    failed: "Something went wrong on our side. Try again in a moment, or contact support.",
    test_number_required: "This page uses a test key: use the test number +995512345670 and the code 000000.",
  },
  ka: {
    title: "დაადასტურეთ ტელეფონის ნომერი",
    phoneLabel: "მობილურის ნომერი",
    send: "კოდის გაგზავნა",
    sent: "კოდი თქვენს ტელეფონზე გავაგზავნეთ. შეიყვანეთ ქვემოთ.",
    codeLabel: "კოდი",
    verify: "დადასტურება",
    resend: "ახალი კოდის გაგზავნა",
    resendIn: "გააგზავნე ახალი კოდი {seconds} წამში",
    change: "გამოიყენე სხვა ნომერი",
    verified: "თქვენი ტელეფონის ნომერი დადასტურებულია.",
    bad_number: "შეიყვანეთ საქართველოს მობილურის ნომერი, მაგალითად 5XX XX XX XX.",
    bad_code: "შეიყვანეთ ექვსნიშნა კოდი.",
    incorrect_code: "კოდი არასწორია. გადაამოწმეთ და სცადეთ თავიდან.",
    code_ended: "ეს კოდი აღარ მუშაობს. მოითხოვეთ ახალი.",
    too_many_codes:
      "ამ ნომერზე ძალიან ბევრი კოდი იქნა მოთხოვნილი. ახლის მოთხოვნას {minutes} წუთში შეძლებთ.",
    waitSeconds: "დაელოდეთ {seconds} წამი და სცადეთ თავიდან.",
    waitMinutes: "სცადეთ თავიდან {minutes} წუთში.",
    failed: "ჩვენს მხარეს შეცდომა მოხდა. სცადეთ ცოტა ხანში, ან დაგვიკავშირდით.",
    test_number_required:
      "ეს გვერდი იყენებს სატესტო გასაღებს: გამოიყენეთ სატესტო ნომერი +995512345670 და კოდი 000000.",
  },
};
// The sentences that tell the user to wait: they go when the wait ends.
const WAITS = ["too_many_codes", "waitSeconds", "waitMinutes"];
// How long to wait when an answer names no time.
const FALLBACK_WAIT_SECONDS = 60;

const $ = (id) => document.getElementById(id);
let lang = (navigator.language || "").toLowerCase().startsWith("ka") ? "ka" : "en";
let step = "phone";
let busy = false;
let resendAt = 0; // when "send a new code" opens, in ms on this browser's clock
let blockedUntil = 0; // when a limit lets the next code be asked for, likewise
let notice = null; // [text key, values], kept to show it again in the other language
let timer = null;

function text(key, values = {}) {
  let template = TEXT[lang][key];
  if (typeof template !== "string") template = Object.values(values)[0] === 1 ? template.one : template.other;
  return template.replace(/\{(\w+)\}/g, (_, name) => values[name]);
}

function show(key, values = {}) {
  notice = key ? [key, values] : null;
  $("notice").textContent = key ? text(key, values) : "";
}

function render() {
  document.documentElement.lang = lang;
  document.title = text("title");
  for (const element of document.querySelectorAll("[data-text]")) {
    element.textContent = text(element.dataset.text);
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  }
  if (notice) show(...notice);
  tick();
}

// Keeps the controls' state and the resend countdown up to date, once a second.
function tick() {
  const now = Date.now();
  if (blockedUntil && blockedUntil <= now) {
    blockedUntil = 0;
    if (notice && WAITS.includes(notice[0])) show(null);
  }
  const wait = Math.max(resendAt, blockedUntil) - now;
  const resend = $("resend");
  resend.disabled = busy || wait > 0;
  resend.textContent =
    wait > 0 && wait <= 90_000 ? text("resendIn", { seconds: Math.ceil(wait / 1000) }) : text("resend");
  $("send").disabled = busy || blockedUntil > now;
  $("verify").disabled = busy;
  // While a request waits, the step cannot change under it.
  $("change").disabled = busy;
  $("phone").readOnly = busy;
  if (wait <= 0 && timer) {
    clearInterval(timer);
    timer = null;
  } else if (wait > 0 && !timer) {
    timer = setInterval(tick, 1000);
  }
}

function setBusy(value) {
  busy = value;
  document.querySelector(".card").setAttribute("aria-busy", String(value));
  tick();
}

function showStep(next) {
  step = next;
  $("phone-step").hidden = step !== "phone";
  $("code-step").hidden = step !== "code";
  $("done").hidden = step !== "done";
}

// Returns { status, data }: status 0 when no answer came.
async function post(path, body) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {}
    return { status: response.status, data: data && typeof data === "object" ? data : {} };
  } catch {
    return { status: 0, data: {} };
  }
}

// Seconds from the server, counted on this browser's clock, so that a phone whose
// clock is wrong still waits as long as it should.
const after = (seconds) => Date.now() + (Number.isFinite(seconds) ? seconds : FALLBACK_WAIT_SECONDS) * 1000;

// One sentence for the user, from the server's error code.
function explain(data) {
  const code = data.error;
  if (code === "too_many_codes" || code === "wait") {
    const named = Number.isFinite(data.retry_after);
    const seconds = named ? Math.max(1, Math.ceil(data.retry_after)) : FALLBACK_WAIT_SECONDS;
    blockedUntil = after(seconds);
    tick();
    const minutes = Math.ceil(seconds / 60);
    if (code === "too_many_codes") return show("too_many_codes", { minutes });
    return seconds < 90 ? show("waitSeconds", { seconds }) : show("waitMinutes", { minutes });
  }
  if (["bad_number", "bad_code", "incorrect_code", "test_number_required"].includes(code)) {
    return show(code);
  }
  if (code === "code_ended" || code === "no_code") return show("code_ended");
  return show("failed");
}

async function sendCode() {
  if (busy) return;
  const asked = step;
  show(null);
  setBusy(true);
  const { status, data } = await post("/verify/start", { phone: $("phone").value, locale: lang });
  setBusy(false);
  if (step !== asked) return; // the user moved on meanwhile: this answer is not theirs now
  if (status === 200 && typeof data.sent_to === "string") {
    resendAt = after(data.resend_after);
    $("sent-to").textContent = data.sent_to;
    $("code").value = "";
    showStep("code");
    tick();
    $("code").focus();
    return;
  }
  explain(data);
}

async function checkCode() {
  if (busy) return;
  // Spaces, and the invisible marks some apps add around a number pasted from a
  // message, are not part of the code.
  const code = $("code").value.replace(/[\s\p{Cf}]/gu, "");
  if (!/^[0-9]{6}$/.test(code)) return show("bad_code");
  const asked = step;
  show(null);
  setBusy(true);
  const { status, data } = await post("/verify/check", { code });
  setBusy(false);
  if (step !== asked) return;
  // The server says "verified" only when NOTIFY approved the code.
  if (status === 200 && typeof data.verified === "string") {
    showStep("done");
    $("done").focus(); // read out by screen readers, and keeps the focus on the page
    return;
  }
  explain(data);
  if (data.error === "incorrect_code") $("code").select();
  if (data.error === "code_ended" || data.error === "no_code") $("code").value = "";
}

$("phone-step").addEventListener("submit", (event) => {
  event.preventDefault();
  sendCode();
});
$("code-step").addEventListener("submit", (event) => {
  event.preventDefault();
  checkCode();
});
$("resend").addEventListener("click", sendCode);
// A wait shown for one number may not hold for another: the server decides.
$("phone").addEventListener("input", () => {
  blockedUntil = 0;
  if (notice && WAITS.includes(notice[0])) show(null);
  tick();
});
$("change").addEventListener("click", () => {
  blockedUntil = 0;
  show(null);
  showStep("phone");
  tick();
  $("phone").focus();
});
for (const button of document.querySelectorAll("[data-lang]")) {
  button.addEventListener("click", () => {
    lang = button.dataset.lang;
    render();
  });
}
render();
