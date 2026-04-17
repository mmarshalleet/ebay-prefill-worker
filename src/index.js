import * as XLSX from "xlsx";

const TEMPLATE_PATH = "/templates/ebay_prefill_customized_inventory.xlsx";
const SHEET_NAME = "eBay-prefill-listing-template";

const REQUIRED_HEADERS = [
  "Custom Label (SKU)",
  "Item Photo URL",
  "Title",
  "Category",
  "Aspects"
];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateTitle(title, maxLength = 80) {
  const cleaned = cleanText(title);
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
}

function escapeAspectValue(value) {
  return String(value ?? "")
    .replace(/\|/g, "/")
    .replace(/=/g, "-")
    .trim();
}

function normalizePhotoUrls(photoUrls) {
  if (!Array.isArray(photoUrls)) return "";
  return photoUrls
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join("|");
}

function normalizeCondition(condition) {
  const c = String(condition || "").toLowerCase().trim();

  if (["new", "factory sealed", "sealed"].includes(c)) return "New";
  if (["new open box", "open box", "nos"].includes(c)) return "New Open Box";
  if (["used", "tested used"].includes(c)) return "Used";
  if (["for parts", "parts only", "not working"].includes(c)) {
    return "For parts or not working";
  }

  return cleanText(condition || "");
}

function buildCategory(item) {
  const type = String(item.type || "").toLowerCase();
  const model = String(item.model || "").toLowerCase();
  const title = String(item.title || "").toLowerCase();

  if (
    type.includes("drive") ||
    type.includes("vfd") ||
    model.includes("powerflex") ||
    title.includes("drive")
  ) {
    return "Variable Frequency Drives";
  }

  if (
    type.includes("hmi") ||
    type.includes("panelview") ||
    model.includes("panelview") ||
    title.includes("hmi")
  ) {
    return "HMI & Open Interface Panels";
  }

  if (
    type.includes("plc") ||
    type.includes("controller") ||
    title.includes("compactlogix") ||
    title.includes("controllogix") ||
    title.includes("micrologix")
  ) {
    return "PLC Processors";
  }

  if (type.includes("sensor") || title.includes("sensor")) {
    return "Other Sensors";
  }

  return cleanText(item.category || "");
}

function buildAspects(item) {
  return {
    Brand: item.brand,
    MPN: item.mpn,
    Model: item.model,
    Type: item.type,
    Condition: normalizeCondition(item.condition),
    Voltage: item.voltage,
    Phase: item.phase,
    InputVoltage: item.inputVoltage,
    OutputVoltage: item.outputVoltage
  };
}

function normalizeAspects(aspects) {
  if (!aspects || typeof aspects !== "object") return "";

  return Object.entries(aspects)
    .filter(([k, v]) => normalizeText(k) && normalizeText(v))
    .map(([k, v]) => `${normalizeText(k)}=${escapeAspectValue(v)}`)
    .join("|");
}

function buildTitle(item) {
  const condition = normalizeCondition(item.condition);

  const parts = [
    item.brand,
    item.model,
    item.mpn,
    item.type,
    ...(Array.isArray(item.keywords) ? item.keywords : []),
    condition
  ]
    .map((v) => cleanText(v))
    .filter(Boolean);

  return truncateTitle(parts.join(" "));
}

function validateRow(item, index) {
  const errors = [];

  if (!cleanText(item.sku)) {
    errors.push(`Row ${index + 1}: missing sku`);
  }

  if (!Array.isArray(item.photoUrls) || item.photoUrls.length === 0) {
    errors.push(`Row ${index + 1}: missing photoUrls`);
  }

  const hasTitleInputs =
    cleanText(item.title) ||
    cleanText(item.brand) ||
    cleanText(item.model) ||
    cleanText(item.mpn) ||
    cleanText(item.type);

  if (!hasTitleInputs) {
    errors.push(`Row ${index + 1}: missing title and title-building fields`);
  }

  return errors;
}

