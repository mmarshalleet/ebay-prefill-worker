const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  ...CORS_HEADERS
};

const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_INVENTORY_URL = "https://api.ebay.com/sell/inventory/v1";
const EBAY_TAXONOMY_URL = "https://api.ebay.com/commerce/taxonomy/v1/category_tree/0";
const EBAY_BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return json({
          ok: true,
          service: "ebay-prefill-worker",
          endpoints: [
            "POST /draft",
            "GET /draft?id=...",
            "POST /approve",
            "POST /publish",
            "POST /instant-list"
          ]
        });
      }

      if (url.pathname === "/draft" && request.method === "POST") {
        return await createDraft(request, env);
      }

      if (url.pathname === "/draft" && request.method === "GET") {
        return await getDraft(url, env);
      }

      if (url.pathname === "/approve" && request.method === "POST") {
        return await approveDraft(request, env);
      }

      if (url.pathname === "/publish" && request.method === "POST") {
        return await publishDraft(request, env);
      }

      if (url.pathname === "/instant-list" && request.method === "POST") {
        return await instantList(request, env);
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      return json({
        ok: false,
        error: err.message || "Unexpected error",
        details: err.details || null
      }, err.status || 500);
    }
  }
};

 async function createDraft(request, env) {
  requireBinding(env, "DRAFT_KV");

  const contentType = request.headers.get("Content-Type") || "";
  let input = {};

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();

    input = {
      title: form.get("title") || form.get("itemTitle") || "",
      notes: form.get("notes") || "",
      ocrText: form.get("ocrText") || form.get("ocr") || form.get("text") || "",
      condition: form.get("condition") || "New Open Box",
      quantity: Number(form.get("quantity") || 1),
      price: Number(form.get("price") || form.get("suggestedPrice") || 0),
      categoryId: form.get("categoryId") || "",
      brand: form.get("brand") || "",
      mpn: form.get("mpn") || form.get("partNumber") || "",
      imageUrls: parseJsonArray(form.get("imageUrls")),
      itemSpecifics: parseJsonObject(form.get("itemSpecifics"))
    };
  } else {
    const body = await request.json();

    input = {
      ...body,
      title: body.title || body.itemTitle || body.name || "",
      notes: body.notes || body.description || "",
      ocrText: body.ocrText || body.ocr || body.text || "",
      condition: body.condition || "New Open Box",
      quantity: Number(body.quantity || 1),
      price: Number(body.price || body.suggestedPrice || 0),
      categoryId: body.categoryId || "",
      brand: body.brand || "",
      mpn: body.mpn || body.partNumber || "",
      imageUrls: body.imageUrls || body.images || [],
      itemSpecifics: body.itemSpecifics || body.aspects || {}
    };
  }

  const fullText = [
    input.title,
    input.notes,
    input.ocrText,
    input.brand,
    input.mpn
  ].filter(Boolean).join("\n");

  const extracted = extractPartNumbers(fullText);
  const brand = input.brand || inferBrand(fullText);
  const mpn = input.mpn || extracted[0] || "";

  const itemSpecifics = normalizeItemSpecifics({
    Brand: brand,
    MPN: mpn,
    ...(input.itemSpecifics || {})
  });

  const draft = {
    id: crypto.randomUUID(),
    status: "draft",
    publishEnabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    title: cleanTitle(input.title || buildTitle({ brand, mpn, text: fullText })),
    brand,
    mpn,
    model: mpn,
    condition: input.condition,
    quantity: positiveInt(input.quantity, 1),
    price: input.price || null,
    suggestedPrice: input.price || null,
    categoryId: input.categoryId || "",

    notes: input.notes,
    ocrText: input.ocrText,
    ocrTextPreview: String(input.ocrText || "").slice(0, 500),
    extractedPartNumbers: extracted,

    itemSpecifics,
    ebayAspects: convertAspects(itemSpecifics),

    descriptionBullets: [
      brand ? `Brand: ${brand}` : "",
      mpn ? `MPN: ${mpn}` : "",
      `Condition: ${input.condition}`,
      input.notes ? `Notes: ${input.notes}` : ""
    ].filter(Boolean),

    imageUrls: Array.isArray(input.imageUrls) ? input.imageUrls.filter(Boolean) : [],

    input
  };

  await saveDraft(env, draft);
  return json(draft, 201);
}

