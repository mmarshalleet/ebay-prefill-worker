# eBay Photo Listing Draft Worker

Cloudflare Worker for turning iOS Shortcut photo uploads into private eBay listing drafts. It identifies the item with OpenAI Vision, searches active fixed-price eBay Browse API comps, suggests a price, stores the draft in KV, and returns JSON for review.

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
- the KV draft id

### `GET /draft?id=...`

Returns a saved draft from KV.

### `POST /approve`

Accepts:

```json
{ "draftId": "..." }
```

Returns the draft with:

```json
{ "status": "ready_to_publish_later", "publishEnabled": false }
```

No eBay publish APIs are called.

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

## iOS Shortcut Usage

Create a Shortcut that:

1. Selects or takes photos.
2. Sends a `POST` request to `https://your-worker.your-subdomain.workers.dev/draft`.
3. Sets the request body to `Form`.
4. Adds each selected photo under the form key `images`.
5. Optionally adds text fields named `notes`, `condition`, and `quantity`.
6. Reads the JSON response and presents it for review.

To approve a draft for later publishing, send JSON to `/approve`:

```json
{ "draftId": "the-id-from-draft-response" }
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