function makeRow(item) {
  const condition = normalizeCondition(item.condition);
  const builtAspects = item.aspects && typeof item.aspects === "object"
    ? item.aspects
    : buildAspects({ ...item, condition });

  return {
    "Custom Label (SKU)": cleanText(item.sku),
    "Item Photo URL": normalizePhotoUrls(item.photoUrls),
    "Title": truncateTitle(item.title || buildTitle({ ...item, condition })),
    "Category": cleanText(item.category || buildCategory(item)),
    "Aspects": normalizeAspects(builtAspects)
  };
}

function findHeaderRowAndColumns(ws) {
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");

  for (let r = range.s.r; r <= range.e.r; r++) {
    const colMap = {};

    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      const value = normalizeText(cell?.v);

      if (REQUIRED_HEADERS.includes(value)) {
        colMap[value] = c;
      }
    }

    const foundAll = REQUIRED_HEADERS.every((header) => colMap[header] !== undefined);
    if (foundAll) {
      return { headerRow: r, colMap };
    }
  }

  throw new Error(`Could not find the required header row on sheet "${SHEET_NAME}".`);
}

function clearDataRowsBelowHeader(ws, headerRow, colMap) {
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
  const minCol = Math.min(...Object.values(colMap));
  const maxCol = Math.max(...Object.values(colMap));

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      delete ws[addr];
    }
  }

  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: range.s.r, c: range.s.c },
    e: { r: headerRow, c: range.e.c }
  });
}

function writeRows(ws, headerRow, colMap, rows) {
  let targetRow = headerRow + 1;

  for (const row of rows) {
    for (const header of REQUIRED_HEADERS) {
      const c = colMap[header];
      const addr = XLSX.utils.encode_cell({ r: targetRow, c });
      ws[addr] = {
        t: "s",
        v: row[header] ?? ""
      };
    }
    targetRow++;
  }

  const currentRange = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
  const maxWrittenRow = Math.max(currentRange.e.r, targetRow - 1);
  const maxWrittenCol = Math.max(currentRange.e.c, ...Object.values(colMap));

  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: currentRange.s.r, c: currentRange.s.c },
    e: { r: maxWrittenRow, c: maxWrittenCol }
  });
}

async function loadTemplateFromAssets(env) {
  const assetUrl = new URL(`https://internal${TEMPLATE_PATH}`);
  const response = await env.ASSETS.fetch(assetUrl);

  if (!response.ok) {
    throw new Error(`Template asset not found at ${TEMPLATE_PATH}`);
  }

  return await response.arrayBuffer();
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        message: "POST JSON with { rows: [...] } or { preview: true, rows: [...] }"
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, error: "Use POST with JSON body: { rows: [...] }" },
        405
      );
    }

    try {
      const body = await request.json();
      const inputRows = Array.isArray(body?.rows) ? body.rows : [];

      if (!inputRows.length) {
        return jsonResponse({ ok: false, error: "No rows provided." }, 400);
      }

      const validationErrors = inputRows.flatMap((row, i) => validateRow(row, i));
      if (validationErrors.length) {
        return jsonResponse(
          {
            ok: false,
            error: "Validation failed.",
            details: validationErrors
          },
          400
        );
      }

      const transformedRows = inputRows.map(makeRow);

      if (body?.preview === true) {
        return jsonResponse({
          ok: true,
          previewRows: transformedRows
        });
      }

      const templateArrayBuffer = await loadTemplateFromAssets(env);

      const workbook = XLSX.read(templateArrayBuffer, {
        type: "array",
        cellStyles: true,
        cellFormula: true,
        cellNF: true,
        cellDates: true
      });

      const ws = workbook.Sheets[SHEET_NAME];

      if (!ws) {
        return jsonResponse(
          {
            ok: false,
            error: `Sheet "${SHEET_NAME}" not found in template.`
          },
          500
        );
      }

      const { headerRow, colMap } = findHeaderRowAndColumns(ws);

      clearDataRowsBelowHeader(ws, headerRow, colMap);
      writeRows(ws, headerRow, colMap, transformedRows);

      const output = XLSX.write(workbook, {
        type: "array",
        bookType: "xlsx",
        compression: true
      });

      return new Response(output, {
        status: 200,
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": 'attachment; filename="ebay_prefill_filled.xlsx"',
          "cache-control": "no-store"
        }
      });
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