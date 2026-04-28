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
const EBAY_TAXONOMY_TREE_URL = "https://api.ebay.com/commerce/taxonomy/v1/category_tree/0";
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

class ExternalApiError extends Error {
  constructor(service, status, payload) {
    const message = payload?.error?.message
      || payload?.error_description
      || payload?.message
      || `${service} request failed.`;
    super(`${service} error (${status}): ${message}`);
    this.name = "ExternalApiError";
    this.service = service;
    this.status = status;
    this.payload = payload;
  }
}

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
            { method: "POST", path: "/approve", description: "Validate overrides and mark a draft ready for later publishing" }
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
      if (error instanceof ExternalApiError) {
        return jsonResponse({
          error: "external_api_error",
          service: error.service,
          status: error.status,
          message: error.message,
          raw: error.payload
        }, 502);
      }

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
    title: identification.title,
    brand: identification.brand,
    model: identification.model,
    mpn: identification.mpn,
    condition: identification.condition,
    categoryHint: identification.categoryHint,
    itemSpecifics: normalizeItemSpecifics(identification.itemSpecifics),
    descriptionBullets: identification.descriptionBullets,
    imageUrls: [],
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

  return await validateCategoryAndAspects({
    draft,
    token: ebayToken,
    env,
    saveDraft: true,
    successStatus: "draft",
    successHttpStatus: 201
  });
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
  requireSecret(env, "EBAY_CLIENT_ID");
  requireSecret(env, "EBAY_CLIENT_SECRET");

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

  const manualSpecifics = normalizeItemSpecifics(body?.itemSpecifics);
  const updatedDraft = {
    ...draft,
    itemSpecifics: mergeItemSpecifics(draft.itemSpecifics || draft.identification?.itemSpecifics || [], manualSpecifics),
    updatedAt: new Date().toISOString()
  };

  if (typeof body?.categoryId === "string" && body.categoryId.trim()) {
    updatedDraft.categoryId = body.categoryId.trim();
    updatedDraft.categorySelectionSource = "manual_override";
    if (draft.categoryId !== updatedDraft.categoryId) {
      updatedDraft.categoryName = "";
      updatedDraft.categoryTreeNodeAncestors = [];
      updatedDraft.categoryConfidence = null;
    }
  }

  const ebayToken = await getEbayToken(env);
  return await validateCategoryAndAspects({
    draft: updatedDraft,
    token: ebayToken,
    env,
    saveDraft: true,
    successStatus: "ready_to_publish_later",
    successHttpStatus: 200
  });
}

