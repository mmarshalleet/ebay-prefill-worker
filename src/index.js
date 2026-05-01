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

const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_TAXONOMY_TREE_URL = "https://api.ebay.com/commerce/taxonomy/v1/category_tree/0";
const EBAY_INVENTORY_URL = "https://api.ebay.com/sell/inventory/v1";
const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";
const EBAY_SELL_SCOPE = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account"
].join(" ");

const KNOWN_BRANDS = [
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
  "Marel",
  "Ishida",
  "Secomea"
];

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
          publishEnabled: true,
          endpoints: [
            { method: "GET", path: "/", description: "Worker status and endpoint list" },
            { method: "POST", path: "/draft", description: "Create a draft from item photos" },
            { method: "GET", path: "/draft?id=...", description: "Retrieve a saved draft" },
            { method: "POST", path: "/approve", description: "Validate overrides and create an unpublished eBay offer" },
            { method: "POST", path: "/publish", description: "Publish an existing eBay offer" },
            { method: "POST", path: "/instant-list", description: "Approve and publish only when the draft is eligible" }
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

      if (request.method === "POST" && url.pathname === "/publish") {
        return await publishDraft(request, env);
      }

      if (request.method === "POST" && url.pathname === "/instant-list") {
        return await instantListDraft(request, env);
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

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "invalid_content_type", message: "POST /draft requires multipart/form-data." }, 415);
  }

  const formData = await request.formData();
  const imageFiles = formData.getAll("images").filter((value) => value instanceof File);
  const notes = stringField(formData, "notes");
  const userCondition = stringField(formData, "condition");
  const ocrText = stringField(formData, "ocrText") || "";
  const quantity = positiveIntegerField(formData, "quantity", 1);
  const userPriceMode = parseUserPriceMode(stringField(formData, "priceMode"));
  const cost = optionalNumberField(formData, "cost");
  const desiredMarginPercent = optionalNumberField(formData, "desiredMarginPercent");
  const draftId = crypto.randomUUID();
  const now = new Date().toISOString();
  const imageHostResult = imageFiles.length > 0
    ? await hostUploadedImages({ imageFiles, draftId, env })
    : { imageUrls: [], hostedImages: [], imageHostWarnings: [] };
  const partNumbers = extractPartNumbers(`${ocrText}\n${notes}`);
  const debug = buildDraftDebug({
    ocrText,
    extractedPartNumbers: partNumbers.candidates,
    searchQueryUsed: hasStrongExtractedIdentifier(partNumbers)
      ? buildInitialSearchQuery({ partNumbers, ocrText })
      : "",
    imageCount: imageFiles.length
  });

  if (!hasStrongExtractedIdentifier(partNumbers)) {
    const reviewDraft = buildWeakOcrReviewDraft({
      draftId,
      now,
      notes,
      userCondition,
      ocrText,
      quantity,
      userPriceMode,
      cost,
      desiredMarginPercent,
      imageFiles,
      imageHostResult,
      partNumbers,
      debug,
      env
    });
    await saveDraftToKv(env, reviewDraft);
    return jsonResponse(reviewDraft, 201);
  }

  const ebayToken = await getEbayToken(env);
  let identification = await identifyItemFromOcrAndEbay({
    ocrText,
    notes,
    userCondition,
    token: ebayToken,
    env,
    partNumbers
  });
  const conditionDecision = determineCondition({
    aiCondition: "",
    userCondition,
    ocrText,
    notes,
    title: identification.title
  });
  identification = {
    ...identification,
    condition: conditionDecision.condition
  };
  const priceModeDecision = determinePriceMode({
    userPriceMode,
    condition: conditionDecision.condition,
    brand: identification.brand,
    mpn: identification.mpn,
    ocrText,
    notes,
    aiConfidence: identification.confidence
  });
  const brandStrategy = getBrandStrategy(identification.brand);

  const pricingInputs = {
    priceMode: priceModeDecision.priceMode,
    cost,
    desiredMarginPercent,
    ocrText
  };
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
    condition: conditionDecision.condition,
    conditionSource: conditionDecision.source,
    conditionSignals: conditionDecision.signals,
    categoryHint: identification.categoryHint,
    ocrText,
    extractedPartNumbers: identification.extractedPartNumbers,
    itemSpecifics: normalizeItemSpecifics(identification.itemSpecifics),
    descriptionBullets: identification.descriptionBullets,
    imageUrls: imageHostResult.imageUrls,
    hostedImages: imageHostResult.hostedImages,
    imageHostWarnings: imageHostResult.imageHostWarnings,
    input: {
      notes,
      requestedCondition: userCondition,
      ocrText,
      quantity,
      priceMode: userPriceMode,
      cost,
      desiredMarginPercent,
      imageCount: imageFiles.length,
      hostedImageCount: imageHostResult.imageUrls.length
    },
    priceMode: priceModeDecision.priceMode,
    priceModeSource: priceModeDecision.source,
    priceModeSignals: priceModeDecision.signals,
    brandStrategy,
    pricingInputs,
    price: null,
    suggestedPrice: null,
    identification,
    ocrTextPreview: buildOcrTextPreview(ocrText),
    debug,
    ebaySearch: {
      marketplaceId: env.EBAY_MARKETPLACE_ID || "EBAY_US",
      query: "",
      queries: [],
      activeFixedPriceComps: [],
      compCount: 0
    }
  };

  return await validateCategoryAndAspects({
    draft,
    token: ebayToken,
    env,
    saveDraft: true,
    successStatus: "draft",
    successHttpStatus: 201,
    returnDraftOnMissingCategory: true,
    returnDraftOnMissingAspects: true,
    enrichDraft: async (validatedDraft) => addPricingToDraft(validatedDraft, {
      env,
      token: ebayToken,
      priceMode: priceModeDecision.priceMode,
      cost,
      desiredMarginPercent
    })
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
  requireSecret(env, "EBAY_REFRESH_TOKEN");

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
    successHttpStatus: 200,
    afterValidDraft: async (validatedDraft) => createEbayOfferDraftOnly(validatedDraft, env)
  });
}

async function identifyItemFromOcrAndEbay({ ocrText, notes, userCondition, token, env, partNumbers }) {
  partNumbers = partNumbers || extractPartNumbers(`${ocrText}\n${notes}`);
  const brand = inferBrand({ ocrText, notes, mpn: partNumbers.mpn });
  const condition = determineCondition({
    aiCondition: "",
    userCondition,
    ocrText,
    notes,
    title: ""
  }).condition;
  const searchQuery = buildInitialSearchQuery({ partNumbers, ocrText });
  const draftForSearch = {
    title: searchQuery,
    brand,
    model: partNumbers.model,
    mpn: partNumbers.mpn,
    condition,
    ocrText,
    extractedPartNumbers: partNumbers.candidates,
    itemSpecifics: buildHeuristicItemSpecifics({ brand, mpn: partNumbers.mpn, model: partNumbers.model })
  };
  let firstEbayResult = null;

  try {
    const comps = await searchEbayComps(env, token, searchQuery, draftForSearch);
    firstEbayResult = comps.find((comp) => canUseEbayCompTitle(comp, partNumbers)) || null;
  } catch {
    firstEbayResult = null;
  }

  const title = buildTitle({
    brand,
    mpn: partNumbers.mpn,
    model: partNumbers.model,
    categoryName: "Industrial Part",
    condition,
    fallbackTitle: firstEbayResult?.title
  });

  return {
    title,
    brand,
    model: partNumbers.model,
    mpn: partNumbers.mpn,
    condition,
    categoryHint: "Industrial automation part",
    itemSpecifics: buildHeuristicItemSpecifics({ brand, mpn: partNumbers.mpn, model: partNumbers.model }),
    descriptionBullets: buildHeuristicDescriptionBullets({ brand, mpn: partNumbers.mpn, model: partNumbers.model, condition }),
    confidence: partNumbers.mpn || firstEbayResult ? 0.65 : 0.15,
    extractedPartNumbers: partNumbers.candidates,
    searchQuery,
    ebayTitleFallback: firstEbayResult?.title || ""
  };
}

