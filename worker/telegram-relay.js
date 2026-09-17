/**
 * Panda TV — серверный релей заявок (Cloudflare Worker).
 *
 * Зачем он нужен:
 * токен бота нельзя держать в js/main.js — всё, что отдаётся браузеру,
 * может прочитать любой посетитель (View Source / DevTools → Network).
 * Этот воркер принимает заявку с сайта и сам обращается к Telegram Bot API,
 * так что токен остаётся только на сервере.
 *
 * Заявка уходит в два канала сразу: в Telegram и на Formspree (почта).
 * Если один канал упал, заявка всё равно не теряется.
 *
 * Деплой — см. worker/README.md.
 *
 * Секреты (задаются через `wrangler secret put`, в репозиторий не попадают):
 *   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
 *   TELEGRAM_CHAT_ID   — чат, куда падают заявки
 *
 * Обычные переменные (лежат в wrangler.toml, не секретны):
 *   ALLOWED_ORIGIN      — https://pandatv.online
 *   FORMSPREE_ENDPOINT  — дубль заявки на почту; пустая строка отключает
 */

const DEFAULT_ORIGIN = "https://pandatv.online";
const MAX_BODY_BYTES = 4096;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// Telegram-разметку не используем, но текст всё равно чистим от управляющих
// символов и обрезаем — чтобы через форму нельзя было залить мусор в чат.
function clean(value, limit = 200) {
  return String(value ?? "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, limit);
}

async function sendToTelegram(env, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    }
  );

  if (!response.ok) {
    // Тело ответа Telegram наружу не отдаём и не логируем целиком —
    // в сообщении об ошибке может оказаться часть токена.
    throw new Error(`Telegram API responded ${response.status}`);
  }
}

async function sendToFormspree(endpoint, fields) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(fields),
  });

  if (!response.ok) {
    throw new Error(`Formspree responded ${response.status}`);
  }
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
    const cors = corsHeaders(allowedOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    // Заявки принимаем только со своего сайта.
    const origin = request.headers.get("Origin");
    if (origin && origin !== allowedOrigin) {
      return new Response("Forbidden", { status: 403, headers: cors });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413, headers: cors });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return new Response("Bad Request", { status: 400, headers: cors });
    }

    // Простейшая защита от ботов: скрытое поле, которое человек не заполняет.
    if (clean(data._gotcha)) {
      return Response.json({ ok: true }, { headers: cors });
    }

    const fields = {
      name: clean(data.name, 100),
      phone: clean(data.phone, 40),
      email: clean(data.email, 120),
      country: clean(data.country, 80),
      plan: clean(data.plan, 80),
    };

    const text = [
      "📺 Новый запрос на подписку:",
      `👤 Имя: ${fields.name}`,
      `📞 Телефон: ${fields.phone}`,
      `✉️ Email: ${fields.email}`,
      `🌍 Страна: ${fields.country}`,
      `📦 Тариф: ${fields.plan}`,
    ].join("\n");

    // Оба канала параллельно: упавший Telegram не должен терять заявку,
    // которая уже ушла на почту, и наоборот.
    const targets = [{ name: "telegram", run: sendToTelegram(env, text) }];

    if (env.FORMSPREE_ENDPOINT) {
      targets.push({
        name: "formspree",
        run: sendToFormspree(env.FORMSPREE_ENDPOINT, {
          ...fields,
          message: text,
          _subject: `Panda TV — заявка на тариф ${fields.plan}`,
        }),
      });
    }

    const results = await Promise.allSettled(targets.map((t) => t.run));

    const failed = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failed.push(targets[i].name);
        console.error(`${targets[i].name} delivery failed:`, result.reason?.message);
      }
    });

    // Заявка потеряна, только если не прошёл ни один канал.
    if (failed.length === targets.length) {
      return new Response("Upstream Error", { status: 502, headers: cors });
    }

    return Response.json({ ok: true }, { headers: cors });
  },
};