async function getDraft(url, env) {
  requireBinding(env, "DRAFT_KV");

  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "missing_id" }, 400);

  const draft = await env.DRAFT_KV.get(id, { type: "json" });
  if (!draft) return json({ ok: false, error: "draft_not_found" }, 404);

  return json(draft);
}

async function approveDraft(request, env) {
  requireBinding(env, "DRAFT_KV");
  requireEbaySecrets(env);

  const body = await request.json();
  const draftId = String(body.draftId || "").trim();

  if (!draftId) {
    return json({ ok: false, error: "missing_draft_id" }, 400);
  }

  let draft = await env.DRAFT_KV.get(draftId, { type: "json" });
  if (!draft) {
    return json({ ok: false, error: "draft_not_found" }, 404);
  }

  draft = applyOverrides(draft, body);

  if (!draft.categoryId) {
    draft.categoryId = await suggestCategoryId(draft, env);
  }

  if (!draft.categoryId) {
    draft.status = "category_required";
    draft.updatedAt = new Date().toISOString();
    await saveDraft(env, draft);
    return json({
      ok: false,
      error: "category_required",
      message: "Add categoryId and approve again.",
      draft
    }, 422);
  }

  const offerDraft = await createEbayOfferDraftOnly(draft, env);
  await saveDraft(env, offerDraft);

  return json(offerDraft);
}

async function publishDraft(request, env) {
  requireBinding(env, "DRAFT_KV");
  requireEbaySecrets(env);

  const body = await request.json();
  const draftId = String(body.draftId || "").trim();

  if (!draftId) {
    return json({ ok: false, error: "missing_draft_id" }, 400);
  }

  let draft = await env.DRAFT_KV.get(draftId, { type: "json" });
  if (!draft) {
    return json({ ok: false, error: "draft_not_found" }, 404);
  }

  if (!draft.ebayOffer?.offerId) {
    draft = await createEbayOfferDraftOnly(draft, env);
  }

  const published = await publishExistingEbayOffer(draft, env);
  await saveDraft(env, published);

  return json(published);
}

async function instantList(request, env) {
  requireBinding(env, "DRAFT_KV");
  requireEbaySecrets(env);

  const body = await request.json();
  const draftId = String(body.draftId || "").trim();

  if (!draftId) {
    return json({ ok: false, error: "missing_draft_id" }, 400);
  }

  let draft = await env.DRAFT_KV.get(draftId, { type: "json" });
  if (!draft) {
    return json({ ok: false, error: "draft_not_found" }, 404);
  }

  draft = applyOverrides(draft, body);

  if (!draft.categoryId) {
    draft.categoryId = await suggestCategoryId(draft, env);
  }

  draft = await createEbayOfferDraftOnly(draft, env);
  draft = await publishExistingEbayOffer(draft, env);

  await saveDraft(env, draft);
  return json(draft);
}

