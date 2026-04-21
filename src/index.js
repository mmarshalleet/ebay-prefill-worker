function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function textResponse(text, filename = "output.csv", status = 200) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store"
    }
  });
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCondition(condition) {
  const c = cleanText(condition).toLowerCase();

  if (["new", "brand new", "factory sealed", "sealed"].includes(c)) return "New";
  if (["new open box", "open box", "new – open box", "new — open box", "new - open box", "nos"].includes(c)) return "New Open Box";
  if (["used", "tested used"].includes(c)) return "Used";
  if (["for parts", "parts only", "not working", "for parts or not working"].includes(c)) {
    return "For parts or not working";
  }

  return cleanText(condition);
}

function truncateTitle(title, maxLength = 80) {
  const cleaned = cleanText(title);
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
}

function uniqueWords(values) {
  const out = [];
  const seen = new Set();

  for (const v of values) {
    const s = cleanText(v);
    if (!s) continue;
    const key = s.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }

  return out;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundEbayPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return null;

  let rounded;
  if (value >= 1000) rounded = Math.round(value / 25) * 25 - 0.01;
  else if (value >= 250) rounded = Math.round(value / 10) * 10 - 0.01;
  else if (value >= 100) rounded = Math.round(value / 5) * 5 - 0.01;
  else rounded = Math.round(value) - 0.01;

  return Number(rounded.toFixed(2));
}

function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  result.push(current);
  return result;
}

function parseCsv(csvText) {
  const lines = String(csvText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(line => line.length > 0);

  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]).map(h => cleanText(h));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};

    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }

    rows.push(row);
  }

  return rows;
}

function toCsv(rows) {
  if (!rows.length) return "";

  const headers = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const lines = [
    headers.map(escapeCsv).join(","),
    ...rows.map(row => headers.map(h => escapeCsv(row[h] ?? "")).join(","))
  ];

  return lines.join("\n");
}

function getField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== "") return row[key];
  }
  return "";
}