function buildWeakOcrReviewDraft({
  draftId,
  now,
  notes,
  userCondition,
  ocrText,
  quantity,
  userPriceMode,
  cost,
  desiredMarginPercent,
  imageFiles,
  imageHostResult,
  partNumbers,
  debug,
  env
}) {
  const conditionDecision = determineCondition({
    aiCondition: "",
    userCondition,
    ocrText,
    notes,
    title: ""
  });
  const priceMode = parseUserPriceMode(userPriceMode) || "market";
  const pricing = buildReviewRequiredPricing(priceMode);
  const identification = {
    title: "Review Needed - Unknown Industrial Part",
    brand: "",
    model: "",
    mpn: "",
    condition: conditionDecision.condition,
    categoryHint: "",
    itemSpecifics: [],
    descriptionBullets: ["OCR did not provide a strong MPN or model. Manual review is required."],
    confidence: 0,
    extractedPartNumbers: partNumbers.candidates,
    searchQuery: "",
    ebayTitleFallback: ""
  };
  const draft = {
    id: draftId,
    status: "needs_ocr_or_manual_review",
    publishEnabled: false,
    createdAt: now,
    updatedAt: now,
    title: identification.title,
    brand: "",
    model: "",
    mpn: "",
    condition: conditionDecision.condition,
    conditionSource: conditionDecision.source,
    conditionSignals: conditionDecision.signals,
    categoryHint: "",
    categoryId: null,
    categoryName: "",
    categorySelectionSource: "not_checked_weak_ocr",
    ocrText,
    ocrTextPreview: buildOcrTextPreview(ocrText),
    extractedPartNumbers: partNumbers.candidates,
    itemSpecifics: [],
    descriptionBullets: identification.descriptionBullets,
    imageUrls: imageHostResult.imageUrls,
    hostedImages: imageHostResult.hostedImages,
    imageHostWarnings: imageHostResult.imageHostWarnings,
    input: {
      notes,
      requestedCondition: userCondition,
      ocrText,
      quantity,
      priceMode: userPriceMode,
      cost,
      desiredMarginPercent,
      imageCount: imageFiles.length,
      hostedImageCount: imageHostResult.imageUrls.length
    },
    priceMode,
    priceModeSource: parseUserPriceMode(userPriceMode) ? "user_override" : "weak_ocr_fallback",
    priceModeSignals: ["No strong MPN/model was extracted from OCR; pricing was not attempted."],
    brandStrategy: getBrandStrategy(""),
    pricingInputs: {
      priceMode,
      cost,
      desiredMarginPercent,
      ocrText
    },
    price: null,
    suggestedPrice: null,
    priceConfidence: 0,
    pricing,
    identification,
    debug,
    ebaySearch: {
      marketplaceId: env.EBAY_MARKETPLACE_ID || "EBAY_US",
      query: "",
      queries: [],
      activeFixedPriceComps: [],
      compCount: 0
    }
  };

  return {
    ...draft,
    autoPublishEligibility: evaluateAutoPublishEligibility(draft)
  };
}

function buildReviewRequiredPricing(priceMode) {
  return {
    mode: parsePriceMode(priceMode),
    suggestedPrice: null,
    lowPrice: null,
    medianPrice: null,
    highPrice: null,
    activeMedian: null,
    soldMedian: null,
    priceConfidence: 0,
    pricingReason: "No strong MPN/model was extracted from OCR.",
    pricingWarnings: ["OCR/manual review required before comp pricing."],
    compCount: 0,
    exactCompCount: 0,
    activeCompCount: 0,
    soldCompCount: 0,
    scarcityAdjustment: 0,
    brandStrategy: getBrandStrategy(""),
    conditionMultiplier: getConditionMultiplier("New Open Box"),
    minimumMarginPrice: null,
    acceptedComps: [],
    rejectedComps: []
  };
}

function canUseEbayCompTitle(comp, partNumbers) {
  const matchScore = Number(comp?.matchScore);
  const normalizedScore = Number.isFinite(matchScore) && matchScore > 1
    ? matchScore / 100
    : matchScore;
  const exactMpn = stringValue(partNumbers?.mpn);

  return normalizedScore >= 0.7
    || (hasStrongMpn(exactMpn) && includesIdentifier(comp?.title || "", exactMpn));
}

function hasStrongExtractedIdentifier(partNumbers) {
  return hasStrongMpn(partNumbers?.mpn)
    || hasStrongMpn(partNumbers?.model)
    || (Array.isArray(partNumbers?.candidates) && partNumbers.candidates.some(hasStrongMpn));
}

function buildDraftDebug({ ocrText, extractedPartNumbers, searchQueryUsed, imageCount }) {
  return {
    receivedOcrText: ocrText,
    extractedPartNumbers: Array.isArray(extractedPartNumbers) ? extractedPartNumbers : [],
    searchQueryUsed,
    imageCount
  };
}

function buildOcrTextPreview(ocrText) {
  return truncateText(stringValue(ocrText).replace(/\s+/g, " "), 500);
}

function buildInitialSearchQuery({ partNumbers, ocrText }) {
  return firstNonEmpty([
    partNumbers.mpn,
    partNumbers.model,
    cleanOcrSearchText(ocrText),
    "industrial automation part"
  ]);
}