async function validateCategoryAndAspects({ draft, token, env, saveDraft, successStatus, successHttpStatus }) {
  const categoryQuery = buildCategoryQuery(draft);
  let categoryId = draft.categoryId || "";

  if (!categoryId) {
    const categorySuggestion = await getCategorySuggestion(categoryQuery, token, env);
    if (!categorySuggestion) {
      const missingCategoryDraft = {
        ...draft,
        status: "category_required",
        categoryQuery,
        updatedAt: new Date().toISOString()
      };

      if (saveDraft) {
        await saveDraftToKv(env, missingCategoryDraft);
      }

      return jsonResponse({
        error: "category_required",
        message: "No eBay category could be determined.",
        query: categoryQuery,
        draft: missingCategoryDraft
      }, 422);
    }

    draft = {
      ...draft,
      categoryId: categorySuggestion.categoryId,
      categoryName: categorySuggestion.categoryName,
      categoryTreeNodeAncestors: categorySuggestion.categoryTreeNodeAncestors,
      categoryConfidence: categorySuggestion.categoryConfidence,
      categorySelectionSource: "ebay_taxonomy_suggestion",
      categoryQuery
    };
    categoryId = categorySuggestion.categoryId;
  }

  const aspectMetadata = await getCategoryAspects(categoryId, token, env);
  const aspectResult = buildAspectsForEbay(draft, aspectMetadata);
  const validatedDraft = {
    ...draft,
    status: aspectResult.missingRequiredAspects.length > 0
      ? "missing_required_item_specifics"
      : successStatus,
    requiredAspects: aspectResult.requiredAspects,
    recommendedAspects: aspectResult.recommendedAspects,
    missingRequiredAspects: aspectResult.missingRequiredAspects,
    itemSpecifics: aspectResult.itemSpecifics,
    ebayAspects: aspectResult.aspects,
    ebayInventoryItemDraft: aspectResult.missingRequiredAspects.length > 0
      ? null
      : buildEbayInventoryItemDraft(draft, aspectResult.aspects),
    publishEnabled: false,
    updatedAt: new Date().toISOString()
  };

  if (saveDraft) {
    await saveDraftToKv(env, validatedDraft);
  }

  if (aspectResult.missingRequiredAspects.length > 0) {
    return jsonResponse({
      error: "missing_required_item_specifics",
      categoryId: validatedDraft.categoryId,
      categoryName: validatedDraft.categoryName,
      missingRequiredAspects: aspectResult.missingRequiredAspects,
      requiredAspects: aspectResult.requiredAspects,
      recommendedAspects: aspectResult.recommendedAspects,
      draft: validatedDraft
    }, 422);
  }

  return jsonResponse(validatedDraft, successHttpStatus);
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
    headers: getEbayHeaders(token, env)
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

async function getCategorySuggestion(query, token, env) {
  if (!query) {
    return null;
  }

  const url = new URL(`${EBAY_TAXONOMY_TREE_URL}/get_category_suggestions`);
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: getEbayHeaders(token, env)
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await parseJsonResponse(response, "eBay Taxonomy category suggestions");
  const suggestions = Array.isArray(payload.categorySuggestions) ? payload.categorySuggestions : [];
  const suggestion = suggestions[0];

  if (!suggestion?.category?.categoryId) {
    return null;
  }

  return {
    categoryId: String(suggestion.category.categoryId),
    categoryName: suggestion.category.categoryName || "",
    categoryTreeNodeAncestors: Array.isArray(suggestion.categoryTreeNodeAncestors)
      ? suggestion.categoryTreeNodeAncestors
      : [],
    categoryConfidence: suggestion.categoryConfidence ?? suggestion.relevancy ?? null
  };
}

async function getCategoryAspects(categoryId, token, env) {
  const url = new URL(`${EBAY_TAXONOMY_TREE_URL}/get_item_aspects_for_category`);
  url.searchParams.set("category_id", categoryId);

  const response = await fetch(url, {
    headers: getEbayHeaders(token, env)
  });

  const payload = await parseJsonResponse(response, "eBay Taxonomy category aspects");
  return Array.isArray(payload.aspects) ? payload.aspects : [];
}

function buildAspectsForEbay(draft, aspectMetadata) {
  const requiredAspects = [];
  const recommendedAspects = [];
  const exactAspectNames = new Map();

  for (const aspect of aspectMetadata) {
    const name = stringValue(aspect.localizedAspectName);
    if (!name) {
      continue;
    }

    exactAspectNames.set(aspectKey(name), name);
    const summary = summarizeAspect(aspect);

    if (isRequiredAspect(aspect)) {
      requiredAspects.push(summary);
    } else if (isRecommendedAspect(aspect)) {
      recommendedAspects.push(summary);
    }
  }

  const merged = {};
  const addAspect = (name, value, overwrite = true) => {
    const values = normalizeAspectValues(value);
    if (values.length === 0) {
      return;
    }

    const normalized = normalizeAspectName(name);
    const exactName = exactAspectNames.get(aspectKey(normalized)) || normalized;
    if (!exactName) {
      return;
    }

    if (!overwrite && merged[exactName]?.length > 0) {
      return;
    }

    merged[exactName] = values;
  };

  for (const specific of normalizeItemSpecifics(draft.itemSpecifics || draft.identification?.itemSpecifics || [])) {
    addAspect(specific.name, specific.value);
  }

  addAspect("Brand", draft.brand || draft.identification?.brand, false);
  addAspect("MPN", draft.mpn || draft.identification?.mpn, false);
  addAspect("Model", draft.model || draft.identification?.model, false);

  if (exactAspectNames.has(aspectKey("Condition"))) {
    addAspect("Condition", draft.condition || draft.identification?.condition, false);
  }

  const aspects = formatAspectsForEbay(merged);
  const missingRequiredAspects = getMissingRequiredAspects(requiredAspects, aspects);

  return {
    aspects,
    itemSpecifics: itemSpecificsFromAspects(aspects),
    requiredAspects,
    recommendedAspects,
    missingRequiredAspects
  };
}

function normalizeAspectName(name) {
  const cleaned = stringValue(name).replace(/\s+/g, " ");
  const compact = cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (compact === "brand") {
    return "Brand";
  }

  if (compact === "mpn" || compact === "mfrpartnumber" || compact === "manufacturerpartnumber") {
    return "MPN";
  }

  if (compact === "model") {
    return "Model";
  }

  return cleaned;
}

function formatAspectsForEbay(aspects) {
  const formatted = {};

  for (const [name, value] of Object.entries(aspects || {})) {
    const normalizedName = stringValue(name).replace(/\s+/g, " ");
    const values = normalizeAspectValues(value);
    if (normalizedName && values.length > 0) {
      formatted[normalizedName] = values;
    }
  }

  return formatted;
}

function getMissingRequiredAspects(requiredAspects, mergedAspects) {
  const mergedByKey = new Map(
    Object.entries(mergedAspects || {}).map(([name, values]) => [aspectKey(name), normalizeAspectValues(values)])
  );

  return requiredAspects
    .filter((aspect) => {
      const values = mergedByKey.get(aspectKey(aspect.name));
      return !values || values.length === 0;
    })
    .map((aspect) => aspect.name);
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
  return dedupeWords([
    identification.brand,
    identification.model,
    identification.mpn,
    identification.title
  ], 12);
}

function buildCategoryQuery(draft) {
  return dedupeWords([
    draft.title || draft.identification?.title,
    draft.brand || draft.identification?.brand,
    draft.model || draft.identification?.model,
    draft.mpn || draft.identification?.mpn,
    draft.categoryHint || draft.identification?.categoryHint
  ], 16);
}

function buildEbayInventoryItemDraft(draft, aspects) {
  return {
    product: {
      title: draft.title || draft.identification?.title || "",
      description: buildDescription(draft),
      brand: draft.brand || draft.identification?.brand || "",
      mpn: draft.mpn || draft.identification?.mpn || "",
      aspects: formatAspectsForEbay(aspects),
      imageUrls: Array.isArray(draft.imageUrls)
        ? draft.imageUrls.map(stringValue).filter(Boolean)
        : []
    }
  };
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
    throw new ExternalApiError(serviceName, response.status, payload);
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
    itemSpecifics: normalizeItemSpecifics(value.itemSpecifics),
    descriptionBullets: Array.isArray(value.descriptionBullets)
      ? value.descriptionBullets.map(stringValue).filter(Boolean)
      : [],
    confidence: clampNumber(value.confidence, 0, 1)
  };
}

