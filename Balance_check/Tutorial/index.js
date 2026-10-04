// Kavopay test worker (single file, no imports, no wrangler needed)
// Deploy as-is from Cynïx HTML -> https://tutorial.godstimesunju.workers.dev
//
// Keys (optional): add worker variables/secrets KAVOPAY_PUBLIC_KEY and
// KAVOPAY_SECRET_KEY. If they are not set, the worker uses the keys the
// test page sends in the X-Public-Key / Authorization headers.

/* ======================= config ======================= */

const KAVOPAY_BASE = "https://api.kavopaywalletz.com";
const METHODS = ["card", "opay", "ussd", "bank_transfer"];
const BANK_CODES = ["044", "058", "033", "057", "011", "070", "232", "032", "076", "082"];
const MIN_AMOUNT = 100;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Public-Key, Authorization",
  "Access-Control-Max-Age": "86400",
};

/* ======================= helpers ======================= */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS,
      ...extraHeaders,
    },
  });
}

function fail(status, error, message, extraHeaders = {}) {
  return json({ ok: false, error, message }, status, extraHeaders);
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function getCredentials(request, env) {
  const publicKey = String((env && env.KAVOPAY_PUBLIC_KEY) || request.headers.get("X-Public-Key") || "").trim();
  const fromHeader = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const secretKey = String((env && env.KAVOPAY_SECRET_KEY) || fromHeader).trim();
  return { publicKey, secretKey };
}

// Refuses to call upstream without a public key: Kavopay blocks the IP for 30 min in that case.
async function callKavopay(request, env, path, { method = "GET", body } = {}) {
  const { publicKey, secretKey } = getCredentials(request, env);

  if (!publicKey) {
    return fail(400, "missing_public_key",
      "X-Public-Key is missing. Request was NOT sent to Kavopay (a missing key gets the IP blocked for 30 minutes).");
  }
  if (!secretKey) {
    return fail(401, "missing_secret_key", "Secret key is missing. Send it as 'Authorization: Bearer <secret>'.");
  }

  const headers = {
    "X-Public-Key": publicKey,
    Authorization: `Bearer ${secretKey}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(KAVOPAY_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: "bad_upstream_response", message: text.slice(0, 300) };
    }

    const extra = {};
    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter) extra["Retry-After"] = retryAfter;

    return json(data, res.status, extra);
  } catch (err) {
    if (err && err.name === "AbortError") {
      return fail(504, "upstream_timeout", "Kavopay took too long to respond (15s). Try again.");
    }
    return fail(502, "upstream_unreachable", "Could not reach the Kavopay API.");
  } finally {
    clearTimeout(timer);
  }
}

/* ======================= route handlers ======================= */

function health(request, env) {
  return json({
    ok: true,
    service: "kavopay-test-worker",
    server_keys: {
      public: Boolean(env && env.KAVOPAY_PUBLIC_KEY),
      secret: Boolean(env && env.KAVOPAY_SECRET_KEY),
    },
    routes: ["GET  /balance", "POST /payments", "GET  /payments/:reference"],
  });
}

// GET /balance -> GET /v1/balance
function getBalance(request, env) {
  return callKavopay(request, env, "/v1/balance");
}

// POST /payments -> POST /v1/payments
async function createPayment(request, env) {
  let input;
  try {
    input = await request.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }

  const amount = Number(input.amount);
  const method = String(input.method || "").toLowerCase();

  if (!Number.isFinite(amount) || amount < MIN_AMOUNT) {
    return fail(422, "invalid_amount", `Amount must be a number, minimum ₦${MIN_AMOUNT}.`);
  }
  if (!METHODS.includes(method)) {
    return fail(422, "invalid_method", `Method must be one of: ${METHODS.join(", ")}.`);
  }

  const payload = { amount, method };

  if (method === "card" || method === "opay") {
    if (!input.redirect_url || !isHttpUrl(input.redirect_url)) {
      return fail(422, "invalid_redirect_url",
        "redirect_url is required for card and opay and must be a valid http(s) URL.");
    }
    payload.redirect_url = input.redirect_url;
  }

  if (method === "ussd") {
    const bankCode = String(input.bank_code || "");
    if (!BANK_CODES.includes(bankCode)) {
      return fail(422, "invalid_bank_code", `bank_code is required for ussd. Supported: ${BANK_CODES.join(", ")}.`);
    }
    payload.bank_code = bankCode;
  }

  return callKavopay(request, env, "/v1/payments", { method: "POST", body: payload });
}

// GET /payments/:reference -> GET /v1/payments/:reference
function verifyPayment(request, env, params) {
  const reference = String(params.reference || "");
  if (!/^[\w-]{5,120}$/.test(reference)) {
    return fail(422, "invalid_reference", "Payment reference looks invalid.");
  }
  return callKavopay(request, env, `/v1/payments/${encodeURIComponent(reference)}`);
}

/* ======================= router ======================= */

// [method, path, handler]
const ROUTES = [
  ["GET", "/", health],
  ["GET", "/health", health],
  ["GET", "/balance", getBalance],
  ["POST", "/payments", createPayment],
  ["GET", "/payments/:reference", verifyPayment],
].map(([method, path, handler]) => {
  const keys = [];
  const pattern = path.replace(/:(\w+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { method, handler, keys, re: new RegExp(`^${pattern}/?$`) };
});

function match(pathname) {
  const hits = [];
  for (const route of ROUTES) {
    const m = pathname.match(route.re);
    if (m) {
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      hits.push({ route, params });
    }
  }
  return hits;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      const { pathname } = new URL(request.url);
      const hits = match(pathname);

      if (hits.length === 0) {
        return fail(404, "not_found", `No route for ${pathname}`);
      }

      const hit = hits.find((h) => h.route.method === request.method);
      if (!hit) {
        const allow = hits.map((h) => h.route.method).join(", ");
        return fail(405, "method_not_allowed", `Use ${allow} for this endpoint.`, { Allow: allow });
      }

      return await hit.route.handler(request, env, hit.params, ctx);
    } catch (err) {
      return fail(500, "worker_error", "Something broke inside the worker.");
    }
  },
};