function parsePrice(value) {
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function splitPhotoUrls(value) {
  const s = cleanText(value);
  if (!s) return [];
  return s.split("|").map(v => cleanText(v)).filter(Boolean);
}

function titleWords(title) {
  return cleanText(title)
    .split(/\s+/)
    .map(v => v.replace(/[^\w.+/-]/g, ""))
    .filter(Boolean);
}

function looksLikeMpn(token) {
  const s = cleanText(token);
  if (!s) return false;
  if (s.length < 4) return false;
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return false;
  return /^[A-Za-z0-9._/-]+$/.test(s);
}

function extractMpn(title) {
  const words = titleWords(title);
  const blacklist = new Set([
    "NEW", "USED", "BOX", "OPEN", "WITH", "AND", "FOR", "PLC", "HMI", "VFD",
    "SENSOR", "PROXIMITY", "SWITCH", "MODULE", "INPUT", "OUTPUT", "DRIVE"
  ]);

  for (const word of words) {
    const up = word.toUpperCase();
    if (blacklist.has(up)) continue;
    if (looksLikeMpn(word)) return word;
  }

  return "";
}

function extractBrand(title) {
  const t = cleanText(title);
  const knownBrands = [
    "Allen-Bradley",
    "Banner Engineering",
    "Balluff",
    "Wiegmann",
    "Festo",
    "HTM",
    "Sealite",
    "New Klay Instrument",
    "Smart",
    "Siemens",
    "Omron",
    "Keyence",
    "Mitsubishi",
    "Schneider",
    "Pro-face",
    "Proface",
    "Marel",
    "Secomea"
  ];

  for (const brand of knownBrands) {
    if (t.toLowerCase().includes(brand.toLowerCase())) return brand;
  }

  return titleWords(t).slice(0, 2).join(" ");
}

function extractModel(title, brand, mpn) {
  const t = cleanText(title);
  let model = t;

  if (brand) {
    const reBrand = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    model = model.replace(reBrand, "").trim();
  }

  if (mpn) {
    const reMpn = new RegExp(mpn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    model = model.replace(reMpn, "").trim();
  }

  model = model
    .replace(/\b(new|used|open box|new open box|factory sealed|sealed)\b/ig, "")
    .replace(/\s+/g, " ")
    .trim();

  return model.split(" ").slice(0, 4).join(" ");
}

function inferType(title, categoryId) {
  const t = cleanText(title).toLowerCase();

  if (["181708"].includes(String(categoryId))) return "PLC Processor";
  if (["65459"].includes(String(categoryId))) return "Proximity Sensor";
  if (t.includes("panelview") || t.includes("hmi") || t.includes("operator interface")) return "HMI";
  if (t.includes("powerflex") || t.includes("vfd") || t.includes("drive")) return "Variable Frequency Drive";
  if (t.includes("plc") || t.includes("compactlogix") || t.includes("controllogix") || t.includes("micrologix")) return "PLC Processor";
  if (t.includes("sensor")) return "Sensor";
  if (t.includes("module")) return "Module";
  if (t.includes("conduit")) return "Conduit Fitting";

  return "Industrial Automation Component";
}

function mapCategoryName(categoryId, title = "") {
  const id = String(categoryId || "");
  const t = cleanText(title).toLowerCase();

  const categoryMap = {
    "65459": "Proximity Sensors",
    "181708": "PLC Processors",
    "42894": "General Purpose Industrial Control",
    "26261": "Other Business & Industrial",
    "184027": "Hydraulic Valves",
    "117490": "Conduit Fittings"
  };

  if (categoryMap[id]) return categoryMap[id];
  if (t.includes("sensor")) return "Other Sensors";
  if (t.includes("plc")) return "PLC Processors";
  if (t.includes("drive") || t.includes("vfd")) return "Variable Frequency Drives";
  if (t.includes("panelview") || t.includes("hmi")) return "HMI & Open Interface Panels";

  return "Other Business & Industrial";
}

function optimizeTitle(item) {
  const condition = normalizeCondition(item.condition);

  const parts = uniqueWords([
    item.brand,
    item.model,
    item.mpn,
    item.type,
    ...item.specs,
    condition
  ]);

  return truncateTitle(parts.join(" "));
}

function extractSpecs(title) {
  const specs = [];
  const tokens = titleWords(title);

  for (const token of tokens) {
    const up = token.toUpperCase();

    if (/^\d+V$/.test(up)) specs.push(token);
    else if (/^\d+HP$/.test(up)) specs.push(token);
    else if (/^\d+PHASE$/.test(up)) specs.push(token);
    else if (/^\d+[- ]?PHASE$/.test(up.replace(/\s+/g, ""))) specs.push(token);
    else if (/^\d+MM$/.test(up)) specs.push(token);
    else if (/^\d+IN$/.test(up)) specs.push(token);
    else if (up === "TOUCH" || up === "TOUCHSCREEN") specs.push(token);
  }

  return uniqueWords(specs);
}

function detectIssues(item, allSkus) {
  const issues = [];

  if (!item.sku) issues.push("MISSING_SKU");
  if (item.sku && allSkus.get(item.sku) > 1) issues.push("DUPLICATE_SKU");
  if (!item.title) issues.push("MISSING_TITLE");
  if (!item.currentPrice || item.currentPrice <= 0) issues.push("INVALID_PRICE");
  if (!item.photoUrls.length) issues.push("NO_PHOTOS");
  if (!item.mpn) issues.push("MPN_MISSING");
  if (item.mpn && !item.title.toLowerCase().includes(item.mpn.toLowerCase())) {
    issues.push("MPN_NOT_IN_TITLE");
  }
  if (!item.categoryId) issues.push("MISSING_CATEGORY_ID");
  if (item.optimizedTitle.length < 20) issues.push("WEAK_TITLE");
  if (item.optimizedTitle === item.title) issues.push("TITLE_UNCHANGED");

  return issues;
}

function calculateSuggestedPrice(item, compGroup) {
  const compPrices = compGroup
    .map(x => x.currentPrice)
    .filter(v => Number.isFinite(v) && v > 0);

  if (!compPrices.length) return item.currentPrice;

  const med = median(compPrices);
  const condition = normalizeCondition(item.condition).toLowerCase();

  let multiplier = 1.0;
  if (condition === "new") multiplier = 1.08;
  else if (condition === "new open box") multiplier = 1.02;
  else if (condition === "used") multiplier = 0.9;
  else if (condition.includes("parts")) multiplier = 0.6;

  const suggested = roundEbayPrice(med * multiplier);
  if (!suggested) return item.currentPrice;

  if (item.currentPrice && suggested < item.currentPrice * 0.7) {
    return item.currentPrice;
  }

  return suggested;
}

function buildCompKey(item) {
  if (item.mpn) return `mpn:${item.mpn.toLowerCase()}`;
  return `title:${cleanText(item.title).split(" ").slice(0, 4).join(" ").toLowerCase()}`;
}

function mapEbayRow(row) {
  const title = cleanText(getField(row, ["Title"]));
  const sku = cleanText(getField(row, ["Custom label (SKU)", "Custom label", "SKU"]));
  const currentPrice = parsePrice(getField(row, ["Current price", "Start price"]));
  const startPrice = parsePrice(getField(row, ["Start price"]));
  const condition = cleanText(getField(row, ["Condition"]));
  const categoryId = cleanText(getField(row, ["eBay category 1", "eBay category", "eBay category ID"]));
  const photoUrls = splitPhotoUrls(getField(row, ["Item photo URL", "Item photo urls", "Photo URL"]));
  const brand = extractBrand(title);
  const mpn = extractMpn(title);
  const model = extractModel(title, brand, mpn);
  const type = inferType(title, categoryId);
  const specs = extractSpecs(title);

  return {
    raw: row,
    sku,
    title,
    currentPrice,
    startPrice,
    condition,
    categoryId,
    photoUrls,
    brand,
    mpn,
    model,
    type,
    specs
  };
}

function buildAuditRows(items) {
  return items.map(item => ({
    SKU: item.sku,
    CurrentTitle: item.title,
    OptimizedTitle: item.optimizedTitle,
    CurrentPrice: item.currentPrice ?? "",
    SuggestedPrice: item.suggestedPrice ?? "",
    PriceDelta: Number.isFinite(item.suggestedPrice) && Number.isFinite(item.currentPrice)
      ? Number((item.suggestedPrice - item.currentPrice).toFixed(2))
      : "",
    Condition: item.normalizedCondition,
    CategoryID: item.categoryId,
    CategoryName: item.categoryName,
    Brand: item.brand,
    MPN: item.mpn,
    Model: item.model,
    Type: item.type,
    PhotoCount: item.photoUrls.length,
    Issues: item.issues.join("|")
  }));
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        message: "POST raw eBay CSV export. Optional query: ?preview=true"
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Use POST." }, 405);
    }

    try {
      const url = new URL(request.url);
      const preview = url.searchParams.get("preview") === "true";
      const output = url.searchParams.get("output") || "csv";

      const csvText = await request.text();
      if (!csvText || !csvText.trim()) {
        return jsonResponse({ ok: false, error: "Empty CSV body." }, 400);
      }

      const rows = parseCsv(csvText);
      if (!rows.length) {
        return jsonResponse({ ok: false, error: "No rows parsed from CSV." }, 400);
      }

      const mapped = rows.map(mapEbayRow);

      const skuCounts = new Map();
      for (const item of mapped) {
        if (!item.sku) continue;
        skuCounts.set(item.sku, (skuCounts.get(item.sku) || 0) + 1);
      }

      const compGroups = new Map();
      for (const item of mapped) {
        const key = buildCompKey(item);
        if (!compGroups.has(key)) compGroups.set(key, []);
        compGroups.get(key).push(item);
      }

      const finalItems = mapped.map(item => {
        const normalizedCondition = normalizeCondition(item.condition);
        const categoryName = mapCategoryName(item.categoryId, item.title);
        const optimizedTitle = optimizeTitle({
          ...item,
          condition: normalizedCondition
        });
        const suggestedPrice = calculateSuggestedPrice(
          { ...item, condition: normalizedCondition },
          compGroups.get(buildCompKey(item)) || []
        );

        const enriched = {
          ...item,
          normalizedCondition,
          categoryName,
          optimizedTitle,
          suggestedPrice
        };

        enriched.issues = detectIssues(enriched, skuCounts);
        return enriched;
      });

      const auditRows = buildAuditRows(finalItems);

      if (preview) {
        return jsonResponse({
          ok: true,
          summary: {
            totalRows: finalItems.length,
            duplicateSkus: finalItems.filter(x => x.issues.includes("DUPLICATE_SKU")).length,
            missingSku: finalItems.filter(x => x.issues.includes("MISSING_SKU")).length,
            missingMpn: finalItems.filter(x => x.issues.includes("MPN_MISSING")).length,
            noPhotos: finalItems.filter(x => x.issues.includes("NO_PHOTOS")).length,
            changedTitles: finalItems.filter(x => x.optimizedTitle !== x.title).length
          },
          rows: auditRows.slice(0, 100)
        });
      }

      if (output === "json") {
        return jsonResponse({
          ok: true,
          rows: auditRows
        });
      }

      const outCsv = toCsv(auditRows);
      return textResponse(outCsv, "ebay_active_listing_audit.csv");
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error?.message || "Worker failed."
        },
        500
      );
    }
  }
};