function normalizeItemSpecifics(value) {
  if (Array.isArray(value)) {
    return value
      .map((specific) => ({
        name: normalizeAspectName(specific?.name),
        value: normalizeAspectValues(specific?.value).join(", ")
      }))
      .filter((specific) => specific.name && specific.value);
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([name, itemValue]) => ({
        name: normalizeAspectName(name),
        value: normalizeAspectValues(itemValue).join(", ")
      }))
      .filter((specific) => specific.name && specific.value);
  }

  return [];
}

function mergeItemSpecifics(baseSpecifics, overrideSpecifics) {
  const merged = new Map();

  for (const specific of normalizeItemSpecifics(baseSpecifics)) {
    merged.set(aspectKey(specific.name), specific);
  }

  for (const specific of normalizeItemSpecifics(overrideSpecifics)) {
    merged.set(aspectKey(specific.name), specific);
  }

  return Array.from(merged.values());
}

function itemSpecificsFromAspects(aspects) {
  return Object.entries(aspects || {}).map(([name, values]) => ({
    name,
    value: normalizeAspectValues(values).join(", ")
  }));
}

function summarizeAspect(aspect) {
  const constraint = aspect.aspectConstraint || {};
  const values = Array.isArray(aspect.aspectValues) ? aspect.aspectValues : [];

  return {
    name: stringValue(aspect.localizedAspectName),
    required: isRequiredAspect(aspect),
    usage: constraint.aspectUsage || "",
    cardinality: constraint.itemToAspectCardinality || "",
    mode: constraint.aspectMode || "",
    dataType: constraint.aspectDataType || "",
    expectedRequiredByDate: constraint.expectedRequiredByDate || "",
    allowedValueCount: values.length,
    allowedValuesSample: values
      .map((value) => stringValue(value.localizedValue))
      .filter(Boolean)
      .slice(0, 25)
  };
}

function isRequiredAspect(aspect) {
  const constraint = aspect.aspectConstraint || {};
  const usage = String(constraint.aspectUsage || "").toUpperCase();
  const cardinality = String(constraint.itemToAspectCardinality || "").toUpperCase();

  return constraint.aspectRequired === true
    || usage === "REQUIRED"
    || cardinality.includes("REQUIRED");
}

function isRecommendedAspect(aspect) {
  const constraint = aspect.aspectConstraint || {};
  return String(constraint.aspectUsage || "").toUpperCase() === "RECOMMENDED"
    || Boolean(constraint.expectedRequiredByDate);
}

function normalizeAspectValues(value) {
  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) => typeof item === "string" ? item.split(",") : [item])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function aspectKey(name) {
  return normalizeAspectName(name).toLowerCase();
}

function dedupeWords(parts, limit) {
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
    .slice(0, limit)
    .join(" ");
}

function buildDescription(draft) {
  const bullets = Array.isArray(draft.descriptionBullets)
    ? draft.descriptionBullets
    : draft.identification?.descriptionBullets || [];

  return bullets
    .map((bullet) => `- ${stringValue(bullet)}`)
    .filter((bullet) => bullet.length > 2)
    .join("\n");
}

async function saveDraftToKv(env, draft) {
  await env.DRAFT_KV.put(draft.id, JSON.stringify(draft), {
    metadata: { status: draft.status, createdAt: draft.createdAt }
  });
}

function getEbayHeaders(token, env) {
  return {
    "Authorization": `Bearer ${token}`,
    "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE_ID || "EBAY_US"
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
