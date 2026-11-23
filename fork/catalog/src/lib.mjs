import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PUBLISHED_FILE = 'published.json';
export const PUBLISHER_STATE_FILE = 'publisher-state.json';

export function parseCatalogBody(body, source = 'catalog') {
  let catalog;
  try {
    catalog = JSON.parse(body);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  validateCatalog(catalog, source);
  return catalog;
}

export function validateCatalog(catalog, source = 'catalog') {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error(`${source} must be a JSON object`);
  }
  if (typeof catalog.version !== 'string' || catalog.version.trim() === '') {
    throw new Error(`${source}.version must be a non-empty string`);
  }
  if (typeof catalog.generatedAt !== 'string' || catalog.generatedAt.trim() === '') {
    throw new Error(`${source}.generatedAt must be a non-empty string`);
  }
  if (catalog.tier !== 'live' && catalog.tier !== 'monthly') {
    throw new Error(`${source}.tier must be "live" or "monthly"`);
  }
  if (!Array.isArray(catalog.models)) {
    throw new Error(`${source}.models must be an array`);
  }
  if (!Array.isArray(catalog.quirks)) {
    throw new Error(`${source}.quirks must be an array`);
  }
}

export function parsePublishedManifest(raw, source = 'published catalog') {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${source} must be a JSON object`);
  }
  if (typeof manifest.body !== 'string') {
    throw new Error(`${source}.body must be a string`);
  }
  if (typeof manifest.signature !== 'string' || manifest.signature.trim() === '') {
    throw new Error(`${source}.signature must be a non-empty Base64 string`);
  }
  const catalog = parseCatalogBody(manifest.body, `${source}.body`);
  const digest = bodyDigest(manifest.body);
  if (manifest.sha256 !== digest) {
    throw new Error(`${source}.sha256 does not match the signed body`);
  }
  // Recompute from the verified body instead of trusting an unsigned manifest
  // field. The stored value is informational and can be replaced by a future
  // canonicalization without trapping scheduled publishers.
  const contentDigest = semanticCatalogDigest(catalog);
  return {
    ...manifest,
    version: catalog.version,
    tier: catalog.tier,
    generatedAt: catalog.generatedAt,
    contentDigest,
    catalog,
    digest,
  };
}

export async function loadPublishedManifest(file) {
  const raw = await fs.readFile(file, 'utf8');
  return parsePublishedManifest(raw, file);
}

export function bodyDigest(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

export function etagForDigest(digest) {
  return `"sha256-${digest}"`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

/**
 * Digest the parts of a catalog that affect routing. Version and generatedAt
 * intentionally do not participate, so a scheduled exporter run with the same
 * models does not create a new signed release every time.
 */
export function semanticCatalogDigest(catalog) {
  const { version: _version, generatedAt: _generatedAt, ...semantic } = catalog;
  return crypto.createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex');
}

export function signCatalogBody(body, privateKey) {
  return crypto.sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');
}

export function verifyCatalogSignature(body, signature, publicKey) {
  return crypto.verify(
    null,
    Buffer.from(body, 'utf8'),
    publicKey,
    Buffer.from(signature, 'base64'),
  );
}

export function publicKeyEnvValue(publicKeyPem) {
  return publicKeyPem.trim().replace(/\n/g, '\\n');
}

export async function atomicWrite(file, contents, mode = 0o644) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, contents, { mode });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function publishCatalogBody({
  body,
  privateKeyFile,
  outputDir,
  contentDigest = semanticCatalogDigest(parseCatalogBody(body)),
}) {
  const catalog = parseCatalogBody(body);
  const privateKey = await fs.readFile(privateKeyFile, 'utf8');
  const signature = signCatalogBody(body, privateKey);
  const keyObject = crypto.createPrivateKey(privateKey);
  const publicKey = crypto.createPublicKey(keyObject);
  if (!verifyCatalogSignature(body, signature, publicKey)) {
    throw new Error('generated signature failed self-verification');
  }

  const digest = bodyDigest(body);
  const manifest = {
    version: catalog.version,
    tier: catalog.tier,
    generatedAt: catalog.generatedAt,
    contentDigest,
    sha256: digest,
    signature,
    body,
  };
  const outputFile = path.join(outputDir, PUBLISHED_FILE);
  await atomicWrite(outputFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputFile, manifest, catalog };
}

export async function publishCatalog({ inputFile, privateKeyFile, outputDir, contentDigest }) {
  const body = await fs.readFile(inputFile, 'utf8');
  return publishCatalogBody({ body, privateKeyFile, outputDir, contentDigest });
}
