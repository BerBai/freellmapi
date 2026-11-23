#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publicKeyEnvValue } from './lib.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node fork/catalog/src/keygen.mjs [--out-dir DIRECTORY] [--force]

Generates an Ed25519 private/public key pair. Existing keys are not replaced
unless --force is supplied.`);
  process.exit(0);
}

const force = process.argv.includes('--force');
const outputDir = path.resolve(arg('out-dir', './keys'));
const privateKeyFile = path.join(outputDir, 'private-key.pem');
const publicKeyFile = path.join(outputDir, 'public-key.pem');
const envFile = path.join(outputDir, 'public-key.env');

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

if (!force && ((await exists(privateKeyFile)) || (await exists(publicKeyFile)))) {
  console.error(`refusing to overwrite existing key files in ${outputDir}; use --force to replace them`);
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
await fs.writeFile(privateKeyFile, privatePem, { mode: 0o600 });
await fs.writeFile(publicKeyFile, publicPem, { mode: 0o644 });
await fs.writeFile(envFile, `CATALOG_PUBKEY=${publicKeyEnvValue(publicPem)}\n`, { mode: 0o644 });

console.log(`private key: ${privateKeyFile}`);
console.log(`public key:  ${publicKeyFile}`);
console.log(`app env:     ${envFile}`);
console.log('\nAdd this public key to the FreeLLMAPI .env file:');
console.log(`CATALOG_PUBKEY=${publicKeyEnvValue(publicPem)}`);
