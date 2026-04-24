function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function csvResponse(text, filename = "eBay-edit-price-quantity-with-cost.csv") {
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store"
    }
  });
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parsePrice(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (!cleaned) return "";

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : "";

}
function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsv(csvText) {
  const rawLines = String(csvText ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(line => line.trim().length > 0);

  if (!rawLines.length) return [];

  // Detect delimiter
  const sample = rawLines.slice(0, 10).join("\n");
  const commaCount = (sample.match(/,/g) || []).length;
  const tabCount = (sample.match(/\t/g) || []).length;
  const delimiter = tabCount > commaCount ? "\t" : ",";

  function parseLine(line) {
    if (delimiter === "\t") return line.split("\t");

    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (ch === '"' && inQuotes && next === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }

    result.push(current);
    return result;
  }

  // Find actual header row
  const headerIndex = rawLines.findIndex(line => {
    const cols = parseLine(line).map(cleanText);
    return (
      cols.includes("Item number") ||
      cols.includes("Item Number") ||
      cols.includes("Custom label (SKU)") ||
      cols.includes("Title")
    );
  });

  if (headerIndex === -1) {
    throw new Error(
      "Could not find eBay header row. Expected columns like Item number, Title, or Custom label (SKU)."
    );
  }

  const headers = parseLine(rawLines[headerIndex]).map(cleanText);
  const dataLines = rawLines.slice(headerIndex + 1);

  return dataLines.map(line => {
    const values = parseLine(line);
    const row = {};

    headers.forEach((header, i) => {
      row[header] = values[i] ?? "";
    });

    return row;
  });
}

function parseCsv(csvText) {
  const lines = String(csvText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(line => line.trim());

  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]).map(cleanText);

  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, i) => {
      row[header] = values[i] ?? "";
    });
    return row;
  });
}

function getField(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && cleanText(row[name]) !== "") return row[name];
  }
  return "";
}

function normalizeCondition(condition) {
  const c = cleanText(condition).toLowerCase();

  if (["new", "brand new", "factory sealed", "sealed"].includes(c)) return "New";

  if (
    [
      "new open box",
      "open box",
      "new - open box",
      "new – open box",
      "new — open box",
      "nos"
    ].includes(c)
  ) {
    return "New Open Box";
  }

  if (["used", "tested used"].includes(c)) return "Used";

  if (
    ["for parts", "parts only", "not working", "for parts or not working"].includes(c)
  ) {
    return "For parts or not working";
  }

  return cleanText(condition);
}

function roundEbayPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";

  let rounded;

  if (n >= 1000) rounded = Math.round(n / 25) * 25 - 0.01;
  else if (n >= 250) rounded = Math.round(n / 10) * 10 - 0.01;
  else if (n >= 100) rounded = Math.round(n / 5) * 5 - 0.01;
  else rounded = Math.round(n) - 0.01;

  return Number(rounded.toFixed(2));
}

function suggestPrice(currentPrice, cost, condition) {
  const current = Number(currentPrice);
  const itemCost = Number(cost);
  const normalized = normalizeCondition(condition).toLowerCase();

  if (!Number.isFinite(current) || current <= 0) return "";

  let multiplier = 1;

  if (normalized === "new") multiplier = 1.08;
  else if (normalized === "new open box") multiplier = 1.02;
  else if (normalized === "used") multiplier = 0.92;
  else if (normalized.includes("parts")) multiplier = 0.65;

  let proposed = current * multiplier;

  // Guardrail: never auto-drop more than 20%
  const maxDropPrice = current * 0.8;
  if (proposed < maxDropPrice) proposed = maxDropPrice;

  // Guardrail: if cost exists, keep at least 35% above cost
  if (Number.isFinite(itemCost) && itemCost > 0) {
    const minPrice = itemCost * 1.35;
    if (proposed < minPrice) proposed = minPrice;
  }

  return roundEbayPrice(proposed);
}

function toCsv(rows, headers) {
  return [
    headers.map(escapeCsv).join(","),
    ...rows.map(row => headers.map(h => escapeCsv(row[h] ?? "")).join(","))
  ].join("\n");
}

function mapEbayRow(row) {
  const itemNumber = cleanText(
    getField(row, [
      "Item number",
      "Item Number",
      "Item ID",
      "Item Id",
      "ItemID"
    ])
  );

  const sku = cleanText(
    getField(row, [
      "Custom label (SKU)",
      "Custom Label (SKU)",
      "Custom label",
      "Custom Label",
      "SKU"
    ])
  );

  const title = cleanText(
    getField(row, [
      "Title",
      "Item title",
      "Listing title"
    ])
  );

  const currentPrice = parsePrice(
    getField(row, [
      "Current price",
      "Current Price",
      "Start price",
      "Start Price",
      "Price",
      "Buy It Now price",
      "Buy It Now Price"
    ])
  );

  const quantity = cleanText(
    getField(row, [
      "Available quantity",
      "Available Quantity",
      "Quantity",
      "Qty",
      "Available"
    ])
  );

  const condition = cleanText(
    getField(row, [
      "Condition",
      "Item condition"
    ])
  );

  const cost = parsePrice(
    getField(row, [
      "My cost",
      "My Cost",
      "Cost",
      "Item cost",
      "Item Cost",
      "Product cost",
      "Product Cost"
    ])
  );

  return {
    itemNumber,
    sku,
    title,
    currentPrice,
    quantity,
    condition,
    cost
  };
}

