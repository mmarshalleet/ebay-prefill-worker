const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
  ...CORS_HEADERS
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";

const listingSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    brand: { type: "string" },
    model: { type: "string" },
    mpn: { type: "string" },
    condition: { type: "string" },
    categoryHint: { type: "string" },
    itemSpecifics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" }
        },
        required: ["name", "value"],
        additionalProperties: false
      }
    },
    descriptionBullets: {
      type: "array",
      items: { type: "string" }
    },
    confidence: { type: "number" }
  },
  required: [
    "title",
    "brand",
    "model",
    "mpn",
    "condition",
    "categoryHint",
    "itemSpecifics",
    "descriptionBullets",
    "confidence"
  ],
  additionalProperties: false
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return jsonResponse({
          status: "ok",
          service: "eBay photo-to-listing draft generator",
          publishEnabled: false,
          endpoints: [
            { method: "GET", path: "/", description: "Worker status and endpoint list" },
            { method: "POST", path: "/draft", description: "Create a draft from item photos" },
            { method: "GET", path: "/draft?id=...", description: "Retrieve a saved draft" },
            { method: "POST", path: "/approve", description: "Mark a draft as ready for later publishing" }
          ]
        });
      }

      if (url.pathname === "/draft") {
        if (request.method === "POST") {
          return await createDraft(request, env);
        }

        if (request.method === "GET") {
          return await getDraft(url, env);
        }
      }

      if (request.method === "POST" && url.pathname === "/approve") {
        return await approveDraft(request, env);
      }

      return jsonResponse({ error: "not_found" }, 404);
    } catch (error) {
      return jsonResponse({
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error"
      }, 500);
    }
  }
};

async function createDraft(request, env) {
  requireBinding(env, "DRAFT_KV");
  requireSecret(env, "OPENAI_API_KEY");
  requireSecret(env, "EBAY_CLIENT_ID");
  requireSecret(env, "EBAY_CLIENT_SECRET");

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "invalid_content_type", message: "POST /draft requires multipart/form-data." }, 415);
  }

  const formData = await request.formData();
  const imageFiles = formData.getAll("images").filter((value) => value instanceof File);

  if (imageFiles.length === 0) {
    return jsonResponse({ error: "missing_images", message: "Upload one or more files with the form key images." }, 400);
  }

  const notes = stringField(formData, "notes");
  const requestedCondition = stringField(formData, "condition");
  const quantity = positiveIntegerField(formData, "quantity", 1);
  const images = await Promise.all(imageFiles.map(fileToOpenAIImagePart));

  const identification = await identifyItemWithOpenAI(env.OPENAI_API_KEY, images, {
    notes,
    condition: requestedCondition,
    quantity
  });

  const searchQuery = buildEbaySearchQuery(identification);
  const ebayToken = await getEbayToken(env);
  const comps = await searchEbayComps(env, ebayToken, searchQuery);
  const suggestedPrice = calculateSuggestedPrice(comps);
  const draftId = crypto.randomUUID();
  const now = new Date().toISOString();
  const draft = {
    id: draftId,
    status: "draft",
    publishEnabled: false,
    createdAt: now,
    updatedAt: now,
    input: {
      notes,
      requestedCondition,
      quantity,
      imageCount: imageFiles.length
    },
    identification,
    ebaySearch: {
      marketplaceId: env.EBAY_MARKETPLACE_ID || "EBAY_US",
      query: searchQuery,
      activeFixedPriceComps: comps,
      compCount: comps.length
    },
    pricing: {
      strategy: "median_active_fixed_price_comps_x_0.95",
      suggestedPrice
    }
  };

  await env.DRAFT_KV.put(draftId, JSON.stringify(draft), {
    metadata: { status: draft.status, createdAt: now }
  });

  return jsonResponse(draft, 201);
}

async function getDraft(url, env) {
  requireBinding(env, "DRAFT_KV");

  const draftId = url.searchParams.get("id");
  if (!draftId) {
    return jsonResponse({ error: "missing_id", message: "Pass the draft id as /draft?id=..." }, 400);
  }

  const draft = await env.DRAFT_KV.get(draftId, { type: "json" });
  if (!draft) {
    return jsonResponse({ error: "draft_not_found" }, 404);
  }

  return jsonResponse(draft);
}

async function approveDraft(request, env) {
  requireBinding(env, "DRAFT_KV");

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json", message: "POST /approve requires JSON." }, 400);
  }

  const draftId = typeof body?.draftId === "string" ? body.draftId.trim() : "";
  if (!draftId) {
    return jsonResponse({ error: "missing_draft_id", message: "Expected { \"draftId\": \"...\" }." }, 400);
  }

  const draft = await env.DRAFT_KV.get(draftId, { type: "json" });
  if (!draft) {
    return jsonResponse({ error: "draft_not_found" }, 404);
  }

  const approvedDraft = {
    ...draft,
    status: "ready_to_publish_later",
    publishEnabled: false,
    updatedAt: new Date().toISOString()
  };

  await env.DRAFT_KV.put(draftId, JSON.stringify(approvedDraft), {
    metadata: { status: approvedDraft.status, createdAt: approvedDraft.createdAt }
  });

  return jsonResponse(approvedDraft);
}

