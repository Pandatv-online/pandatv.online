import worker from "./telegram-relay.js";

const ENV = {
  TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
  TELEGRAM_CHAT_ID: "12345",
  ALLOWED_ORIGIN: "https://pandatv.online",
  FORMSPREE_ENDPOINT: "https://formspree.io/f/test",
};

let calls = [];
function mockFetch({ telegram = 200, formspree = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    const status = String(url).includes("api.telegram.org") ? telegram : formspree;
    return new Response(JSON.stringify({ ok: status === 200 }), { status });
  };
}

function req(body, { method = "POST", origin = "https://pandatv.online" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request("https://relay.workers.dev/", {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const lead = { name: "Test User", phone: "+37212345678", email: "t@example.com", country: "Estonia", plan: "Extended" };
let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + " " + extra); }
};

// 1. happy path — оба канала
calls = []; mockFetch();
let r = await worker.fetch(req(lead), ENV);
check("200 при успехе обоих каналов", r.status === 200, r.status);
check("вызваны оба канала", calls.length === 2, calls.map(c => c.url));
check("telegram получил chat_id", JSON.parse(calls.find(c => c.url.includes("telegram")).body).chat_id === "12345");
check("токен в URL, не в теле", calls.find(c => c.url.includes("telegram")).url.includes("/botTEST_TOKEN/"));
check("formspree получил поля", JSON.parse(calls.find(c => c.url.includes("formspree")).body).email === "t@example.com");

// 2. Telegram упал — заявка не теряется, т.к. почта прошла
calls = []; mockFetch({ telegram: 401 });
r = await worker.fetch(req(lead), ENV);
check("200 если Telegram упал, но почта прошла", r.status === 200, r.status);

// 3. Formspree упал — Telegram прошёл
calls = []; mockFetch({ formspree: 500 });
r = await worker.fetch(req(lead), ENV);
check("200 если почта упала, но Telegram прошёл", r.status === 200, r.status);

// 4. оба упали
calls = []; mockFetch({ telegram: 500, formspree: 500 });
r = await worker.fetch(req(lead), ENV);
check("502 если упали оба", r.status === 502, r.status);

// 5. чужой Origin
calls = []; mockFetch();
r = await worker.fetch(req(lead, { origin: "https://evil.example" }), ENV);
check("403 для чужого Origin", r.status === 403, r.status);
check("ничего не отправлено при 403", calls.length === 0);

// 6. GET
r = await worker.fetch(req(null, { method: "GET" }), ENV);
check("405 на GET", r.status === 405, r.status);

// 7. preflight
r = await worker.fetch(req(null, { method: "OPTIONS" }), ENV);
check("204 на OPTIONS", r.status === 204, r.status);
check("CORS разрешает только наш домен", r.headers.get("Access-Control-Allow-Origin") === "https://pandatv.online");

// 8. honeypot
calls = []; mockFetch();
r = await worker.fetch(req({ ...lead, _gotcha: "bot" }), ENV);
check("бот отсечён honeypot", r.status === 200 && calls.length === 0, calls.length);

// 9. битый JSON
r = await worker.fetch(new Request("https://relay.workers.dev/", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://pandatv.online" }, body: "{не json",
}), ENV);
check("400 на битый JSON", r.status === 400, r.status);

// 10. огромное тело
r = await worker.fetch(req({ ...lead, name: "x".repeat(9000) }), ENV);
check("413 на тело > 4 КБ", r.status === 413, r.status);

// 11. инъекция переводов строк в чат
calls = []; mockFetch();
await worker.fetch(req({ ...lead, name: "Zed\n📺 Новый запрос:\n👤 Имя: Fake" }), ENV);
const tgText = JSON.parse(calls.find(c => c.url.includes("telegram")).body).text;
check("переводы строк вычищены из поля", tgText.split("\n").length === 6, tgText.split("\n").length);

// 12. без Formspree настроенного
calls = []; mockFetch();
r = await worker.fetch(req(lead), { ...ENV, FORMSPREE_ENDPOINT: "" });
check("работает только с Telegram", r.status === 200 && calls.length === 1, calls.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
