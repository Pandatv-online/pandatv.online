/**
 * Panda TV — серверный релей заявок в Telegram (Cloudflare Worker).
 *
 * Зачем он нужен:
 * токен бота нельзя держать в js/main.js — всё, что отдаётся браузеру,
 * может прочитать любой посетитель (View Source / DevTools → Network).
 * Этот воркер принимает заявку с сайта и сам обращается к Telegram Bot API,
 * так что токен остаётся только на сервере.
 *
 * Деплой:
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler deploy worker/telegram-relay.js --name pandatv-lead-relay
 *   3. wrangler secret put TELEGRAM_BOT_TOKEN    # новый токен от @BotFather
 *      wrangler secret put TELEGRAM_CHAT_ID
 *   4. В js/main.js заменить LEAD_ENDPOINT на URL воркера.
 *
 * Переменные окружения (секреты, не в репозитории):
 *   TELEGRAM_BOT_TOKEN — токен бота
 *   TELEGRAM_CHAT_ID   — чат, куда падают заявки
 *   ALLOWED_ORIGIN     — https://pandatv.online (по умолчанию)
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

    const text = [
      "📺 Новый запрос на подписку:",
      `👤 Имя: ${clean(data.name, 100)}`,
      `📞 Телефон: ${clean(data.phone, 40)}`,
      `✉️ Email: ${clean(data.email, 120)}`,
      `🌍 Страна: ${clean(data.country, 80)}`,
      `📦 Тариф: ${clean(data.plan, 80)}`,
    ].join("\n");

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
      // Тело ответа Telegram наружу не отдаём — там может быть часть токена.
      console.error("Telegram API error", response.status);
      return new Response("Upstream Error", { status: 502, headers: cors });
    }

    return Response.json({ ok: true }, { headers: cors });
  },
};
