#!/usr/bin/env node

import path from 'node:path';
import { publishCatalog } from './lib.mjs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function usage(output = console.error) {
  output(`Usage:
  node fork/catalog/src/publish.mjs \\
    --input <catalog.json> \\
    --private-key <private-key.pem> \\
    [--out-dir <directory>]

The input is signed as raw UTF-8 bytes. The directory service serves those
exact bytes and its x-catalog-signature header.`);
}

const inputFile = arg('input');
const privateKeyFile = arg('private-key');
const outputDir = path.resolve(arg('out-dir') ?? './data');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage(console.log);
  process.exit(0);
}
if (!inputFile || !privateKeyFile) {
  usage();
  process.exit(1);
}

try {
  const { outputFile, catalog } = await publishCatalog({ inputFile, privateKeyFile, outputDir });
  console.log(`published ${catalog.tier} catalog ${catalog.version}: ${catalog.models.length} models`);
  console.log(`output: ${outputFile}`);
} catch (error) {
  console.error(`publish failed: ${error.message}`);
  process.exit(1);
}
