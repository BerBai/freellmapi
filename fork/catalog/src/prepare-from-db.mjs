#!/usr/bin/env node

import { initDb } from '../../../server/src/db/index.js';
import { getProvider } from '../../../server/src/providers/index.js';
import { OpenAICompatProvider } from '../../../server/src/providers/openai-compat.js';
import { discoverProviderModels } from '../../../server/src/services/model-discovery.js';
import {
  autoRegistrable,
  registerDiscoveredModels,
} from '../../../server/src/services/builtin-model-discovery.js';
import { runCustomModelSync } from '../../../server/src/services/custom-model-sync.js';
import {
  probeModel,
  recordProbeResult,
  selectProbeCandidates,
} from '../../../server/src/services/model-probe.js';
import { decrypt } from '../../../server/src/lib/crypto.js';
import { decryptProxyUrl } from '../../../server/src/lib/key-proxy.js';
import { withKeyProxy } from '../../../server/src/lib/proxy.js';
import {
  isPermanentModelRejection,
  parseNonNegativeInteger,
  resolveDiscoveryPlatforms,
} from './prepare-lib.mjs';

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be a boolean`);
}

function usage() {
  console.log(`Usage: npx tsx fork/catalog/src/prepare-from-db.mjs

Discovers models, syncs custom endpoints, probes routable models, and records
the results in the router SQLite database.

Environment:
  FREEAPI_DB_PATH / PUBLISHER_DB_PATH
                              Database path (defaults to server/data/freeapi.db)
  PREPARE_DISCOVERY_PLATFORMS existing|all|none|<comma-list>
                              Discovery scope, default: existing
  PREPARE_SYNC_CUSTOM         1/0, sync custom OpenAI-compatible endpoints, default: 1
  PREPARE_PROBE_LIMIT         Max models to probe this run, default: 20
  PREPARE_DISABLE_INVALID_DISCOVERED
                              1/0, disable auto-discovered models on a permanent
                              model rejection, default: 1
  PREPARE_STRICT              1/0, fail when any discovery platform fails, default: 0

Only rows with source='discovered' are ever disabled. Catalog, user and
declarative rows are never deleted or disabled by this script.`);
}

function keyRows(db) {
  return db.prepare(`
    SELECT *
      FROM api_keys
     WHERE enabled = 1
       AND status IN ('healthy', 'unknown')
     ORDER BY CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id
  `).all();
}

function modelCount(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM models').get().count;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const dbPath = process.env.PREPARE_DB_PATH?.trim()
    || process.env.PUBLISHER_DB_PATH?.trim()
    || process.env.FREEAPI_DB_PATH?.trim()
    || undefined;
  const db = initDb(dbPath);
  const beforeCount = modelCount(db);
  const keys = keyRows(db);
  const keyByPlatform = new Map();
  for (const key of keys) {
    if (!keyByPlatform.has(key.platform)) keyByPlatform.set(key.platform, key);
  }

  const available = new Set(
    keys
      .map((key) => key.platform)
      .filter((platform) => platform !== 'custom'),
  );
  const existing = new Set(
    db.prepare('SELECT DISTINCT platform FROM models').all().map((row) => row.platform),
  );
  const platforms = resolveDiscoveryPlatforms({
    available,
    existing,
    setting: process.env.PREPARE_DISCOVERY_PLATFORMS ?? 'existing',
  });

  const discovery = {
    requestedPlatforms: platforms,
    platforms: 0,
    discoveredModels: 0,
    added: 0,
    existing: 0,
    tombstoned: 0,
    nonChatSkipped: 0,
    paidSkipped: 0,
    failures: [],
  };

  for (const platform of platforms) {
    const key = keyByPlatform.get(platform);
    if (!key) continue;
    const provider = getProvider(platform);
    if (!(provider instanceof OpenAICompatProvider)) continue;

    discovery.platforms += 1;
    try {
      const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      const discovered = await withKeyProxy(
        decryptProxyUrl(key),
        () => discoverProviderModels(provider, apiKey, provider.name),
      );
      discovery.discoveredModels += discovered.length;

      const filtered = autoRegistrable(discovered, platform);
      discovery.nonChatSkipped += filtered.nonChat;
      discovery.paidSkipped += filtered.paid;
      const registered = registerDiscoveredModels(
        db,
        platform,
        filtered.accepted.map((model) => ({
          modelId: model.id,
          contextWindow: model.contextWindow,
          vision: model.vision,
        })),
        { explicit: false },
      );
      discovery.added += registered.created.length;
      discovery.existing += registered.existing.length;
      discovery.tombstoned += registered.tombstoned.length;

      const updateDiscovered = db.prepare(`
        UPDATE models
           SET context_window = COALESCE(?, context_window),
               supports_vision = CASE WHEN ? = 1 THEN 1 ELSE supports_vision END
         WHERE platform = ? AND model_id = ? AND endpoint_scope = ''
           AND source = 'discovered'
      `);
      for (const model of filtered.accepted) {
        updateDiscovered.run(
          model.contextWindow ?? null,
          model.vision ? 1 : 0,
          platform,
          model.id,
        );
      }

      if (registered.created.length > 0) {
        console.log(`[prepare] ${platform}: +${registered.created.length} model(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      discovery.failures.push({ platform, error: message });
      console.error(`[prepare] ${platform}: discovery failed: ${message}`);
    }
  }

  const custom = { enabled: envFlag('PREPARE_SYNC_CUSTOM', true) };
  if (custom.enabled) {
    try {
      custom.result = await runCustomModelSync(db);
    } catch (error) {
      custom.error = error instanceof Error ? error.message : String(error);
      console.error(`[prepare] custom endpoint sync failed: ${custom.error}`);
    }
  }

  const probeLimit = parseNonNegativeInteger(
    process.env.PREPARE_PROBE_LIMIT,
    20,
    'PREPARE_PROBE_LIMIT',
  );
  const disableInvalid = envFlag('PREPARE_DISABLE_INVALID_DISCOVERED', true);
  const probe = {
    limit: probeLimit,
    candidates: 0,
    working: 0,
    unavailable: 0,
    error: 0,
    disabledDiscovered: 0,
  };

  if (probeLimit > 0) {
    const candidates = selectProbeCandidates(db, probeLimit);
    probe.candidates = candidates.length;
    for (const candidate of candidates) {
      const outcome = await probeModel(candidate);
      recordProbeResult(db, candidate, outcome);
      probe[outcome.status] += 1;
      if (outcome.status === 'unavailable' && disableInvalid && isPermanentModelRejection(outcome.error)) {
        const row = db.prepare('SELECT source FROM models WHERE id = ?').get(candidate.modelDbId);
        if (row?.source === 'discovered') {
          db.prepare('UPDATE models SET enabled = 0 WHERE id = ? AND source = ?')
            .run(candidate.modelDbId, 'discovered');
          probe.disabledDiscovered += 1;
          console.log(
            `[prepare] disabled discovered model ${candidate.platform}/${candidate.modelId}: ${outcome.error}`,
          );
        }
      }
    }
  }

  const afterCount = modelCount(db);
  const summary = {
    database: dbPath ?? '(default)',
    beforeModels: beforeCount,
    afterModels: afterCount,
    discovery,
    custom,
    probe,
  };
  console.log(`[prepare] summary: ${JSON.stringify(summary)}`);

  if (envFlag('PREPARE_STRICT', false) && discovery.failures.length > 0) {
    throw new Error(`${discovery.failures.length} discovery platform(s) failed`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`[prepare] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