function detectIssues(item) {
  const issues = [];

  if (!item.itemNumber) issues.push("MISSING_ITEM_NUMBER");
  if (!item.sku) issues.push("MISSING_SKU");
  if (!item.currentPrice || Number(item.currentPrice) <= 0) issues.push("INVALID_PRICE");
  if (!item.cost || Number(item.cost) <= 0) issues.push("NO_COST");
  if (!item.quantity) issues.push("NO_QUANTITY");

  if (
    Number(item.cost) > 0 &&
    Number(item.currentPrice) > 0 &&
    Number(item.currentPrice) <= Number(item.cost)
  ) {
    issues.push("PRICE_AT_OR_BELOW_COST");
  }

  return issues;
}

function buildPriceCostRows(items) {
  return items.map(item => {
    const suggested = suggestPrice(item.currentPrice, item.cost, item.condition);
    const issues = detectIssues(item);

    return {
      Action: "Revise",
      "Item number": item.itemNumber,
      "Custom label (SKU)": item.sku,
      Price: suggested || item.currentPrice,
      Quantity: item.quantity,
      "My cost": item.cost,
      CurrentPrice: item.currentPrice,
      Title: item.title,
      Condition: normalizeCondition(item.condition),
      Issues: issues.join("|")
    };
  });
}

function buildPreviewRows(items) {
  return items.map(item => {
    const suggested = suggestPrice(item.currentPrice, item.cost, item.condition);
    const issues = detectIssues(item);

    return {
      sku: item.sku,
      itemNumber: item.itemNumber,
      title: item.title,
      currentPrice: item.currentPrice,
      suggestedPrice: suggested || item.currentPrice,
      quantity: item.quantity,
      myCost: item.cost,
      condition: normalizeCondition(item.condition),
      issues
    };
  });
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        message: "POST your eBay active listings CSV file.",
        endpoints: {
          preview: "POST https://ebay-export.mmarshalleet.workers.dev?preview=true",
          priceCostCsv: "POST https://ebay-export.mmarshalleet.workers.dev?output=ebay-price-cost"
        }
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Use POST." }, 405);
    }

    try {
      const url = new URL(request.url);
      const preview = url.searchParams.get("preview") === "true";
      const output = url.searchParams.get("output") || "ebay-price-cost";

      const csvText = await request.text();

      if (!csvText.trim()) {
        return jsonResponse({ ok: false, error: "Empty CSV body." }, 400);
      }

      const parsedRows = parseCsv(csvText);

      if (!parsedRows.length) {
        return jsonResponse({ ok: false, error: "No rows found in CSV." }, 400);
      }

      const items = parsedRows.map(mapEbayRow);

      if (preview) {
        const previewRows = buildPreviewRows(items);

        return jsonResponse({
          ok: true,
          summary: {
            totalRows: previewRows.length,
            missingItemNumber: previewRows.filter(x =>
              x.issues.includes("MISSING_ITEM_NUMBER")
            ).length,
            missingSku: previewRows.filter(x =>
              x.issues.includes("MISSING_SKU")
            ).length,
            noCost: previewRows.filter(x =>
              x.issues.includes("NO_COST")
            ).length,
            noQuantity: previewRows.filter(x =>
              x.issues.includes("NO_QUANTITY")
            ).length,
            priceAtOrBelowCost: previewRows.filter(x =>
              x.issues.includes("PRICE_AT_OR_BELOW_COST")
            ).length
          },
          rows: previewRows.slice(0, 100)
        });
      }

      if (output === "ebay-price-cost") {
        const rows = buildPriceCostRows(items);

        const headers = [
          "Action",
          "Item number",
          "Custom label (SKU)",
          "Price",
          "Quantity",
          "My cost",
          "CurrentPrice",
          "Title",
          "Condition",
          "Issues"
        ];

        return csvResponse(
          toCsv(rows, headers),
          "eBay-edit-price-quantity-with-cost.csv"
        );
      }

      return jsonResponse(
        {
          ok: false,
          error: `Unknown output mode: ${output}`
        },
        400
      );
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error?.message || "Update failed."
        },
        500
      );
    }
  }
};