#!/usr/bin/env node

import fs from 'node:fs/promises';
import { parseCatalogBody } from './lib.mjs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const inputFile = arg('input') ?? process.env.CATALOG_FILE;
const minModels = Number(arg('min-models') ?? process.env.PUBLISHER_MIN_MODELS ?? '1');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage:
  node fork/catalog/src/validate-catalog.mjs [--input catalog.json] [--min-models N]

When --input is omitted, CATALOG_FILE is used.`);
  process.exit(0);
}
if (!inputFile) {
  console.error('validate-catalog: provide --input or CATALOG_FILE');
  process.exit(1);
}
if (!Number.isInteger(minModels) || minModels < 0) {
  console.error('validate-catalog: --min-models must be an integer >= 0');
  process.exit(1);
}

try {
  const body = await fs.readFile(inputFile, 'utf8');
  const catalog = parseCatalogBody(body, inputFile);
  if (catalog.models.length < minModels) {
    throw new Error(`catalog has ${catalog.models.length} models; minimum is ${minModels}`);
  }
  console.log(
    `valid ${catalog.tier} catalog ${catalog.version}: ` +
    `${catalog.models.length} models, ${catalog.quirks.length} quirks`,
  );
} catch (error) {
  console.error(`validate-catalog: ${error.message}`);
  process.exit(1);
}