async function createEbayOfferDraftOnly(draft, env) {
  const token = await getEbayToken(env);
  const sku = draft.sku || draft.id;

  const price = Number(draft.price || draft.suggestedPrice || 0);
  if (!price || price <= 0) {
    return {
      ...draft,
      status: "price_required",
      publishEnabled: false,
      ebayOfferWarnings: ["Price is required before creating an eBay offer."],
      updatedAt: new Date().toISOString()
    };
  }

  if (!draft.categoryId) {
    return {
      ...draft,
      status: "category_required",
      publishEnabled: false,
      ebayOfferWarnings: ["categoryId is required before creating an eBay offer."],
      updatedAt: new Date().toISOString()
    };
  }

  await ebayFetch(token, `/inventory_item/${encodeURIComponent(sku)}`, "PUT", {
    condition: mapConditionToEbay(draft.condition),
    availability: {
      shipToLocationAvailability: {
        quantity: positiveInt(draft.quantity || draft.input?.quantity, 1)
      }
    },
    product: {
      title: cleanTitle(draft.title),
      description: buildHtmlDescription(draft),
      imageUrls: draft.imageUrls || [],
      aspects: convertAspects(draft.itemSpecifics || draft.ebayAspects || [])
    }
  });

  const offerPayload = {
    sku,
    marketplaceId: env.EBAY_MARKETPLACE_ID || "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: positiveInt(draft.quantity || draft.input?.quantity, 1),
    categoryId: String(draft.categoryId),
    listingDescription: buildHtmlDescription(draft),
    listingDuration: "GTC",
    includeCatalogProductDetails: false,
    pricingSummary: {
      price: {
        value: price.toFixed(2),
        currency: env.EBAY_CURRENCY || "USD"
      }
    }
  };

  if (env.EBAY_LOCATION_KEY) {
    offerPayload.merchantLocationKey = env.EBAY_LOCATION_KEY;
  }

  if (
    env.EBAY_PAYMENT_POLICY_ID &&
    env.EBAY_RETURN_POLICY_ID &&
    env.EBAY_FULFILLMENT_POLICY_ID
  ) {
    offerPayload.listingPolicies = {
      paymentPolicyId: env.EBAY_PAYMENT_POLICY_ID,
      returnPolicyId: env.EBAY_RETURN_POLICY_ID,
      fulfillmentPolicyId: env.EBAY_FULFILLMENT_POLICY_ID
    };
  }

  const offer = await ebayFetch(token, "/offer", "POST", offerPayload);

  return {
    ...draft,
    sku,
    status: "ready_to_publish_later",
    publishEnabled: true,
    ebayOffer: {
      offerId: offer.offerId,
      sku,
      createdAt: new Date().toISOString()
    },
    ebayOfferWarnings: [],
    updatedAt: new Date().toISOString()
  };
}

async function publishExistingEbayOffer(draft, env) {
  const token = await getEbayToken(env);
  const offerId = draft.ebayOffer?.offerId;

  if (!offerId) {
    throw new Error("Missing offerId. Approve the draft first.");
  }

  const result = await ebayFetch(token, `/offer/${offerId}/publish`, "POST", null);

  return {
    ...draft,
    status: "published",
    publishEnabled: false,
    ebayListing: {
      listingId: result.listingId || result.listing?.listingId || null,
      publishedAt: new Date().toISOString(),
      raw: result
    },
    updatedAt: new Date().toISOString()
  };
}

async function getEbayToken(env) {
  const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", env.EBAY_REFRESH_TOKEN);
  body.set("scope", [
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/buy.browse"
  ].join(" "));

  const res = await fetch(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await safeJson(res);

  if (!res.ok) {
    throw apiError("eBay OAuth failed", res.status, data);
  }

  return data.access_token;
}

async function ebayFetch(token, path, method, payload) {
  const res = await fetch(`${EBAY_INVENTORY_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      Accept: "application/json"
    },
    body: payload ? JSON.stringify(payload) : undefined
  });

  const data = await safeJson(res);

  if (!res.ok) {
    throw apiError(`eBay Inventory API failed: ${method} ${path}`, res.status, data);
  }

  return data || {};
}

async function suggestCategoryId(draft, env) {
  try {
    const token = await getEbayToken(env);
    const query = encodeURIComponent(
      [draft.brand, draft.mpn, draft.title].filter(Boolean).join(" ")
    );

    const res = await fetch(`${EBAY_TAXONOMY_URL}/get_category_suggestions?q=${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    });

    const data = await safeJson(res);

    return data?.categorySuggestions?.[0]?.category?.categoryId || "";
  } catch {
    return "";
  }
}

function applyOverrides(draft, body) {
  const updated = { ...draft };

  if (body.title) updated.title = cleanTitle(body.title);
  if (body.price) updated.price = Number(body.price);
  if (body.suggestedPrice) updated.suggestedPrice = Number(body.suggestedPrice);
  if (body.categoryId) updated.categoryId = String(body.categoryId).trim();
  if (body.condition) updated.condition = body.condition;
  if (body.quantity) updated.quantity = positiveInt(body.quantity, 1);
  if (body.brand) updated.brand = body.brand;
  if (body.mpn) updated.mpn = body.mpn;
  if (Array.isArray(body.imageUrls)) updated.imageUrls = body.imageUrls.filter(Boolean);
  if (body.itemSpecifics) {
    updated.itemSpecifics = normalizeItemSpecifics(body.itemSpecifics);
  }

  updated.updatedAt = new Date().toISOString();
  return updated;
}

