import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  etagForDigest,
  loadPublishedManifest,
  publishCatalog,
  verifyCatalogSignature,
} from '../src/lib.mjs';
import { createCatalogServer } from '../src/server.mjs';

let tempDir;
let dataFile;
let publicKeyPem;
let server;
let baseUrl;
let manifest;

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freellmapi-catalog-test-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyFile = path.join(tempDir, 'private-key.pem');
  await fs.writeFile(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const catalog = {
    version: '2026.11.23.1',
    generatedAt: '2026-11-23T10:00:00.000Z',
    tier: 'live',
    models: [],
    quirks: [],
  };
  const inputFile = path.join(tempDir, 'catalog.json');
  await fs.writeFile(inputFile, `${JSON.stringify(catalog, null, 2)}\n`);

  const published = await publishCatalog({
    inputFile,
    privateKeyFile,
    outputDir: tempDir,
  });
  dataFile = published.outputFile;
  manifest = await loadPublishedManifest(dataFile);

  server = createCatalogServer({ dataFile, logger: { warn() {} } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('health reports the published catalog', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '2026.11.23.1');
  assert.equal(body.tier, 'live');
  assert.equal(body.sha256, manifest.digest);
});

test('latest serves the exact signed body', async () => {
  const response = await fetch(`${baseUrl}/v1/latest`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-catalog-version'), manifest.version);
  assert.equal(response.headers.get('x-catalog-tier'), 'live');
  assert.equal(response.headers.get('etag'), etagForDigest(manifest.digest));

  const body = await response.text();
  assert.equal(body, manifest.body);
  assert.equal(
    verifyCatalogSignature(body, response.headers.get('x-catalog-signature'), publicKeyPem),
    true,
  );
});

test('since returns 304 for the current version', async () => {
  const response = await fetch(`${baseUrl}/v1/latest?since=${encodeURIComponent(manifest.version)}`);
  assert.equal(response.status, 304);
  assert.equal(response.headers.get('x-catalog-version'), manifest.version);
});

test('If-None-Match returns 304 for the current ETag', async () => {
  const response = await fetch(`${baseUrl}/v1/latest`, {
    headers: { 'If-None-Match': etagForDigest(manifest.digest) },
  });
  assert.equal(response.status, 304);
});

test('HEAD returns metadata without a body', async () => {
  const response = await fetch(`${baseUrl}/v1/latest`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(manifest.body));
});

test('publisher reports its latest state', async () => {
  await fs.writeFile(
    path.join(tempDir, 'publisher-state.json'),
    JSON.stringify({ status: 'ok', action: 'unchanged', version: manifest.version }),
  );
  const response = await fetch(`${baseUrl}/publisher`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.action, 'unchanged');
  assert.equal(body.version, manifest.version);
});

test('rejects unsupported methods and unknown paths', async () => {
  const post = await fetch(`${baseUrl}/v1/latest`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');

  const missing = await fetch(`${baseUrl}/nope`);
  assert.equal(missing.status, 404);
});