function cleanOcrSearchText(ocrText) {
  const cleaned = stringValue(ocrText)
    .replace(/[^\w./\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return dedupeWords([cleaned], 12);
}

function inferBrand({ ocrText, notes, mpn }) {
  const text = joinSignalText([ocrText, notes]);
  const knownBrand = KNOWN_BRANDS.find((brand) => text.includes(brand.toLowerCase()));
  if (knownBrand) {
    return knownBrand;
  }

  const prefix = stringValue(mpn).split(/[-\s]/)[0] || "";
  if (/^[a-z]{2,}/i.test(prefix)) {
    return prefix.toUpperCase();
  }

  return "";
}

function buildTitle({ brand, mpn, model, categoryName, condition, fallbackTitle }) {
  const hasIdentifier = Boolean(firstNonEmpty([brand, mpn, model]));
  const generated = dedupeWords([
    brand,
    mpn,
    !mpn || model !== mpn ? model : "",
    categoryName,
    condition
  ], 14);

  return truncateText(firstNonEmpty([
    hasIdentifier ? generated : "",
    fallbackTitle,
    generated,
    "Unknown Industrial Part"
  ]), 80);
}

function buildHeuristicItemSpecifics({ brand, mpn, model }) {
  return normalizeItemSpecifics({
    Brand: brand,
    MPN: mpn,
    Model: model
  });
}

function buildHeuristicDescriptionBullets({ brand, mpn, model, condition }) {
  return uniqueNonEmpty([
    brand ? `Brand: ${brand}` : "",
    mpn ? `MPN: ${mpn}` : "",
    model ? `Model: ${model}` : "",
    condition ? `Condition: ${condition}` : ""
  ]);
}

async function publishDraft(request, env) {
  requireBinding(env, "DRAFT_KV");
  requireSecret(env, "EBAY_CLIENT_ID");
  requireSecret(env, "EBAY_CLIENT_SECRET");
  requireSecret(env, "EBAY_REFRESH_TOKEN");

  const body = await parseJsonRequest(request, "POST /publish requires JSON.");
  if (body.errorResponse) {
    return body.errorResponse;
  }

  const draftId = stringValue(body.draftId);
  if (!draftId) {
    return jsonResponse({ error: "missing_draft_id", message: "Expected { \"draftId\": \"...\" }." }, 400);
  }

  const draft = await env.DRAFT_KV.get(draftId, { type: "json" });
  if (!draft) {
    return jsonResponse({ error: "draft_not_found" }, 404);
  }

  if (!draft.ebayOffer?.offerId) {
    return jsonResponse({
      error: "offer_required",
      message: "Approve the draft before publishing so an eBay offer exists."
    }, 409);
  }

  const publishedDraft = await publishExistingEbayOffer(draft, env);
  await saveDraftToKv(env, publishedDraft);
  return jsonResponse(publishedDraft);
}

async function instantListDraft(request, env) {
  requireBinding(env, "DRAFT_KV");
  requireSecret(env, "EBAY_CLIENT_ID");
  requireSecret(env, "EBAY_CLIENT_SECRET");
  requireSecret(env, "EBAY_REFRESH_TOKEN");

  const body = await parseJsonRequest(request, "POST /instant-list requires JSON.");
  if (body.errorResponse) {
    return body.errorResponse;
  }

  const draftId = stringValue(body.draftId);
  if (!draftId) {
    return jsonResponse({ error: "missing_draft_id", message: "Expected { \"draftId\": \"...\" }." }, 400);
  }

  const draft = await env.DRAFT_KV.get(draftId, { type: "json" });
  if (!draft) {
    return jsonResponse({ error: "draft_not_found" }, 404);
  }

  const eligibility = evaluateAutoPublishEligibility(draft);
  if (!eligibility.eligible) {
    const blockedDraft = {
      ...draft,
      autoPublishEligibility: eligibility,
      updatedAt: new Date().toISOString()
    };
    await saveDraftToKv(env, blockedDraft);
    return jsonResponse({
      error: "instant_list_not_eligible",
      message: "Draft is not eligible for instant listing.",
      reasons: eligibility.reasons,
      draft: blockedDraft
    }, 409);
  }

  const offerDraft = await createEbayOfferDraftOnly({
    ...draft,
    autoPublishEligibility: eligibility
  }, env);
  const publishedDraft = await publishExistingEbayOffer(offerDraft, env);
  await saveDraftToKv(env, publishedDraft);
  return jsonResponse(publishedDraft);
}

async function validateCategoryAndAspects({
  draft,
  token,
  env,
  saveDraft,
  successStatus,
  successHttpStatus,
  returnDraftOnMissingCategory = false,
  returnDraftOnMissingAspects = false,
  enrichDraft,
  afterValidDraft
}) {
  const categoryQuery = buildCategoryQuery(draft);
  let categoryId = draft.categoryId || "";

  if (!categoryId) {
    const categorySuggestion = await getCategorySuggestion(categoryQuery, token, env);
    if (!categorySuggestion) {
      let missingCategoryDraft = {
        ...draft,
        status: "category_required",
        categoryQuery,
        updatedAt: new Date().toISOString()
      };

      if (typeof enrichDraft === "function") {
        missingCategoryDraft = await enrichDraft(missingCategoryDraft);
      }

      if (saveDraft) {
        await saveDraftToKv(env, missingCategoryDraft);
      }

      if (returnDraftOnMissingCategory) {
        return jsonResponse(missingCategoryDraft, successHttpStatus);
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
  let validatedDraft = {
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

  if (typeof enrichDraft === "function") {
    validatedDraft = await enrichDraft(validatedDraft);
  }

  if (aspectResult.missingRequiredAspects.length === 0 && typeof afterValidDraft === "function") {
    validatedDraft = await afterValidDraft(validatedDraft);
  }

  if (saveDraft) {
    await saveDraftToKv(env, validatedDraft);
  }

  if (aspectResult.missingRequiredAspects.length > 0 && !returnDraftOnMissingAspects) {
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

async function hostUploadedImages({ imageFiles, draftId, env }) {
  requireBinding(env, "IMAGES");

  const imageUrls = [];
  const hostedImages = [];
  const imageHostWarnings = [];
  const publicBaseUrl = getR2PublicBaseUrl(env);

  for (const [index, file] of imageFiles.entries()) {
    const mimeType = file.type || "application/octet-stream";
    if (!mimeType.startsWith("image/")) {
      imageHostWarnings.push(`Skipped non-image upload ${file.name || index + 1}.`);
      continue;
    }

    const filename = generateImageFilename();
    const key = `ebay-images/${filename}`;
    await env.IMAGES.put(key, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: mimeType,
        cacheControl: "public, max-age=31536000, immutable"
      },
      customMetadata: {
        draftId,
        originalName: truncateText(file.name || "", 200)
      }
    });

    const url = `${publicBaseUrl}/${key}`;
    imageUrls.push(url);
    hostedImages.push({
      key,
      filename,
      url,
      contentType: mimeType,
      originalName: file.name || "",
      size: file.size || null
    });
  }

  return { imageUrls, hostedImages, imageHostWarnings };
}

async function getEbayToken(env) {
  requireSecret(env, "EBAY_CLIENT_ID");
  requireSecret(env, "EBAY_CLIENT_SECRET");

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

async function getEbayUserToken(env) {
  requireSecret(env, "EBAY_CLIENT_ID");
  requireSecret(env, "EBAY_CLIENT_SECRET");
  requireSecret(env, "EBAY_REFRESH_TOKEN");

  const credentials = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.EBAY_REFRESH_TOKEN,
    scope: EBAY_SELL_SCOPE
  });

  const response = await fetch(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload = await parseJsonResponse(response, "eBay user OAuth");
  if (!payload.access_token) {
    throw new Error("eBay user OAuth did not return an access token.");
  }

  return payload.access_token;
}

async function createEbayOfferDraftOnly(draft, env) {
  if (draft.pricing?.priceConfidence < 0.45) {
    return {
      ...draft,
      status: "pricing_review_required",
      publishEnabled: false,
      ebayOfferWarnings: [
        ...(Array.isArray(draft.ebayOfferWarnings) ? draft.ebayOfferWarnings : []),
        "Low pricing confidence; manual review recommended."
      ],
      updatedAt: new Date().toISOString()
    };
  }

  if (draft.ebayListing?.listingId) {
    return {
      ...draft,
      status: "already_published",
      publishEnabled: true,
      ebayOffer: {
        ...draft.ebayOffer,
        status: "published",
        publishEnabled: true,
        reusedExistingOffer: true,
        reusedExistingListing: true
      },
      updatedAt: new Date().toISOString()
    };
  }

  if (draft.ebayOffer?.offerId) {
    return {
      ...draft,
      status: "ready_to_publish_later",
      publishEnabled: true,
      ebayOffer: {
        ...draft.ebayOffer,
        status: draft.ebayOffer.status || "draft",
        publishEnabled: true,
        reusedExistingOffer: true
      },
      updatedAt: new Date().toISOString()
    };
  }

  const suggestedPrice = draft.pricing?.suggestedPrice ?? draft.suggestedPrice ?? null;
  if (!isPositiveNumber(suggestedPrice)) {
    return {
      ...draft,
      status: "price_required_before_ebay_offer",
      publishEnabled: false,
      ebayOffer: null,
      ebayOfferWarnings: ["No suggested price is available, so an eBay offer draft was not created."],
      updatedAt: new Date().toISOString()
    };
  }

  const sku = draft.sku || buildSku(draft);
  const inventoryItemPayload = buildEbayInventoryItemPayload(draft);
  await putEbayInventoryItem({ sku, payload: inventoryItemPayload, env });

  const offerPayload = buildEbayOfferPayload(draft, sku, suggestedPrice, env);
  const offer = await createEbayOffer({ payload: offerPayload, env });
  const offerId = stringValue(offer.offerId);
  if (!offerId) {
    throw new Error("eBay Inventory createOffer did not return an offerId.");
  }

  return {
    ...draft,
    sku,
    status: "ready_to_publish_later",
    publishEnabled: true,
    ebayInventoryItem: {
      sku,
      createdOrUpdated: true,
      payload: inventoryItemPayload
    },
    ebayOffer: {
      offerId,
      status: "draft",
      publishEnabled: true,
      payload: offerPayload,
      raw: offer
    },
    updatedAt: new Date().toISOString()
  };
}

async function publishExistingEbayOffer(draft, env) {
  if (draft.ebayListing?.listingId) {
    return {
      ...draft,
      status: "ebay_listing_published",
      publishEnabled: true,
      ebayOffer: {
        ...draft.ebayOffer,
        status: "published",
        publishEnabled: true,
        reusedExistingListing: true
      },
      updatedAt: new Date().toISOString()
    };
  }

  const offerId = stringValue(draft.ebayOffer?.offerId);
  if (!offerId) {
    return {
      ...draft,
      status: "offer_required_before_publish",
      publishEnabled: false,
      ebayOfferWarnings: ["No eBay offer exists yet. Approve the draft before publishing."],
      updatedAt: new Date().toISOString()
    };
  }

  const publishResult = await publishEbayOffer({ offerId, env });
  const listingId = stringValue(publishResult.listingId);

  return {
    ...draft,
    status: "ebay_listing_published",
    publishEnabled: true,
    ebayOffer: {
      ...draft.ebayOffer,
      status: "published",
      publishEnabled: true
    },
    ebayListing: {
      listingId,
      raw: publishResult
    },
    updatedAt: new Date().toISOString()
  };
}

async function putEbayInventoryItem({ sku, payload, env }) {
  const token = await getEbayUserToken(env);
  const response = await fetch(`${EBAY_INVENTORY_URL}/inventory_item/${encodeURIComponent(sku)}`, {
    method: "PUT",
    headers: getEbaySellHeaders(token, env),
    body: JSON.stringify(payload)
  });

  if (response.status === 204) {
    return {};
  }

  return await parseJsonResponse(response, "eBay Inventory createOrReplaceInventoryItem");
}

async function createEbayOffer({ payload, env }) {
  const token = await getEbayUserToken(env);
  const response = await fetch(`${EBAY_INVENTORY_URL}/offer`, {
    method: "POST",
    headers: getEbaySellHeaders(token, env),
    body: JSON.stringify(payload)
  });

  return await parseJsonResponse(response, "eBay Inventory createOffer");
}

async function publishEbayOffer({ offerId, env }) {
  const token = await getEbayUserToken(env);
  const response = await fetch(`${EBAY_INVENTORY_URL}/offer/${encodeURIComponent(offerId)}/publish`, {
    method: "POST",
    headers: getEbaySellHeaders(token, env)
  });

  return await parseJsonResponse(response, "eBay Inventory publishOffer");
}

function buildEbayInventoryItemPayload(draft) {
  const quantity = getDraftQuantity(draft);
  const product = {
    title: truncateText(draft.title || draft.identification?.title || "", 80),
    description: truncateText(buildDescription(draft) || draft.title || draft.identification?.title || "", 4000),
    aspects: formatAspectsForEbay(draft.ebayAspects || {}),
    imageUrls: normalizeImageUrls(draft.imageUrls)
  };
  const brand = draft.brand || draft.identification?.brand || "";
  const mpn = draft.mpn || draft.identification?.mpn || "";

  if (brand) {
    product.brand = brand;
  }

  if (mpn) {
    product.mpn = mpn;
  }

  if (product.imageUrls.length === 0) {
    delete product.imageUrls;
  }

  return {
    availability: {
      shipToLocationAvailability: {
        quantity
      }
    },
    condition: mapEbayCondition(draft.input?.requestedCondition || draft.condition || draft.identification?.condition),
    product
  };
}

function buildEbayOfferPayload(draft, sku, suggestedPrice, env) {
  const payload = {
    sku,
    marketplaceId: env.EBAY_MARKETPLACE_ID || "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: getDraftQuantity(draft),
    categoryId: String(draft.categoryId || ""),
    listingDescription: truncateText(buildDescription(draft) || draft.title || draft.identification?.title || "", 4000),
    pricingSummary: {
      price: {
        value: String(suggestedPrice),
        currency: "USD"
      }
    },
    includeCatalogProductDetails: true
  };
  const listingPolicies = buildListingPolicies(env);

  if (listingPolicies) {
    payload.listingPolicies = listingPolicies;
  }

  if (env.EBAY_MERCHANT_LOCATION_KEY) {
    payload.merchantLocationKey = env.EBAY_MERCHANT_LOCATION_KEY;
  }

  return payload;
}

function buildListingPolicies(env) {
  const listingPolicies = {};

  if (env.EBAY_FULFILLMENT_POLICY_ID) {
    listingPolicies.fulfillmentPolicyId = env.EBAY_FULFILLMENT_POLICY_ID;
  }

  if (env.EBAY_PAYMENT_POLICY_ID) {
    listingPolicies.paymentPolicyId = env.EBAY_PAYMENT_POLICY_ID;
  }

  if (env.EBAY_RETURN_POLICY_ID) {
    listingPolicies.returnPolicyId = env.EBAY_RETURN_POLICY_ID;
  }

  return Object.keys(listingPolicies).length > 0 ? listingPolicies : null;
}

function buildSku(draft) {
  return truncateText(`draft-${draft.id}`, 50);
}

function determineCondition({ aiCondition, userCondition, ocrText, notes, title }) {
  const user = stringValue(userCondition);
  if (user) {
    return {
      condition: user,
      source: "user_override",
      signals: [`User provided condition: ${user}`]
    };
  }

  const text = joinSignalText([ocrText, notes, title]);
  const explicitSignals = [
    { condition: "For Parts", patterns: ["for parts", "not working", "repair", "damaged", "broken"] },
    { condition: "Open Box", patterns: ["open box", "new other", "unused", "new without box", "shelf spare"] },
    { condition: "New", patterns: ["factory sealed", "new sealed", "never opened", "sealed", "new"] },
    { condition: "Used Tested", patterns: ["tested", "working pull", "pulled from working equipment"] }
  ];

  for (const signal of explicitSignals) {
    const match = signal.patterns.find((pattern) => text.includes(pattern));
    if (match) {
      return {
        condition: signal.condition,
        source: "text_signal",
        signals: [`Matched text signal: ${match}`]
      };
    }
  }

  const ai = stringValue(aiCondition);
  if (ai) {
    return {
      condition: ai,
      source: "ai_condition",
      signals: [`AI suggested condition: ${ai}`]
    };
  }

  return {
    condition: "New Open Box",
    source: "fallback",
    signals: ["No explicit condition signal found; defaulted to New Open Box."]
  };
}

function determinePriceMode({ userPriceMode, condition, brand, mpn, ocrText, notes, aiConfidence }) {
  const user = parseUserPriceMode(userPriceMode);
  if (user) {
    return {
      priceMode: user,
      source: "user_override",
      signals: [`User provided price mode: ${user}`]
    };
  }

  const signals = [];
  const text = joinSignalText([ocrText, notes]);
  const brandStrategy = getBrandStrategy(brand);
  const exactMpn = hasStrongMpn(mpn) || extractPartNumberCandidates(`${mpn} ${ocrText}`).some(hasStrongMpn);

  if (/\b(quick sale|move fast|clearance|liquidate)\b/.test(text)) {
    return {
      priceMode: "fast_sale",
      source: "text_signal",
      signals: ["Fast sale signal found in OCR text or notes."]
    };
  }

  if (brandStrategy.premium) {
    signals.push(`Premium industrial brand: ${brandStrategy.brand}`);
  }

  if (exactMpn) {
    signals.push("Exact-looking MPN found.");
  }

  if (brandStrategy.premium || exactMpn) {
    return {
      priceMode: "premium",
      source: brandStrategy.premium ? "brand_premium" : "exact_mpn",
      signals
    };
  }

  if (Number(aiConfidence) < 0.55) {
    return {
      priceMode: "market",
      source: "ai_confidence",
      signals: [`AI confidence ${roundCurrency(Number(aiConfidence) || 0)} below 0.55.`]
    };
  }

  return {
    priceMode: "market",
    source: "market_fallback",
    signals: ["No premium brand or exact MPN signal found."]
  };
}

function getBrandStrategy(brand) {
  const normalized = stringValue(brand).toLowerCase();
  const premiumBrands = [
    "allen-bradley",
    "allen bradley",
    "rockwell",
    "siemens",
    "keyence",
    "omron",
    "banner",
    "schmersal",
    "danfoss",
    "lenze",
    "marel",
    "ishida",
    "secomea",
    "phoenix contact"
  ];
  const matchedBrand = premiumBrands.find((premiumBrand) => normalized.includes(premiumBrand));

  if (matchedBrand) {
    return {
      premium: true,
      brand: stringValue(brand),
      defaultPriceMode: "premium",
      scarcityAdjustmentCap: 0.25,
      reason: "Premium industrial brand supports premium pricing and patient repricing."
    };
  }

  return {
    premium: false,
    brand: stringValue(brand),
    defaultPriceMode: "market",
    scarcityAdjustmentCap: 0.1,
    reason: "Unknown or nonindustrial brand uses conservative market pricing."
  };
}

function applyPricingConfidencePolicy(draft, pricing) {
  const confidence = Number(pricing.priceConfidence);
  const warnings = Array.isArray(pricing.pricingWarnings) ? [...pricing.pricingWarnings] : [];

  if (confidence < 0.45) {
    warnings.push("Low pricing confidence; manual review recommended.");
    return {
      status: "pricing_review_required",
      publishEnabled: false,
      reviewRequired: true,
      pricing: {
        ...pricing,
        pricingWarnings: uniqueNonEmpty(warnings)
      }
    };
  }

  if (confidence < 0.7) {
    warnings.push("Moderate pricing confidence.");
    return {
      status: draft.status,
      publishEnabled: false,
      reviewRequired: false,
      pricing: {
        ...pricing,
        pricingWarnings: uniqueNonEmpty(warnings)
      }
    };
  }

  return {
    status: draft.status,
    publishEnabled: false,
    reviewRequired: false,
    pricing
  };
}

function buildListingStrategy({ draft, pricing, priceMode, reviewRequired }) {
  const mode = parsePriceMode(priceMode);
  const exactIndustrial = Boolean(getBrandStrategy(draft.brand || draft.identification?.brand).premium && hasStrongMpn(draft.mpn || draft.identification?.mpn));
  let watchStrategy;
  let markdownSchedule;
  let reason;

  if (mode === "fast_sale") {
    watchStrategy = "Watch closely for the first 7 days.";
    markdownSchedule = [
      { afterDays: 7, action: "reduce_price", percent: 5, condition: "if no sale" },
      { afterDays: 14, action: "reduce_price", percent: 10, condition: "if no sale" }
    ];
    reason = "Fast sale mode favors early markdowns to move inventory.";
  } else if (exactIndustrial && mode === "premium") {
    watchStrategy = "Hold premium price for 14 days, then review watchers and views.";
    markdownSchedule = [
      { afterDays: 14, action: "reduce_price", percent: 5, condition: "if no watchers or views" },
      { afterDays: 30, action: "reduce_price", percent: "5-10", condition: "if no sale" }
    ];
    reason = "Premium exact industrial part: start firm and give scarce buyers time to find it.";
  } else {
    watchStrategy = "Review market response after 7 days.";
    markdownSchedule = [
      { afterDays: 7, action: "review_interest", percent: 0, condition: "check watchers and views" },
      { afterDays: 14, action: "reduce_price", percent: 5, condition: "if no interest" }
    ];
    reason = "Market mode tracks buyer interest and uses a modest markdown if the listing is quiet.";
  }

  return {
    initialPrice: pricing.suggestedPrice,
    priceMode: mode,
    reviewRequired,
    watchStrategy,
    markdownSchedule,
    autoPublishEligible: false,
    reason
  };
}

function evaluateAutoPublishEligibility(draft) {
  const reasons = [];
  const priceConfidence = Number(draft.pricing?.priceConfidence ?? 0);
  const aiConfidence = Number(draft.identification?.confidence ?? 0);
  const exactMpn = hasStrongMpn(draft.mpn || draft.identification?.mpn);
  const missingRequired = Array.isArray(draft.missingRequiredAspects) ? draft.missingRequiredAspects.filter(Boolean) : [];
  const imageUrls = Array.isArray(draft.imageUrls) ? draft.imageUrls.filter(Boolean) : [];
  const suggestedPrice = draft.pricing?.suggestedPrice ?? draft.suggestedPrice;
  const pricingWarnings = Array.isArray(draft.pricing?.pricingWarnings) ? draft.pricing.pricingWarnings : [];
  const severePricingWarnings = pricingWarnings.filter(isSeverePricingWarning);

  if (priceConfidence < 0.85) {
    reasons.push("Pricing confidence is below 0.85.");
  }
  if (aiConfidence < 0.8) {
    reasons.push("AI identification confidence is below 0.8.");
  }
  if (!exactMpn) {
    reasons.push("No exact MPN is available.");
  }
  if (missingRequired.length > 0) {
    reasons.push(`Missing required item specifics: ${missingRequired.join(", ")}.`);
  }
  if (!draft.categoryId) {
    reasons.push("No eBay categoryId is available.");
  }
  if (imageUrls.length < 2) {
    reasons.push("At least two hosted image URLs are required.");
  }
  if (!isPositiveNumber(suggestedPrice)) {
    reasons.push("Suggested price must be greater than 0.");
  }
  if (normalizeCondition(draft.condition || draft.identification?.condition) === "for_parts") {
    reasons.push("For Parts listings are not eligible for instant listing.");
  }
  if (severePricingWarnings.length > 0) {
    reasons.push(`Severe pricing warnings present: ${severePricingWarnings.join("; ")}.`);
  }

  return {
    eligible: reasons.length === 0,
    reasons
  };
}

function isSeverePricingWarning(warning) {
  const text = stringValue(warning).toLowerCase();
  return text.includes("low pricing confidence")
    || text.includes("manual review")
    || text.includes("no reliable comps")
    || text.includes("no accepted comps")
    || text.includes("pricing search failed");
}

async function addPricingToDraft(draft, { env, token, priceMode, cost, desiredMarginPercent }) {
  const pricingWarnings = [];
  let activeComps = [];
  let soldComps = [];
  const searchCandidates = buildEbaySearchCandidates(draft);

  try {
    activeComps = await getActiveCompsFromEbay({ env, token, draft, searchCandidates });
  } catch (error) {
    pricingWarnings.push(formatWarning("eBay Browse pricing search failed", error));
  }

  try {
    const soldResult = await collectSoldCompsFromSerpApi(draft, env);
    soldComps = soldResult.comps;
    pricingWarnings.push(...soldResult.warnings);
  } catch (error) {
    pricingWarnings.push(formatWarning("SerpAPI sold comp search failed", error));
  }

  const pricing = calculateSuggestedPrice({
    draft,
    activeComps,
    soldComps,
    priceMode,
    cost,
    desiredMarginPercent,
    pricingWarnings
  });
  const activeAccepted = activeComps.filter((comp) => !comp.rejectReason);
  const pricingPolicy = applyPricingConfidencePolicy(draft, pricing);
  const pricedDraft = {
    ...draft,
    status: pricingPolicy.status || draft.status,
    publishEnabled: pricingPolicy.publishEnabled,
    price: pricing.suggestedPrice,
    suggestedPrice: pricing.suggestedPrice,
    pricing: pricingPolicy.pricing,
    ebaySearch: {
      ...(draft.ebaySearch || {}),
      marketplaceId: env.EBAY_MARKETPLACE_ID || "EBAY_US",
      query: searchCandidates[0] || "",
      queries: searchCandidates,
      activeFixedPriceComps: activeAccepted,
      compCount: activeAccepted.length
    },
    listingStrategy: buildListingStrategy({
      draft,
      pricing: pricingPolicy.pricing,
      priceMode: pricing.mode,
      reviewRequired: pricingPolicy.reviewRequired
    }),
    updatedAt: new Date().toISOString()
  };

  pricedDraft.autoPublishEligibility = evaluateAutoPublishEligibility(pricedDraft);
  pricedDraft.listingStrategy = {
    ...pricedDraft.listingStrategy,
    autoPublishEligible: pricedDraft.autoPublishEligibility.eligible
  };

  if (pricedDraft.ebayInventoryItemDraft && pricedDraft.ebayAspects) {
    pricedDraft.ebayInventoryItemDraft = buildEbayInventoryItemDraft(pricedDraft, pricedDraft.ebayAspects);
  }

  return pricedDraft;
}

async function getActiveCompsFromEbay({ env, token, draft, searchCandidates }) {
  const compsByKey = new Map();

  for (const query of searchCandidates) {
    const comps = await searchEbayComps(env, token, query, draft);
    for (const comp of comps) {
      const key = comp.itemId || comp.url || `${comp.title}:${comp.totalPrice}`;
      if (!compsByKey.has(key)) {
        compsByKey.set(key, comp);
      }
    }
  }

  return Array.from(compsByKey.values())
    .sort((a, b) => b.matchScore - a.matchScore);
}

function buildEbaySearchCandidates(draft) {
  const mpn = firstNonEmpty([
    draft.mpn,
    draft.identification?.mpn,
    ...extractPartNumberCandidates(draft.mpn || "")
  ]);
  const brand = firstNonEmpty([draft.brand, draft.identification?.brand]);
  const model = firstNonEmpty([draft.model, draft.identification?.model]);
  const title = firstNonEmpty([draft.title, draft.identification?.title]);
  const ocrPartNumbers = extractPartNumberCandidates(draft.ocrText || draft.input?.ocrText || "");

  return uniqueNonEmpty([
    mpn && brand ? dedupeWords([mpn, brand], 8) : "",
    mpn,
    model && brand ? dedupeWords([model, brand], 8) : "",
    title,
    ...ocrPartNumbers
  ]).slice(0, 8);
}

async function searchEbayComps(env, token, query, draft) {
  if (!query) {
    return [];
  }

  const url = new URL(EBAY_BROWSE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "50");
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");

  const response = await fetch(url, {
    headers: getEbayHeaders(token, env)
  });

  const payload = await parseJsonResponse(response, "eBay Browse");
  const summaries = Array.isArray(payload.itemSummaries) ? payload.itemSummaries : [];

  return summaries
    .map((item) => normalizeEbayActiveComp(item, query, draft));
}

function normalizeEbayActiveComp(item, queryUsed, draft) {
  const price = priceFromEbayValue(item.price);
  const shippingCost = getShippingCost(item);
  const totalPrice = typeof price === "number"
    ? roundCurrency(price + (typeof shippingCost === "number" ? shippingCost : 0))
    : null;
  const categoryIds = getCategoryIdsFromItem(item);
  const comp = {
    source: "ebay_active",
    title: item.title || "",
    price,
    currency: item.price?.currency || "",
    shippingCost,
    totalPrice,
    url: item.itemWebUrl || "",
    itemId: item.itemId || "",
    condition: item.condition || "",
    buyingOptions: Array.isArray(item.buyingOptions) ? item.buyingOptions : [],
    sellerUsername: item.seller?.username || "",
    image: item.image?.imageUrl || "",
    categoryIds,
    queryUsed,
    matchScore: 0,
    rejectReason: null
  };

  return {
    ...comp,
    ...scoreCompMatch(comp, draft)
  };
}

function getShippingCost(item) {
  const options = Array.isArray(item.shippingOptions) ? item.shippingOptions : [];
  for (const option of options) {
    const value = priceFromEbayValue(option.shippingCost);
    if (typeof value === "number") {
      return value;
    }
  }

  return null;
}

function getCategoryIdsFromItem(item) {
  const categoryIds = [];

  if (item.categoryId) {
    categoryIds.push(String(item.categoryId));
  }

  if (Array.isArray(item.categories)) {
    for (const category of item.categories) {
      if (category.categoryId) {
        categoryIds.push(String(category.categoryId));
      }
    }
  }

  if (Array.isArray(item.leafCategoryIds)) {
    categoryIds.push(...item.leafCategoryIds.map(String));
  }

  return uniqueNonEmpty(categoryIds);
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

async function collectSoldCompsFromSerpApi(draft, env) {
  if (!env.SERPAPI_KEY) {
    return {
      comps: [],
      warnings: ["SERPAPI_KEY not configured; sold comps skipped."]
    };
  }

  const warnings = [];
  const compsByKey = new Map();
  const queries = buildSoldCompQueries(draft);

  for (const query of queries) {
    try {
      const comps = await getSoldCompsFromSerpApi(query, env);
      for (const comp of comps.map((item) => ({ ...item, ...scoreCompMatch(item, draft) }))) {
        const key = comp.url || `${comp.title}:${comp.totalPrice}`;
        if (!compsByKey.has(key)) {
          compsByKey.set(key, comp);
        }
      }
    } catch (error) {
      warnings.push(formatWarning(`SerpAPI query failed: ${query}`, error));
    }
  }

  return {
    comps: Array.from(compsByKey.values()).sort((a, b) => b.matchScore - a.matchScore),
    warnings
  };
}

async function getSoldCompsFromSerpApi(query, env) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", env.SERPAPI_KEY);
  url.searchParams.set("num", "10");

  const response = await fetch(url);
  const payload = await parseJsonResponse(response, "SerpAPI");
  const organicResults = Array.isArray(payload.organic_results) ? payload.organic_results : [];

  return organicResults.map((result) => {
    const text = `${result.title || ""} ${result.snippet || ""}`;
    const price = parsePriceFromText(text);

    return {
      source: "serpapi_sold",
      title: result.title || "",
      price,
      totalPrice: price,
      url: result.link || "",
      snippet: result.snippet || "",
      dateSold: parseSoldDate(result.snippet || ""),
      queryUsed: query,
      matchScore: 0,
      rejectReason: null
    };
  });
}

function buildSoldCompQueries(draft) {
  const mpn = firstNonEmpty([draft.mpn, draft.identification?.mpn, ...getDraftPartNumbers(draft)]);
  const brand = firstNonEmpty([draft.brand, draft.identification?.brand]);
  const model = firstNonEmpty([draft.model, draft.identification?.model]);
  const title = firstNonEmpty([draft.title, draft.identification?.title]);

  return uniqueNonEmpty([
    mpn ? `"${mpn}" site:ebay.com/itm sold completed` : "",
    mpn && brand ? `"${brand}" "${mpn}" site:ebay.com/itm sold` : "",
    mpn ? `"${mpn}" "Sold" "Completed" eBay` : "",
    model && brand ? `"${brand}" "${model}" site:ebay.com/itm sold completed` : "",
    title ? `"${title}" site:ebay.com/itm sold completed` : ""
  ]);
}

function scoreCompMatch(comp, draft) {
  const title = stringValue(comp.title);
  const titleLower = title.toLowerCase();
  const draftMpn = firstNonEmpty([draft.mpn, draft.identification?.mpn]);
  const draftModel = firstNonEmpty([draft.model, draft.identification?.model]);
  const draftBrand = firstNonEmpty([draft.brand, draft.identification?.brand]);
  const draftCondition = draft.input?.requestedCondition || draft.condition || draft.identification?.condition;
  const draftParts = getDraftPartNumbers(draft);
  const titleParts = extractPartNumberCandidates(title);
  let score = 0;
  let rejectReason = null;

  const hasMpn = draftMpn && includesIdentifier(title, draftMpn);
  const hasModel = draftModel && includesIdentifier(title, draftModel);
  const hasBrand = draftBrand && titleLower.includes(draftBrand.toLowerCase());
  const hasCategory = draft.categoryId && Array.isArray(comp.categoryIds) && comp.categoryIds.includes(String(draft.categoryId));
  const hasAnyPartMatch = draftParts.some((part) => includesIdentifier(title, part));

  if (hasMpn) {
    score += 50;
  }
  if (hasModel) {
    score += 25;
  }
  if (hasBrand) {
    score += 15;
  }
  if (hasCategory) {
    score += 10;
  }
  if (isSimilarCondition(comp.condition, draftCondition)) {
    score += 8;
  }

  const badKeyword = getBadKeyword(titleLower);
  if (badKeyword) {
    score -= badKeyword.penalty;
    if (badKeyword.reject && !(badKeyword.reason === "untested" && normalizeCondition(draftCondition) === "untested")) {
      rejectReason = badKeyword.reason;
    }
  }

  if (!(typeof comp.totalPrice === "number" && Number.isFinite(comp.totalPrice)) || comp.totalPrice <= 0) {
    rejectReason = "invalid_price";
  }

  if (comp.currency && comp.currency !== "USD") {
    rejectReason = "non_usd_currency";
  }

  if (draftMpn && !hasMpn && !hasModel && !hasBrand && !hasAnyPartMatch) {
    rejectReason = "no_identifier_match";
  }

  if (draftMpn && hasConflictingPartNumber(titleParts, draftParts)) {
    rejectReason = "conflicting_part_number";
  }

  return {
    matchScore: Math.max(0, Math.min(100, score)),
    rejectReason
  };
}

function calculateSuggestedPrice({ draft, activeComps, soldComps, priceMode, cost, desiredMarginPercent, pricingWarnings = [] }) {
  const rescoredActive = activeComps.map((comp) => ({ ...comp, ...scoreCompMatch(comp, draft) }));
  const rescoredSold = soldComps.map((comp) => ({ ...comp, ...scoreCompMatch(comp, draft) }));
  const rejectedComps = [...rescoredActive, ...rescoredSold]
    .filter((comp) => comp.rejectReason)
    .map(trimCompForPricing);
  const acceptedActive = rescoredActive.filter((comp) => !comp.rejectReason);
  const acceptedSold = rescoredSold.filter((comp) => !comp.rejectReason);
  const exactActiveComps = acceptedActive.filter((comp) => isExactComp(comp, draft));
  const exactSoldComps = acceptedSold.filter((comp) => isExactComp(comp, draft));
  const weakerActiveComps = acceptedActive.filter((comp) => !isExactComp(comp, draft));
  const weakerSoldComps = acceptedSold.filter((comp) => !isExactComp(comp, draft));
  const exactComps = [...exactSoldComps, ...exactActiveComps];
  const pricingComps = exactComps.length > 0
    ? exactComps
    : [...weakerSoldComps, ...weakerActiveComps];
  const acceptedComps = [...acceptedSold, ...acceptedActive]
    .sort((a, b) => b.matchScore - a.matchScore)
    .map(trimCompForPricing);
  const warnings = [...pricingWarnings];
  let mode = parsePriceMode(priceMode);
  const brandStrategy = getBrandStrategy(draft.brand || draft.identification?.brand);

  if (mode === "premium" && !brandStrategy.premium && exactComps.length === 0) {
    mode = "market";
    warnings.push("Unknown or nonindustrial brand had no exact comps; market pricing used.");
  }

  if (pricingComps.length === 0) {
    const noCompsFound = acceptedActive.length + acceptedSold.length === 0;
    warnings.push("No accepted comps remained after scoring and filtering.");
    return {
      mode,
      suggestedPrice: null,
      lowPrice: null,
      medianPrice: null,
      highPrice: null,
      activeMedian: medianPrice(acceptedActive),
      soldMedian: medianPrice(acceptedSold),
      priceConfidence: 0,
      pricingReason: noCompsFound ? "No comps found" : "No reliable comps were available after filtering.",
      pricingWarnings: warnings,
      compCount: 0,
      exactCompCount: 0,
      activeCompCount: acceptedActive.length,
      soldCompCount: acceptedSold.length,
      scarcityAdjustment: 0,
      brandStrategy,
      conditionMultiplier: getConditionMultiplier(draft.input?.requestedCondition || draft.condition || draft.identification?.condition),
      minimumMarginPrice: null,
      acceptedComps,
      rejectedComps
    };
  }

  const weightedPrices = weightedCompPrices(pricingComps, exactComps.length > 0);
  const prices = pricingComps.map((comp) => comp.totalPrice).filter(isPositiveNumber).sort((a, b) => a - b);
  const lowPrice = roundCurrency(percentile(prices, 0.25));
  const medianRaw = percentile(weightedPrices, 0.5);
  const highPrice = roundCurrency(percentile(prices, 0.75));
  const activeMedian = medianPrice(acceptedActive);
  const soldMedian = medianPrice(acceptedSold);
  const exactActiveCount = exactActiveComps.length;
  const exactSoldCount = exactSoldComps.length;
  const rawScarcityAdjustment = getScarcityAdjustment(exactActiveCount, exactSoldCount, acceptedActive.length);
  const scarcityAdjustment = Math.min(rawScarcityAdjustment, brandStrategy.scarcityAdjustmentCap);
  const conditionMultiplier = getConditionMultiplier(draft.input?.requestedCondition || draft.condition || draft.identification?.condition);
  let basePrice;

  if (mode === "fast_sale") {
    basePrice = medianRaw * 0.85;
  } else if (mode === "market") {
    basePrice = medianRaw * 0.98;
  } else if (exactComps.length === 0) {
    basePrice = medianRaw * 0.95;
    warnings.push("No exact MPN/model comps found; premium mode used conservative pricing.");
  } else {
    basePrice = scarcityAdjustment > 0
      ? highPrice * 1.10
      : medianRaw * 1.15;
  }

  let suggestedRaw = basePrice * conditionMultiplier * (1 + scarcityAdjustment);
  const minimumMarginPrice = calculateMinimumMarginPrice(cost, desiredMarginPercent);

  if (minimumMarginPrice && suggestedRaw < minimumMarginPrice) {
    suggestedRaw = minimumMarginPrice;
    warnings.push("Suggested price was raised to satisfy the desired margin.");
  }

  const suggestedPrice = roundListingPrice(suggestedRaw);
  const confidence = calculatePriceConfidence({
    draft,
    acceptedActive,
    acceptedSold,
    exactActiveComps,
    exactSoldComps,
    rejectedComps,
    prices
  });

  return {
    mode,
    suggestedPrice,
    lowPrice,
    medianPrice: roundCurrency(medianRaw),
    highPrice,
    activeMedian,
    soldMedian,
    priceConfidence: confidence,
    pricingReason: buildPricingReason({ mode, exactActiveComps, exactSoldComps, acceptedActive, scarcityAdjustment, exactComps, brandStrategy }),
    pricingWarnings: warnings,
    compCount: acceptedActive.length + acceptedSold.length,
    exactCompCount: exactComps.length,
    activeCompCount: acceptedActive.length,
    soldCompCount: acceptedSold.length,
    scarcityAdjustment,
    brandStrategy,
    conditionMultiplier,
    minimumMarginPrice,
    acceptedComps,
    rejectedComps
  };
}

function buildEbaySearchQuery(identification, ocrText = "") {
  return dedupeWords([
    identification.mpn,
    identification.model,
    identification.brand,
    identification.title,
    ...extractPartNumberCandidates(ocrText)
  ], 18);
}

function extractPartNumbers(text) {
  const candidates = extractPartNumberCandidates(text);
  const mpn = candidates[0] || "";
  const model = candidates.find((candidate) => candidate !== mpn) || mpn;

  return { mpn, model, candidates };
}

function extractPartNumberCandidates(text) {
  const sourceText = stringValue(text);
  if (!sourceText) {
    return [];
  }

  const candidates = [];
  const labeledValuePattern = /\b(?:mpn|m\.?p\.?n\.?|model(?:\s*(?:no\.?|number|#))?|part(?:\s*(?:no\.?|number|#))?|p\/n|pn|catalog(?:\s*(?:no\.?|number|#))?|cat(?:\.|\s)*(?:no\.?|number|#)?|mfr(?:\s+part)?(?:\s*(?:no\.?|number|#))?|manufacturer\s+part(?:\s*(?:no\.?|number|#))?)\s*[:#-]?\s*([a-z0-9][a-z0-9._/\-\s]{2,})/gi;
  const siemensPattern = /\b\d[a-z]{2}\d\s+\d{3}-[a-z0-9]{4,}-[a-z0-9]{3,}\b/gi;
  const requestedHyphenatedPattern = /\b[A-Z0-9]{2,}-[A-Z0-9\-]+\b/gi;
  const requestedCompactPattern = /\b[A-Z]{2,}\d{2,}[A-Z0-9\-]*\b/gi;
  const hyphenatedPattern = /\b[a-z0-9]{2,}(?:[-/][a-z0-9]{2,})+\b/gi;
  const compactPattern = /\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{5,}\b/gi;

  for (const line of sourceText.split(/\r?\n/)) {
    const hasSerialLabel = /\b(?:serial|s\/n|sn)\b/i.test(line);
    const hasPartLabel = /\b(?:mpn|m\.?p\.?n\.?|model|part|p\/n|pn|catalog|cat\.?|mfr|manufacturer\s+part)\b/i.test(line);

    if (hasPartLabel) {
      for (const match of line.matchAll(labeledValuePattern)) {
        candidates.push(cleanPartNumber(match[1]));
      }
    }

    if (hasSerialLabel && !hasPartLabel) {
      continue;
    }

    for (const pattern of [siemensPattern, requestedHyphenatedPattern, requestedCompactPattern, hyphenatedPattern, compactPattern]) {
      for (const match of line.matchAll(pattern)) {
        candidates.push(cleanPartNumber(match[0]));
      }
    }
  }

  return uniqueNonEmpty(candidates)
    .filter((candidate) => !isLikelyMeasurement(candidate))
    .slice(0, 12);
}

function cleanPartNumber(value) {
  return String(value || "")
    .trim()
    .replace(/^[#:\s]+/, "")
    .replace(/[),;:]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9._/\-\s]/gi, "");
}

function isLikelyMeasurement(value) {
  return /^\d+(?:\.\d+)?(?:v|vac|vdc|a|amp|amps|hz|w|kw|hp|ma|dc|ac)$/i.test(value);
}

function getDraftPartNumbers(draft) {
  return uniqueNonEmpty([
    draft.mpn,
    draft.model,
    draft.identification?.mpn,
    draft.identification?.model,
    ...(Array.isArray(draft.extractedPartNumbers) ? draft.extractedPartNumbers : []),
    ...extractPartNumberCandidates(draft.ocrText || draft.input?.ocrText || ""),
    ...extractPartNumberCandidates(draft.title || draft.identification?.title || ""),
    ...normalizeItemSpecifics(draft.itemSpecifics || draft.identification?.itemSpecifics || [])
      .filter((specific) => ["mpn", "model", "manufacturer part number", "catalog number"].includes(specific.name.toLowerCase()))
      .flatMap((specific) => extractPartNumberCandidates(specific.value).concat(specific.value))
  ]);
}

function normalizePartNumber(value) {
  return stringValue(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function includesIdentifier(text, identifier) {
  const normalizedText = normalizePartNumber(text);
  const normalizedIdentifier = normalizePartNumber(identifier);
  return Boolean(normalizedIdentifier) && normalizedText.includes(normalizedIdentifier);
}

function hasConflictingPartNumber(titleParts, draftParts) {
  const normalizedDraftParts = draftParts.map(normalizePartNumber).filter(Boolean);
  const normalizedTitleParts = titleParts.map(normalizePartNumber).filter((part) => part.length >= 5);

  if (normalizedDraftParts.length === 0 || normalizedTitleParts.length === 0) {
    return false;
  }

  const hasMatchingPart = normalizedTitleParts.some((part) =>
    normalizedDraftParts.some((draftPart) => part === draftPart || part.includes(draftPart) || draftPart.includes(part))
  );

  return !hasMatchingPart;
}

function getBadKeyword(titleLower) {
  const badKeywords = [
    { pattern: /\bfor parts\b/, reason: "for_parts", penalty: 60, reject: true },
    { pattern: /\brepair\b/, reason: "repair_item", penalty: 45, reject: true },
    { pattern: /\bbroken\b/, reason: "broken_item", penalty: 60, reject: true },
    { pattern: /\bas[-\s]?is\b/, reason: "as_is_item", penalty: 45, reject: true },
    { pattern: /\bas is\b/, reason: "as_is_item", penalty: 45, reject: true },
    { pattern: /\bnot working\b/, reason: "not_working", penalty: 60, reject: true },
    { pattern: /\buntested\b/, reason: "untested", penalty: 25, reject: true },
    { pattern: /\blot of\b/, reason: "lot_or_bundle", penalty: 35, reject: true },
    { pattern: /\blot\s+\d*\b/, reason: "lot_or_bundle", penalty: 35, reject: true },
    { pattern: /\bbundle\b/, reason: "bundle", penalty: 30, reject: true },
    { pattern: /\bmanual\b/, reason: "manual_only", penalty: 55, reject: true },
    { pattern: /\bbox only\b/, reason: "box_only", penalty: 60, reject: true },
    { pattern: /\bempty box\b/, reason: "empty_box", penalty: 60, reject: true },
    { pattern: /\bpower supply only\b/, reason: "partial_item", penalty: 60, reject: true },
    { pattern: /\bcable only\b/, reason: "partial_item", penalty: 60, reject: true },
    { pattern: /\bmount only\b/, reason: "partial_item", penalty: 60, reject: true }
  ];

  return badKeywords.find((entry) => entry.pattern.test(titleLower)) || null;
}

function isSimilarCondition(compCondition, draftCondition) {
  const comp = normalizeCondition(compCondition);
  const draft = normalizeCondition(draftCondition);
  if (!comp || !draft) {
    return false;
  }
  if (comp === draft) {
    return true;
  }
  return (comp.startsWith("new") && draft.startsWith("new"))
    || (comp.startsWith("used") && draft.startsWith("used"));
}

function normalizeCondition(condition) {
  const value = stringValue(condition).toLowerCase();
  if (!value) {
    return "";
  }
  if (value.includes("for parts") || value.includes("not working")) {
    return "for_parts";
  }
  if (value.includes("untested")) {
    return "untested";
  }
  if (value.includes("sealed")) {
    return "new_sealed";
  }
  if (value.includes("open box")) {
    return "new_open_box";
  }
  if (value.includes("new other")) {
    return "new_other";
  }
  if (value.includes("new")) {
    return "new";
  }
  if (value.includes("tested")) {
    return "used_tested";
  }
  if (value.includes("used")) {
    return "used";
  }
  return value;
}

function isExactComp(comp, draft) {
  const title = comp.title || "";
  const draftMpn = firstNonEmpty([draft.mpn, draft.identification?.mpn]);
  const draftModel = firstNonEmpty([draft.model, draft.identification?.model]);

  return (draftMpn && includesIdentifier(title, draftMpn))
    || (draftModel && includesIdentifier(title, draftModel))
    || getDraftPartNumbers(draft).some((part) => includesIdentifier(title, part));
}

function weightedCompPrices(comps, exactOnly) {
  const prices = [];

  for (const comp of comps) {
    if (!isPositiveNumber(comp.totalPrice)) {
      continue;
    }

    const isSold = comp.source === "serpapi_sold";
    const weight = exactOnly
      ? (isSold ? 4 : 3)
      : (isSold ? 2 : 1);

    for (let index = 0; index < weight; index += 1) {
      prices.push(comp.totalPrice);
    }
  }

  return prices.sort((a, b) => a - b);
}

function medianPrice(comps) {
  const prices = comps.map((comp) => comp.totalPrice).filter(isPositiveNumber).sort((a, b) => a - b);
  if (prices.length === 0) {
    return null;
  }
  return roundCurrency(percentile(prices, 0.5));
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function getScarcityAdjustment(exactActiveCount, exactSoldCount, activeCount) {
  if (exactActiveCount <= 2 && exactSoldCount >= 1) {
    if (exactActiveCount === 0) {
      return 0.25;
    }
    if (exactActiveCount === 1) {
      return 0.18;
    }
    return 0.10;
  }

  if (activeCount >= 30) {
    return -0.15;
  }
  if (activeCount >= 15) {
    return -0.08;
  }

  return 0;
}

function getConditionMultiplier(condition) {
  const normalized = normalizeCondition(condition);
  if (normalized === "new_sealed") {
    return 1.25;
  }
  if (normalized === "new_open_box" || normalized === "open_box") {
    return 1.15;
  }
  if (normalized === "new_other" || normalized === "new") {
    return 1.10;
  }
  if (normalized === "used_tested") {
    return 1;
  }
  if (normalized === "used") {
    return 0.95;
  }
  if (normalized === "untested") {
    return 0.75;
  }
  if (normalized === "for_parts") {
    return 0.40;
  }
  return 1;
}

function calculateMinimumMarginPrice(cost, desiredMarginPercent) {
  if (!isPositiveNumber(cost) || !isPositiveNumber(desiredMarginPercent) || desiredMarginPercent >= 100) {
    return null;
  }

  return roundCurrency(cost / (1 - desiredMarginPercent / 100));
}

function roundListingPrice(value) {
  if (!isPositiveNumber(value)) {
    return null;
  }

  if (value < 100) {
    const floorTen = Math.floor(value / 10) * 10;
    const candidates = [floorTen + 4.99, floorTen + 9.99, floorTen + 14.99]
      .filter((candidate) => candidate >= value);
    return roundCurrency(candidates[0] || Math.ceil(value));
  }

  if (value < 1000) {
    return roundCurrency(Math.ceil((value + 0.01) / 10) * 10 - 0.01);
  }

  return Math.ceil((value + 1) / 25) * 25 - 1;
}

function calculatePriceConfidence({ draft, acceptedActive, acceptedSold, exactActiveComps, exactSoldComps, rejectedComps, prices }) {
  let confidence = 0.35;
  const sellers = new Set(acceptedActive.map((comp) => comp.sellerUsername).filter(Boolean));
  const median = percentile(prices, 0.5);
  const low = percentile(prices, 0.25);
  const high = percentile(prices, 0.75);
  const spread = median ? (high - low) / median : 1;

  if (exactSoldComps.length > 0) {
    confidence += 0.25;
  }
  if (exactActiveComps.length > 0) {
    confidence += 0.20;
  }
  if (acceptedActive.length + acceptedSold.length >= 5) {
    confidence += 0.10;
  }
  if (sellers.size >= 3) {
    confidence += 0.05;
  }
  if ([...acceptedActive, ...acceptedSold].some((comp) => Array.isArray(comp.categoryIds) && comp.categoryIds.includes(String(draft.categoryId)))) {
    confidence += 0.05;
  }
  if (spread < 0.30) {
    confidence += 0.10;
  }
  if (spread > 0.80) {
    confidence -= 0.15;
  }
  if (exactActiveComps.length + exactSoldComps.length === 0) {
    confidence -= 0.15;
  }
  if (acceptedSold.length === 0 && acceptedActive.length > 0) {
    confidence -= 0.10;
  }
  if (acceptedActive.length + acceptedSold.length < 3) {
    confidence -= 0.15;
  }
  if ((draft.identification?.confidence ?? 1) < 0.5) {
    confidence -= 0.10;
  }
  if (draft.categoryConfidence !== null && draft.categoryConfidence !== undefined && Number(draft.categoryConfidence) < 0.5) {
    confidence -= 0.10;
  }
  if (rejectedComps.some((comp) => comp.rejectReason === "conflicting_part_number")) {
    confidence -= 0.10;
  }

  return roundCurrency(Math.max(0, Math.min(1, confidence)));
}

function buildPricingReason({ mode, exactActiveComps, exactSoldComps, acceptedActive, scarcityAdjustment, exactComps, brandStrategy }) {
  const parts = [
    `Suggested ${mode.replace("_", " ")} price based on ${exactActiveComps.length} exact active comps and ${exactSoldComps.length} sold comps.`
  ];

  if (mode === "premium" && brandStrategy?.premium) {
    parts.push("Brand premium strategy applied for a premium industrial brand.");
  }

  if (scarcityAdjustment > 0) {
    parts.push(`Scarcity adjustment applied because only ${exactActiveComps.length} exact active listing${exactActiveComps.length === 1 ? " was" : "s were"} found.`);
  } else if (scarcityAdjustment < 0) {
    parts.push(`High active supply adjustment applied because ${acceptedActive.length} active comps were found.`);
  }

  if (exactComps.length === 0) {
    parts.push("No exact MPN/model comps were accepted, so pricing is conservative.");
  }

  return parts.join(" ");
}

function trimCompForPricing(comp) {
  return {
    source: comp.source,
    title: comp.title,
    price: comp.price,
    currency: comp.currency,
    shippingCost: comp.shippingCost ?? null,
    totalPrice: comp.totalPrice,
    url: comp.url,
    condition: comp.condition || "",
    buyingOptions: comp.buyingOptions || [],
    sellerUsername: comp.sellerUsername || "",
    image: comp.image || "",
    categoryIds: comp.categoryIds || [],
    snippet: comp.snippet || "",
    dateSold: comp.dateSold || "",
    queryUsed: comp.queryUsed || "",
    matchScore: comp.matchScore,
    rejectReason: comp.rejectReason
  };
}

function parsePriceFromText(text) {
  const match = stringValue(text).match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function parseSoldDate(text) {
  const match = stringValue(text).match(/\b(?:sold|ended|completed)(?:\s+on)?\s+([A-Z][a-z]{2,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  return match ? match[1] : "";
}

function formatWarning(prefix, error) {
  if (error instanceof ExternalApiError) {
    return `${prefix}: ${error.message}`;
  }
  return `${prefix}: ${error instanceof Error ? error.message : "Unknown error"}`;
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildCategoryQuery(draft) {
  return dedupeWords([
    draft.mpn || draft.identification?.mpn,
    draft.title || draft.identification?.title,
    draft.model || draft.identification?.model,
    draft.brand || draft.identification?.brand,
    draft.categoryHint || draft.identification?.categoryHint
  ], 16);
}

function buildEbayInventoryItemDraft(draft, aspects) {
  const suggestedPrice = draft.pricing?.suggestedPrice ?? draft.suggestedPrice ?? null;
  const inventoryDraft = {
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

  if (isPositiveNumber(suggestedPrice)) {
    inventoryDraft.offer = {
      pricingSummary: {
        price: {
          value: String(suggestedPrice),
          currency: "USD"
        }
      }
    };
  }

  return inventoryDraft;
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
    .map((part) => part.replace(/[^\w./-]/g, "").trim())
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

function uniqueNonEmpty(values) {
  const seen = new Set();
  const unique = [];

  for (const value of values) {
    const cleaned = stringValue(value);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(cleaned);
  }

  return unique;
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

function getEbaySellHeaders(token, env) {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Language": env.EBAY_CONTENT_LANGUAGE || "en-US",
    "X-EBAY-C-MARKETPLACE-ID": env.EBAY_MARKETPLACE_ID || "EBAY_US"
  };
}

function getDraftQuantity(draft) {
  const quantity = Number.parseInt(draft.input?.quantity ?? draft.quantity ?? 1, 10);
  return Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
}

function mapEbayCondition(condition) {
  const normalized = normalizeCondition(condition);

  if (normalized === "new_sealed") {
    return "NEW";
  }

  if (normalized === "new_open_box" || normalized === "new_other" || normalized === "new") {
    return "NEW_OTHER";
  }

  if (normalized === "for_parts") {
    return "FOR_PARTS_OR_NOT_WORKING";
  }

  if (normalized === "untested") {
    return "USED_ACCEPTABLE";
  }

  return "USED_GOOD";
}

function normalizeImageUrls(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueNonEmpty(value)
    .filter((url) => /^https:\/\//i.test(url))
    .slice(0, 24);
}

function getR2PublicBaseUrl(env) {
  const publicBaseUrl = stringValue(env.R2_PUBLIC_BASE_URL).replace(/\/+$/g, "");
  if (publicBaseUrl) {
    return publicBaseUrl;
  }

  const accountId = stringValue(env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || env.ACCOUNT_ID);
  if (!accountId) {
    throw new Error("Missing required R2 public URL: set R2_PUBLIC_BASE_URL.");
  }

  return `https://pub-${accountId}.r2.dev`;
}

function generateImageFilename() {
  const timestamp = Date.now();
  const random = crypto.randomUUID().replace(/-/g, "");
  return `${timestamp}-${random}.jpg`;
}

function stringField(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function positiveIntegerField(formData, key, fallback) {
  const value = Number.parseInt(stringField(formData, key), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalNumberField(formData, key) {
  const rawValue = stringField(formData, key);
  if (!rawValue) {
    return null;
  }

  const value = Number.parseFloat(rawValue.replace(/[$,%\s]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function parseUserPriceMode(value) {
  const mode = stringValue(value).toLowerCase();
  return ["fast_sale", "market", "premium"].includes(mode) ? mode : "";
}

function parsePriceMode(value) {
  const mode = stringValue(value).toLowerCase();
  return ["fast_sale", "market", "premium"].includes(mode) ? mode : "premium";
}

async function parseJsonRequest(request, invalidMessage) {
  try {
    return await request.json();
  } catch {
    return {
      errorResponse: jsonResponse({ error: "invalid_json", message: invalidMessage }, 400)
    };
  }
}

function joinSignalText(values) {
  return values.map(stringValue).filter(Boolean).join(" ").toLowerCase();
}

function hasStrongMpn(value) {
  const mpn = cleanPartNumber(value);
  if (!mpn || mpn.length < 4) {
    return false;
  }
  if (!/[a-z]/i.test(mpn) || !/\d/.test(mpn)) {
    return false;
  }
  if (isLikelyMeasurement(mpn)) {
    return false;
  }
  return /^[a-z0-9][a-z0-9._/-]{2,}[a-z0-9]$/i.test(mpn);
}

function firstNonEmpty(values) {
  return values.map(stringValue).find(Boolean) || "";
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncateText(value, maxLength) {
  const text = stringValue(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
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
