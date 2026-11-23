# Self-hosted signed catalog

This directory contains the fork-only catalog publisher and HTTP service. It has
no runtime dependencies and uses only Node.js built-ins.

The service intentionally separates two roles:

- **Publisher:** owns the Ed25519 private key, signs the catalog, and writes an
  atomic `published.json` manifest.
- **Catalog server:** only reads `published.json` and serves the exact signed
  bytes. It never needs the private key.

## 1. Generate a signing key

```bash
node fork/catalog/src/keygen.mjs --out-dir fork/catalog/keys
```

Files created:

- `private-key.pem`: keep offline or on the publishing host only; never commit.
- `public-key.pem`: public verification key.
- `public-key.env`: ready-to-copy `CATALOG_PUBKEY` value.

## 2. Produce a catalog JSON

The upstream exporter can produce a catalog from the router database:

```bash
npm run export-catalog -w server -- \
  --db /path/to/freeapi.db \
  --out /tmp/catalog.json \
  --tier live \
  --version 2026.11.23.1
```

Use a version that increases whenever the content changes. `tier` is metadata;
the quality and freshness of the catalog depend on the data you publish.

## 3. Sign and publish

```bash
node fork/catalog/src/publish.mjs \
  --input /tmp/catalog.json \
  --private-key fork/catalog/keys/private-key.pem \
  --out-dir fork/catalog/data
```

The publisher writes `data/published.json` atomically. The signature covers the
exact catalog body stored in that file.

## 4. Run the automatic publisher

The publisher can run once from cron/systemd or stay resident and poll on an
interval. It only signs a new release when routing content changes; changes to
`version` or `generatedAt` alone do not create a new catalog.

```bash
# One cycle: run export -> validate -> sign -> publish
node fork/catalog/src/publisher.mjs \
  --private-key fork/catalog/keys/private-key.pem \
  --out-dir fork/catalog/data \
  --once

# Resident loop, every 6 hours by default
node fork/catalog/src/publisher.mjs \
  --private-key fork/catalog/keys/private-key.pem \
  --out-dir fork/catalog/data
```

The default export command is:

```bash
npm run export-catalog -w server -- --stdout --tier live
```

A template is available at `.env.publisher.example`.

Useful environment variables:

| Variable | Purpose |
|---|---|
| `PUBLISHER_EXPORT_COMMAND` | Command whose stdout is the unsigned catalog JSON |
| `PUBLISHER_PREPARE_COMMAND` | Optional model discovery/probe command run before export |
| `PUBLISHER_VALIDATE_COMMAND` | Optional validation command; `CATALOG_FILE` is set |
| `PUBLISHER_DB_PATH` | Adds `--db <path>` to the default exporter command |
| `PUBLISHER_INTERVAL_MS` | Loop interval, default 6 hours |
| `PUBLISHER_RUN_ON_START` | `1`/`0`; run immediately before the first interval |
| `PUBLISHER_MIN_MODELS` | Refuse catalogs below this count, default `1` |
| `PUBLISHER_MAX_MODEL_DROP_PERCENT` | Refuse larger model-count drops, default `50` |

Example with a model preparation and validation hook:

```bash
PUBLISHER_PREPARE_COMMAND='./scripts/your-model-refresh.sh' \
PUBLISHER_VALIDATE_COMMAND='node fork/catalog/src/validate-catalog.mjs' \
node fork/catalog/src/publisher.mjs \
  --private-key fork/catalog/keys/private-key.pem \
  --out-dir fork/catalog/data \
  --once
```

The `prepare` hook is where you connect your own discovery/probe pipeline. The
publisher does not invent model facts and does not silently publish an empty or
suddenly mass-deleted catalog.

## 5. Run the catalog server

```bash
CATALOG_DATA_DIR=fork/catalog/data node fork/catalog/src/server.mjs
```

Endpoints:

```text
GET /health
GET /publisher
GET /v1/latest
GET /v1/latest?since=<version>
HEAD /v1/latest
```

`/v1/latest` returns:

- `Content-Type: application/json`
- `ETag: "sha256-..."`
- `X-Catalog-Signature: <Ed25519 signature in Base64>`
- `X-Catalog-Version: <version>`
- `X-Catalog-Tier: live|monthly`

The exact response bytes are the bytes covered by the signature. A request with
a matching `since` or `If-None-Match: <ETag>` receives `304 Not Modified`.

## 6. Configure FreeLLMAPI

```env
CATALOG_BASE_URL=http://127.0.0.1:8787
CATALOG_PUBKEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
```

`CATALOG_PUBKEY` must match the private key used by the publisher. When the
router and catalog service run in different containers, use a reachable service
name or host address instead of `127.0.0.1`.

## Docker

```bash
cd fork/catalog
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

By default Compose publishes the service only on loopback. Set
`CATALOG_BIND=0.0.0.0` only when the service needs to be reached from another
host and the endpoint is protected by your network policy.

## Tests

```bash
cd fork/catalog
npm test
```
