const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname === "/") {
  return json({
    ok: true,
    service: "ebay-prefill-worker",
    routes: ["/draft", "/auth/start", "/auth/callback", "/auth/declined"]
  });
}

if (url.pathname === "/auth/start") {
  return authStart(env);
}

if (url.pathname === "/auth/callback") {
  return authCallback(url, env);
}

if (url.pathname === "/auth/declined") {
  return json({ ok: false, error: "authorization_declined" });
}

    if (url.pathname === "/draft" && request.method === "POST") {
      const body = await request.json();

      const text = [
        body.title,
        body.notes,
        body.ocrText
      ].filter(Boolean).join(" ");

      const manualMPN = body.mpn?.trim();
      const manualBrand = body.brand?.trim();

      const extracted = extractPartNumbers(text);

      const mpn = manualMPN || extracted[0] || "";
      const brand = manualBrand || inferBrand(text);

      const rating = detectAmp(text);
      const type = detectType(text);

      const title = clean(
        body.title ||
        [brand, mpn, rating, type].filter(Boolean).join(" ")
      );

      const price = estimatePrice({ type, rating, mpn, brand });

      const category = "Circuit Breakers";
      const categoryId = "181841";

      const ebayUrl = buildEbayUrl({
        title,
        price,
        categoryId
      });

      return json({
        title,
        brand,
        mpn,
        rating,
        type,
        price,
        category,
        pricingConfidence: "fast-estimate",
        instantEligible: true,
        ebayUrl
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};

function buildEbayUrl({ title, price, categoryId }) {
  const params = new URLSearchParams({
    title,
    price,
    category: categoryId,
    format: "BIN",
    condition: "1000"
  });

  return `https://www.ebay.com/sl/sell?${params.toString()}`;
}

function extractPartNumbers(text) {
  const t = text.toUpperCase();

  const matches = [
    ...(t.match(/\b[A-Z]{2,}\d{4,}\b/g) || []),
    ...(t.match(/\b[A-Z0-9]+-[A-Z0-9-]+\b/g) || [])
  ];

  return [...new Set(matches)];
}

function inferBrand(text) {
  const t = text.toLowerCase();

  if (t.includes("schneider") || t.includes("powerpact")) return "Schneider Electric";
  if (t.includes("ifm")) return "IFM";
  if (t.includes("allen-bradley")) return "Allen-Bradley";

  return "";
}

function detectAmp(text) {
  const match = text.match(/(\d{2,4})\s*A/i);
  return match ? `${match[1]}A` : "";
}

function detectType(text) {
  const t = text.toLowerCase();

  if (t.includes("breaker") || t.includes("powerpact")) return "Circuit Breaker";
  if (t.includes("sensor")) return "Sensor";

  return "Industrial Part";
}

function estimatePrice({ type, rating }) {
  const r = Number((rating || "").replace(/\D/g, ""));

  if (type === "Circuit Breaker") {
    if (r >= 150) return 450;
    if (r >= 100) return 300;
    return 175;
  }

  return 99;
}

function clean(str) {
  return String(str || "").replace(/\s+/g, " ").trim().slice(0, 80);
}
function authStart(env) {
  const scopes = [
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account"
  ].join(" ");

  const params = new URLSearchParams({
    client_id: env.EBAY_CLIENT_ID,
    redirect_uri: env.EBAY_RUNAME,
    response_type: "code",
    scope: scopes
  });

  return Response.redirect(
    `https://auth.ebay.com/oauth2/authorize?${params.toString()}`,
    302
  );
}

async function authCallback(url, env) {
  const code = url.searchParams.get("code");

  if (!code) {
    return json({
      ok: false,
      error: "missing_code",
      query: Object.fromEntries(url.searchParams.entries())
    }, 400);
  }

  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", env.EBAY_RUNAME);

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await res.json();

  return json({
    ok: res.ok,
    status: res.status,
    message: res.ok
      ? "Copy refresh_token into Cloudflare as EBAY_REFRESH_TOKEN."
      : "Token exchange failed.",
    refresh_token: data.refresh_token || null,
    raw: data
  }, res.ok ? 200 : 400);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}