async function identifyItemWithOpenAI(apiKey, imageParts, input) {
  const prompt = [
    "Identify this resale item for an eBay listing draft.",
    "Return ONLY valid JSON matching the requested schema.",
    "Use empty strings when a brand, model, or MPN cannot be determined.",
    "Use itemSpecifics as concise eBay-style name/value facts visible or strongly inferable from the photos.",
    "Keep the title under 80 characters and avoid unsupported claims.",
    `Seller notes: ${input.notes || "none"}`,
    `Seller condition hint: ${input.condition || "none"}`,
    `Quantity: ${input.quantity}`
  ].join("\n");

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.3",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            ...imageParts
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ebay_listing_identification",
          strict: true,
          schema: listingSchema
        }
      }
    })
  });

  const payload = await parseJsonResponse(response, "OpenAI");
  const text = extractOpenAIText(payload);
  const parsed = safeJsonParse(text);

  return normalizeIdentification(parsed);
}

async function getEbayToken(env) {
  const credentials = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: EBAY_SCOPE
  });

  const response = await fetch(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload = await parseJsonResponse(response, "eBay OAuth");
  if (!payload.access_token) {
    throw new Error("eBay OAuth did not return an access token.");
  }

  return payload.access_token;
}

async function searchEbayComps(env, token, query) {
  if (!query) {
    return [];
  }

  const url = new URL(EBAY_BROWSE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");

  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE_ID || "EBAY_US"
    }
  });

  const payload = await parseJsonResponse(response, "eBay Browse");
  const summaries = Array.isArray(payload.itemSummaries) ? payload.itemSummaries : [];

  return summaries
    .map((item) => ({
      title: item.title || "",
      itemWebUrl: item.itemWebUrl || "",
      itemId: item.itemId || "",
      condition: item.condition || "",
      price: priceFromEbayValue(item.price),
      currency: item.price?.currency || "",
      sellerUsername: item.seller?.username || "",
      imageUrl: item.image?.imageUrl || ""
    }))
    .filter((item) => typeof item.price === "number" && Number.isFinite(item.price));
}

function calculateSuggestedPrice(comps) {
  const prices = comps
    .map((item) => item.price)
    .filter((price) => typeof price === "number" && Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  if (prices.length === 0) {
    return null;
  }

  const middle = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0
    ? (prices[middle - 1] + prices[middle]) / 2
    : prices[middle];

  return roundCurrency(median * 0.95);
}

function buildEbaySearchQuery(identification) {
  const parts = [
    identification.brand,
    identification.model,
    identification.mpn,
    identification.title
  ];

  const seen = new Set();
  return parts
    .flatMap((part) => String(part || "").split(/\s+/))
    .map((part) => part.replace(/[^\w.-]/g, "").trim())
    .filter(Boolean)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 12)
    .join(" ");
}

async function fileToOpenAIImagePart(file) {
  const mimeType = file.type || "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported upload type for ${file.name || "image"}: ${mimeType}`);
  }

  const bytes = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(bytes);

  return {
    type: "input_image",
    image_url: `data:${mimeType};base64,${base64}`,
    detail: "high"
  };
}

function extractOpenAIText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (typeof part.text === "string" && part.text.trim()) {
        return part.text;
      }
    }
  }

  throw new Error("OpenAI response did not contain text output.");
}

function safeJsonParse(text) {
  const trimmed = String(text || "").trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch (error) {
    throw new Error(`OpenAI returned invalid JSON: ${error.message}`);
  }
}

async function parseJsonResponse(response, serviceName) {
  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message = payload.error?.message || payload.error_description || payload.message || `${serviceName} request failed.`;
    throw new Error(`${serviceName} error (${response.status}): ${message}`);
  }

  return payload;
}

function normalizeIdentification(value) {
  if (!value || typeof value !== "object") {
    throw new Error("OpenAI JSON was not an object.");
  }

  return {
    title: stringValue(value.title),
    brand: stringValue(value.brand),
    model: stringValue(value.model),
    mpn: stringValue(value.mpn),
    condition: stringValue(value.condition),
    categoryHint: stringValue(value.categoryHint),
    itemSpecifics: Array.isArray(value.itemSpecifics)
      ? value.itemSpecifics.map((specific) => ({
        name: stringValue(specific?.name),
        value: stringValue(specific?.value)
      })).filter((specific) => specific.name || specific.value)
      : [],
    descriptionBullets: Array.isArray(value.descriptionBullets)
      ? value.descriptionBullets.map(stringValue).filter(Boolean)
      : [],
    confidence: clampNumber(value.confidence, 0, 1)
  };
}

function stringField(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function positiveIntegerField(formData, key, fallback) {
  const value = Number.parseInt(stringField(formData, key), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
}

function priceFromEbayValue(price) {
  const value = Number(price?.value);
  return Number.isFinite(value) ? value : null;
}

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function requireSecret(env, key) {
  if (!env[key]) {
    throw new Error(`Missing required secret: ${key}`);
  }
}

function requireBinding(env, key) {
  if (!env[key]) {
    throw new Error(`Missing required binding: ${key}`);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
