import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  loadPublishedManifest,
  PUBLISHED_FILE,
  semanticCatalogDigest,
  verifyCatalogSignature,
} from '../src/lib.mjs';
import { runPublisherOnce, versionFromDate } from '../src/publisher-lib.mjs';

let tempDir;
let inputFile;
let privateKeyFile;
let outputDir;
let publicKeyPem;

function catalog(models = []) {
  return {
    version: 'source-version',
    generatedAt: '2000-01-01T00:00:00.000Z',
    tier: 'live',
    models,
    quirks: [],
  };
}

async function writeInput(models) {
  await fs.writeFile(inputFile, `${JSON.stringify(catalog(models), null, 2)}\n`);
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freellmapi-publisher-test-'));
  inputFile = path.join(tempDir, 'catalog.json');
  outputDir = path.join(tempDir, 'data');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  privateKeyFile = path.join(tempDir, 'private-key.pem');
  await fs.writeFile(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
});

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('publishes a full snapshot and then skips unchanged content', async () => {
  await writeInput([{ platform: 'groq', modelId: 'one' }]);
  const first = await runPublisherOnce({
    inputFile,
    privateKeyFile,
    outputDir,
    now: new Date('2026-11-23T10:00:00.000Z'),
  });
  assert.equal(first.action, 'published');
  assert.equal(first.version, versionFromDate(new Date('2026-11-23T10:00:00.000Z')));
  assert.equal(first.contentDigest, semanticCatalogDigest(catalog([{ platform: 'groq', modelId: 'one' }])));

  const manifest = await loadPublishedManifest(path.join(outputDir, PUBLISHED_FILE));
  assert.equal(manifest.version, first.version);
  assert.equal(manifest.contentDigest, first.contentDigest);
  assert.equal(
    verifyCatalogSignature(manifest.body, manifest.signature, publicKeyPem),
    true,
  );

  await fs.writeFile(inputFile, `${JSON.stringify({
    ...catalog([{ platform: 'groq', modelId: 'one' }]),
    version: 'another-source-version',
    generatedAt: '2026-11-23T10:30:00.000Z',
  }, null, 2)}\n`);

  const second = await runPublisherOnce({
    inputFile,
    privateKeyFile,
    outputDir,
    now: new Date('2026-11-23T11:00:00.000Z'),
  });
  assert.equal(second.action, 'unchanged');
  assert.equal(second.version, first.version);

  const unchangedManifest = await loadPublishedManifest(path.join(outputDir, PUBLISHED_FILE));
  assert.equal(unchangedManifest.sha256, manifest.sha256);
});

test('publishes a new version when routing content changes', async () => {
  await writeInput([{ platform: 'groq', modelId: 'two' }]);
  const published = await runPublisherOnce({
    inputFile,
    privateKeyFile,
    outputDir,
    now: new Date('2026-11-23T12:00:00.000Z'),
  });
  assert.equal(published.action, 'published');
  assert.equal(published.version, versionFromDate(new Date('2026-11-23T12:00:00.000Z')));
  assert.equal(published.catalog.models[0].modelId, 'two');
});

test('guards against accidental mass model deletion', async () => {
  const guardDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freellmapi-publisher-guard-'));
  const guardInput = path.join(guardDir, 'catalog.json');
  const guardOutput = path.join(guardDir, 'data');
  try {
    const four = [1, 2, 3, 4].map((n) => ({ platform: 'groq', modelId: `model-${n}` }));
    await fs.writeFile(guardInput, `${JSON.stringify(catalog(four), null, 2)}\n`);
    await runPublisherOnce({
      inputFile: guardInput,
      privateKeyFile,
      outputDir: guardOutput,
      now: new Date('2026-11-23T13:00:00.000Z'),
      minModels: 0,
    });

    await fs.writeFile(guardInput, `${JSON.stringify(catalog([four[0]]), null, 2)}\n`);
    await assert.rejects(
      runPublisherOnce({
        inputFile: guardInput,
        privateKeyFile,
        outputDir: guardOutput,
        now: new Date('2026-11-23T14:00:00.000Z'),
        minModels: 0,
      }),
      /refusing to remove 75% of models/,
    );

    const forced = await runPublisherOnce({
      inputFile: guardInput,
      privateKeyFile,
      outputDir: guardOutput,
      now: new Date('2026-11-23T15:00:00.000Z'),
      minModels: 0,
      force: true,
    });
    assert.equal(forced.action, 'published');
    assert.equal(forced.catalog.models.length, 1);
  } finally {
    await fs.rm(guardDir, { recursive: true, force: true });
  }
});

test('rejects an explicit version that does not advance', async () => {
  const current = await loadPublishedManifest(path.join(outputDir, PUBLISHED_FILE));
  await writeInput([{ platform: 'groq', modelId: 'three' }]);
  await assert.rejects(
    runPublisherOnce({
      inputFile,
      privateKeyFile,
      outputDir,
      version: current.version,
    }),
    /must sort after current version/,
  );
});
