# eBay Photo Listing Draft Worker

Cloudflare Worker for turning iOS Shortcut photo uploads into private eBay listing drafts. It identifies the item with OpenAI Vision, searches active fixed-price eBay Browse API comps, selects an eBay category with the Taxonomy API, checks required item specifics, suggests a price, stores the draft in KV, and returns JSON for review.

Publishing is deliberately gated. `POST /approve` creates or reuses an unpublished eBay Inventory item and offer draft, but it does not call `publishOffer`.

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
- `ocrText`: text recognized by the Shortcut or another OCR step from labels, plates, stickers, or packaging
- `priceMode`: `fast_sale`, `market`, or `premium`; defaults to `premium`
- `cost`
- `desiredMarginPercent`

The response includes:

- OpenAI item identification
- saved OCR text, when provided
- eBay search query
- active fixed-price Browse API comps
- optional sold comp signals from SerpAPI when `SERPAPI_KEY` is configured
- suggested price from scored active comps, optional sold comps, condition, scarcity, price mode, and margin settings
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

The response also includes a pricing object:

```json
{
  "pricing": {
    "mode": "premium",
    "suggestedPrice": 849.99,
    "lowPrice": 699,
    "medianPrice": 799,
    "highPrice": 899,
    "activeMedian": 799,
    "soldMedian": 825,
    "priceConfidence": 0.82,
    "pricingReason": "Suggested premium price based on 3 exact active comps and 2 sold comps.",
    "pricingWarnings": [],
    "compCount": 5,
    "exactCompCount": 5,
    "activeCompCount": 3,
    "soldCompCount": 2,
    "scarcityAdjustment": 0.1,
    "conditionMultiplier": 1.15,
    "minimumMarginPrice": null,
    "acceptedComps": [],
    "rejectedComps": []
  }
}
```

The top-level `suggestedPrice` is kept for compatibility and matches `pricing.suggestedPrice`.

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
{
  "status": "ebay_offer_draft_created",
  "publishEnabled": false,
  "ebayInventoryItem": {
    "sku": "draft-..."
  },
  "ebayOffer": {
    "offerId": "...",
    "status": "unpublished"
  }
}
```

No eBay publish APIs are called. Repeating `/approve` for a draft that already has an `offerId` reuses the saved offer metadata instead of creating duplicate offers.

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

This payload is returned, saved as a draft, and used by `/approve` to create the eBay Inventory item and unpublished offer. The Worker does not call `publishOffer`.

## eBay Draft Creation

`POST /approve` uses the saved draft to call:

```text
PUT https://api.ebay.com/sell/inventory/v1/inventory_item/{sku}
POST https://api.ebay.com/sell/inventory/v1/offer
```

The offer stays unpublished until you list it in eBay or add a separately gated `publishOffer` step later.

Required for `/approve`:

- `EBAY_TOKEN`: a seller/user OAuth access token with Sell Inventory scope. This is different from the app client-credentials token used for Browse and Taxonomy.

Recommended for offers that are closer to publish-ready:

- `EBAY_MERCHANT_LOCATION_KEY`
- `EBAY_FULFILLMENT_POLICY_ID`
- `EBAY_PAYMENT_POLICY_ID`
- `EBAY_RETURN_POLICY_ID`
- `EBAY_CONTENT_LANGUAGE`, defaults to `en-US`

The current Shortcut uploads raw photos to the Worker for AI identification. eBay Inventory publishing requires HTTPS image URLs, so the created offer may still need images added in eBay unless you extend the flow to host or upload photos and pass `imageUrls`.

## Pricing

The Worker uses layered active eBay Browse API searches instead of a single comp query. Search attempts are made in this order:

1. exact MPN plus brand
2. exact MPN only
3. model plus brand
4. title
5. likely part numbers extracted from OCR text

Each active comp is normalized with item price, shipping when available, total price, condition, seller, category ids, query used, match score, and reject reason. The scorer favors exact MPN/model/brand/category matches and filters out likely wrong comps such as manuals, box-only listings, repair listings, bundles, lots, and conflicting part numbers. `open box` is allowed.

`priceMode` controls the final price:

- `fast_sale`: prices below the reliable median for faster movement.
- `market`: prices close to the reliable median.
- `premium`: defaults to a higher price, with scarcity upside when exact active comps are limited.

Condition adjustments are applied after comp pricing:

- New Sealed: +25%
- New Open Box / Open Box: +15%
- New other: +10%
- Used Tested: baseline
- Used: -5%
- Untested: -25%
- For parts/not working: -60%

If `cost` and `desiredMarginPercent` are provided, the Worker calculates a minimum margin price and will not suggest a lower price. Final prices are rounded to eBay-style endings such as `189.99`, `849.99`, or `1299`.

If `SERPAPI_KEY` is configured, the Worker also searches for sold/completed eBay result signals through SerpAPI. Sold exact comps are weighted highest, then exact active comps, then weaker sold and active comps. If SerpAPI is missing or fails, the draft still succeeds and the issue is recorded in `pricing.pricingWarnings`.

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
npx wrangler secret put EBAY_TOKEN
```

Optional sold comp support:

```bash
npx wrangler secret put SERPAPI_KEY
```

Optional eBay offer setup:

```bash
npx wrangler secret put EBAY_MERCHANT_LOCATION_KEY
npx wrangler secret put EBAY_FULFILLMENT_POLICY_ID
npx wrangler secret put EBAY_PAYMENT_POLICY_ID
npx wrangler secret put EBAY_RETURN_POLICY_ID
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
2. Sends a `POST` request to `https://ebay-prefill-worker.mmarshalleet.workers.dev/draft`.
3. Sets the request body to `Form`.
4. Adds each selected photo under the form key `images`.
5. Optionally adds text fields named `notes`, `condition`, `quantity`, `ocrText`, `priceMode`, `cost`, and `desiredMarginPercent`.
6. Reads the JSON response and presents it for review.
7. If the response contains `missingRequiredAspects`, asks for those values and sends them back to `/approve` as `itemSpecifics`.

For better identification and comp search, add an OCR step in the Shortcut and pass recognized text as `ocrText`. The Worker tells OpenAI to treat OCR as a likely source for catalog numbers, MPNs, model numbers, manufacturer names, voltage, and part numbers, while ignoring obvious serial numbers unless they help identify the product family. The eBay comp search query is built from MPN, model, brand, title, and exact OCR-looking part numbers.

Example Shortcut form fields:

```text
images: selected photos
ocrText: Allen-Bradley 1756-IB16 Input Module CAT NO 1756-IB16
notes: Includes factory box
condition: New Open Box
quantity: 1
priceMode: premium
cost: 125
desiredMarginPercent: 35
```

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
  -F "quantity=1" \
  -F "ocrText=Allen-Bradley 1756-IB16 Input Module CAT NO 1756-IB16" \
  -F "priceMode=premium" \
  -F "cost=125" \
  -F "desiredMarginPercent=35"
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
