import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadPublishedManifest,
  PUBLISHED_FILE,
  publishCatalogBody,
  semanticCatalogDigest,
  parseCatalogBody,
} from './lib.mjs';

export function versionFromDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}.${month}.${day}.${date.getTime()}`;
}

async function readCurrentManifest(outputDir) {
  const outputFile = path.join(outputDir, PUBLISHED_FILE);
  try {
    return await loadPublishedManifest(outputFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function runPublisherOnce({
  inputFile,
  privateKeyFile,
  outputDir,
  version,
  now = new Date(),
  minModels = 1,
  maxModelDropRatio = 0.5,
  force = false,
}) {
  const bodyIn = await fs.readFile(inputFile, 'utf8');
  const catalogIn = parseCatalogBody(bodyIn, inputFile);
  const contentDigest = semanticCatalogDigest(catalogIn);
  const current = await readCurrentManifest(outputDir);

  if (current && current.contentDigest === contentDigest) {
    return {
      action: 'unchanged',
      version: current.version,
      contentDigest,
      outputFile: path.join(outputDir, PUBLISHED_FILE),
      catalog: current.catalog,
    };
  }

  if (catalogIn.models.length < minModels) {
    throw new Error(`catalog has ${catalogIn.models.length} models; minimum is ${minModels}`);
  }
  if (current && !force) {
    const currentCount = current.catalog.models.length;
    const nextCount = catalogIn.models.length;
    const dropRatio = currentCount === 0 ? 0 : (currentCount - nextCount) / currentCount;
    if (dropRatio > maxModelDropRatio) {
      throw new Error(
        `refusing to remove ${Math.round(dropRatio * 100)}% of models ` +
        `(${currentCount} -> ${nextCount}); use --force or raise PUBLISHER_MAX_MODEL_DROP_PERCENT`,
      );
    }
  }

  const nextVersion = version ?? versionFromDate(now);
  if (current && nextVersion <= current.version) {
    throw new Error(
      `new version ${nextVersion} must sort after current version ${current.version}`,
    );
  }

  const nextCatalog = {
    ...catalogIn,
    version: nextVersion,
    generatedAt: now.toISOString(),
  };
  const body = `${JSON.stringify(nextCatalog, null, 2)}\n`;
  const published = await publishCatalogBody({
    body,
    privateKeyFile,
    outputDir,
    contentDigest,
  });
  return {
    action: 'published',
    version: nextCatalog.version,
    contentDigest,
    outputFile: published.outputFile,
    catalog: published.catalog,
    manifest: published.manifest,
  };
}