function normalizeItemSpecifics(input) {
  if (!input) return [];

  if (Array.isArray(input)) {
    return input
      .map((x) => ({
        name: String(x.name || x.Name || "").trim(),
        value: String(x.value || x.Value || "").trim()
      }))
      .filter((x) => x.name && x.value);
  }

  return Object.entries(input)
    .map(([name, value]) => ({
      name: String(name).trim(),
      value: Array.isArray(value) ? value.join(", ") : String(value || "").trim()
    }))
    .filter((x) => x.name && x.value);
}

function convertAspects(aspectsArray = []) {
  const out = {};

  for (const a of aspectsArray) {
    const name = a.name || a.Name;
    const value = a.value || a.Value;

    if (!name || !value) continue;

    out[String(name)] = Array.isArray(value)
      ? value.map(String)
      : [String(value)];
  }

  return out;
}

function buildHtmlDescription(draft) {
  const bullets = draft.descriptionBullets || [];
  const specs = normalizeItemSpecifics(draft.itemSpecifics || []);

  return `
<h2>${escapeHtml(draft.title || "Industrial Automation Part")}</h2>

<p>Surplus industrial automation equipment. Please verify compatibility before purchase.</p>

<ul>
${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n")}
</ul>

<h3>Item Specifics</h3>
<ul>
${specs.map((s) => `<li><strong>${escapeHtml(s.name)}:</strong> ${escapeHtml(s.value)}</li>`).join("\n")}
</ul>

<p><strong>Condition:</strong> ${escapeHtml(draft.condition || "New Open Box")}</p>
<p>Ships from The Automation Engineer.</p>
`.trim();
}

function mapConditionToEbay(condition) {
  const c = String(condition || "").toLowerCase();

  if (c.includes("open")) return "NEW_OTHER";
  if (c.includes("new")) return "NEW";
  if (c.includes("used")) return "USED_EXCELLENT";
  if (c.includes("for parts")) return "FOR_PARTS_OR_NOT_WORKING";

  return "NEW_OTHER";
}

function buildTitle({ brand, mpn, text }) {
  const type = detectType(text);
  return cleanTitle([brand, mpn, type || "Industrial Automation Part"].filter(Boolean).join(" "));
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function inferBrand(text) {
  const brands = [
    "Allen-Bradley",
    "Rockwell",
    "Siemens",
    "Keyence",
    "Omron",
    "Banner",
    "Schmersal",
    "Danfoss",
    "Lenze",
    "Phoenix Contact",
    "Schneider Electric",
    "Marel",
    "Ishida",
    "Secomea"
  ];

  const lower = String(text || "").toLowerCase();

  return brands.find((b) => lower.includes(b.toLowerCase())) || "";
}

function detectType(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("powerflex") || t.includes("vfd") || t.includes("drive")) return "VFD Drive";
  if (t.includes("panelview") || t.includes("hmi")) return "HMI";
  if (t.includes("compactlogix") || t.includes("controllogix") || t.includes("plc")) return "PLC Module";
  if (t.includes("sensor")) return "Sensor";
  if (t.includes("breaker")) return "Circuit Breaker";
  if (t.includes("relay")) return "Relay";

  return "Industrial Automation Part";
}

function extractPartNumbers(text) {
  const raw = String(text || "").match(/\b[A-Z0-9]{2,}[-./][A-Z0-9][A-Z0-9\-./]*\b/gi) || [];

  return [...new Set(
    raw
      .map((x) => x.toUpperCase().replace(/[.,;:]$/, ""))
      .filter((x) => x.length >= 4)
      .filter((x) => !/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(x))
  )].slice(0, 10);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function saveDraft(env, draft) {
  await env.DRAFT_KV.put(draft.id, JSON.stringify(draft), {
    expirationTtl: 60 * 60 * 24 * 30
  });
}

async function safeJson(res) {
  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function apiError(message, status, details) {
  const err = new Error(message);
  err.status = status;
  err.details = details;
  return err;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function requireBinding(env, name) {
  if (!env[name]) {
    throw new Error(`Missing Cloudflare binding: ${name}`);
  }
}

function requireEbaySecrets(env) {
  for (const key of ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN"]) {
    if (!env[key]) throw new Error(`Missing secret: ${key}`);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}