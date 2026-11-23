#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { etagForDigest, loadPublishedManifest, PUBLISHED_FILE, PUBLISHER_STATE_FILE } from './lib.mjs';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DATA_DIR = './data';

function normalizeEtag(value) {
  return typeof value === 'string' ? value.replace(/^W\//, '').trim() : '';
}

function etagMatches(header, etag) {
  if (!header) return false;
  return header
    .split(',')
    .map((part) => normalizeEtag(part))
    .some((part) => part === '*' || part === normalizeEtag(etag));
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function methodNotAllowed(res, allow) {
  sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allow });
}

async function loadOrNull(dataFile) {
  try {
    return await loadPublishedManifest(dataFile);
  } catch (error) {
    return { error };
  }
}

export function createCatalogServer({
  dataFile,
  logger = console,
} = {}) {
  if (!dataFile) throw new Error('dataFile is required');

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://catalog.local');
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (requestUrl.pathname === '/health') {
      if (!isRead) {
        methodNotAllowed(res, 'GET, HEAD');
        return;
      }
      const loaded = await loadOrNull(dataFile);
      if (loaded.error) {
        sendJson(res, 503, { status: 'error', error: loaded.error.message });
        return;
      }
      sendJson(res, 200, {
        status: 'ok',
        version: loaded.version,
        tier: loaded.tier,
        generatedAt: loaded.generatedAt,
        sha256: loaded.digest,
      });
      return;
    }

    if (requestUrl.pathname === '/') {
      if (!isRead) {
        methodNotAllowed(res, 'GET, HEAD');
        return;
      }
      sendJson(res, 200, {
        service: 'freellmapi-catalog',
        endpoint: '/v1/latest',
        health: '/health',
        publisher: '/publisher',
      });
      return;
    }

    if (requestUrl.pathname === '/publisher') {
      if (!isRead) {
        methodNotAllowed(res, 'GET, HEAD');
        return;
      }
      const stateFile = path.join(path.dirname(dataFile), PUBLISHER_STATE_FILE);
      try {
        const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        sendJson(res, 200, state);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          sendJson(res, 404, { status: 'never_run' });
          return;
        }
        sendJson(res, 500, { status: 'error', error: 'publisher_state_unreadable' });
      }
      return;
    }

    if (requestUrl.pathname !== '/v1/latest') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (!isRead) {
      methodNotAllowed(res, 'GET, HEAD');
      return;
    }

    const loaded = await loadOrNull(dataFile);
    if (loaded.error) {
      logger.warn?.(`[catalog] ${loaded.error.message}`);
      sendJson(res, 503, { error: 'catalog_unavailable' });
      return;
    }

    const etag = etagForDigest(loaded.digest);
    const since = requestUrl.searchParams.get('since');
    const unchanged = since === loaded.version || etagMatches(req.headers['if-none-match'], etag);

    if (unchanged) {
      res.writeHead(304, {
        ETag: etag,
        'X-Catalog-Version': loaded.version,
        'X-Catalog-Tier': loaded.tier,
        'Cache-Control': 'public, max-age=60, must-revalidate',
      });
      res.end();
      return;
    }

    const bodyBytes = Buffer.from(loaded.body, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': bodyBytes.length,
      ETag: etag,
      'X-Catalog-Signature': loaded.signature,
      'X-Catalog-Version': loaded.version,
      'X-Catalog-Tier': loaded.tier,
      'Cache-Control': 'public, max-age=60, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : bodyBytes);
  });
}

function startFromEnv() {
  const host = process.env.HOST ?? DEFAULT_HOST;
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid PORT: ${process.env.PORT}`);
  }
  const dataDir = path.resolve(process.env.CATALOG_DATA_DIR ?? DEFAULT_DATA_DIR);
  const dataFile = path.resolve(process.env.CATALOG_PUBLISHED_FILE ?? path.join(dataDir, PUBLISHED_FILE));
  const server = createCatalogServer({ dataFile });

  server.listen(port, host, () => {
    const address = server.address();
    const shownPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[catalog] listening on http://${host}:${shownPort}`);
    console.log(`[catalog] serving ${dataFile}`);
  });

  const shutdown = (signal) => {
    console.log(`[catalog] ${signal}; shutting down`);
    server.close((error) => {
      process.exit(error ? 1 : 0);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    startFromEnv();
  } catch (error) {
    console.error(`[catalog] ${error.message}`);
    process.exit(1);
  }
}
