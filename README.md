# eBay Photo Listing Draft Worker

Cloudflare Worker for turning iOS Shortcut photo uploads into private eBay listing drafts. It identifies the item with OpenAI Vision, searches active fixed-price eBay Browse API comps, selects an eBay category with the Taxonomy API, checks required item specifics, suggests a price, stores the draft in KV, and returns JSON for review.

Publishing is deliberately gated. `POST /approve` only marks a saved draft as `ready_to_publish_later`; it does not call any eBay listing or inventory publish API.

## Endpoints

### `GET /`

Returns service status and available endpoints.

### `POST /draft`

Accepts `multipart/form-data`.

Required form field:

- `images`: one or more image files

Optional form fields:

- `notes`
- `condition`
- `quantity`

The response includes:

- OpenAI item identification
- eBay search query
- active fixed-price Browse API comps
- suggested price calculated as `median active comps * 0.95`
- automatic eBay category selection from the Taxonomy API
- required and recommended item specifics for the selected category
- missing required item specifics, if eBay requires values the photos did not provide
- the KV draft id

If no category can be determined, the Worker returns:

```json
{
  "error": "category_required",
  "message": "No eBay category could be determined.",
  "query": "...",
  "draft": {}
}
```

If required item specifics are missing, the Worker returns:

```json
{
  "error": "missing_required_item_specifics",
  "categoryId": "...",
  "categoryName": "...",
  "missingRequiredAspects": ["Brand", "MPN"],
  "requiredAspects": [],
  "recommendedAspects": [],
  "draft": {}
}
```

The draft remains saved in KV so the missing values can be supplied later.

### `GET /draft?id=...`

Returns a saved draft from KV.

### `POST /approve`

Accepts:

```json
{ "draftId": "..." }
```

Optional overrides:

```json
{
  "draftId": "...",
  "categoryId": "262222",
  "itemSpecifics": {
    "Brand": "Allen-Bradley",
    "MPN": "1756-IB16",
    "Model": "1756-IB16"
  }
}
```

If `categoryId` is provided, it is used instead of the auto-selected category. If `itemSpecifics` are provided, they are merged over the AI-detected values and validated against eBay's required aspects for the category.

Returns the draft with:

```json
{ "status": "ready_to_publish_later", "publishEnabled": false }
```

No eBay publish APIs are called.

## Category and Item Specifics

The Worker uses the eBay Taxonomy API to choose a category automatically:

```text
GET https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=QUERY
```

The query is built from the draft title, brand, model, MPN, and category hint. The first eBay suggestion is used as the default category.

After a category is selected, the Worker fetches aspect metadata:

```text
GET https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=CATEGORY_ID
```

It then merges AI-detected item specifics with `Brand`, `MPN`, `Model`, and manual overrides. Aspect values are prepared in eBay Inventory API format:

```json
{
  "product": {
    "title": "Allen-Bradley 1756-IB16 Input Module",
    "description": "- Used condition\n- Pulled from working equipment",
    "brand": "Allen-Bradley",
    "mpn": "1756-IB16",
    "aspects": {
      "Brand": ["Allen-Bradley"],
      "MPN": ["1756-IB16"],
      "Model": ["1756-IB16"]
    },
    "imageUrls": []
  }
}
```

This payload is only returned and saved as a draft. The Worker does not call `publishOffer` or any other eBay publishing API.

## Cloudflare Setup

Install dependencies:

```bash
npm install
```

Log in to Cloudflare:

```bash
npx wrangler login
```

Create KV namespaces:

```bash
npx wrangler kv namespace create DRAFT_KV
npx wrangler kv namespace create DRAFT_KV --preview
```

Copy the returned namespace ids into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "DRAFT_KV"
id = "your_production_namespace_id"
preview_id = "your_preview_namespace_id"
```

Add secrets:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
```

`EBAY_MARKETPLACE_ID` defaults to `EBAY_US` in `wrangler.toml`. Change it there if you need a different marketplace.

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

## eBay App Requirements

Create an eBay developer application and use its production client id and client secret. The Worker uses the OAuth `client_credentials` grant with this scope:

```text
https://api.ebay.com/oauth/api_scope
```

The Browse API search call uses:

```text
GET https://api.ebay.com/buy/browse/v1/item_summary/search
```

with the filter:

```text
buyingOptions:{FIXED_PRICE}
```

The Taxonomy API calls use:

```text
GET /commerce/taxonomy/v1/category_tree/0/get_category_suggestions
GET /commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category
```

## iOS Shortcut Usage

Create a Shortcut that:

1. Selects or takes photos.
2. Sends a `POST` request to `https://your-worker.your-subdomain.workers.dev/draft`.
3. Sets the request body to `Form`.
4. Adds each selected photo under the form key `images`.
5. Optionally adds text fields named `notes`, `condition`, and `quantity`.
6. Reads the JSON response and presents it for review.
7. If the response contains `missingRequiredAspects`, asks for those values and sends them back to `/approve` as `itemSpecifics`.

To approve a draft for later publishing, send JSON to `/approve`:

```json
{ "draftId": "the-id-from-draft-response" }
```

To supply missing values or override the category, send:

```json
{
  "draftId": "the-id-from-draft-response",
  "categoryId": "262222",
  "itemSpecifics": {
    "Brand": "Allen-Bradley",
    "MPN": "1756-IB16",
    "Model": "1756-IB16"
  }
}
```

This approval step still does not publish anything to eBay.

## Local Smoke Tests

Status:

```bash
curl http://localhost:8787/
```

Create a draft:

```bash
curl -X POST http://localhost:8787/draft \
  -F "images=@/path/to/photo1.jpg" \
  -F "images=@/path/to/photo2.jpg" \
  -F "notes=Includes box and charger" \
  -F "condition=Used" \
  -F "quantity=1"
```

Fetch a draft:

```bash
curl "http://localhost:8787/draft?id=your-draft-id"
```

Approve for later publishing:

```bash
curl -X POST http://localhost:8787/approve \
  -H "Content-Type: application/json" \
  -d "{\"draftId\":\"your-draft-id\"}"
```
