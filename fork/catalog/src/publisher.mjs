#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWrite,
  PUBLISHER_STATE_FILE,
} from './lib.mjs';
import { runPublisherOnce } from './publisher-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const defaultIntervalMs = 6 * 60 * 60 * 1000;
const maxCommandOutputBytes = 64 * 1024 * 1024;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function integerEnv(name, fallback, minimum = 1000) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function percentEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number between 0 and 100`);
  }
  return value;
}

function usage() {
  console.log(`Usage:
  node fork/catalog/src/publisher.mjs [options]

Options:
  --input <catalog.json>       Publish an existing catalog without running export
  --private-key <key.pem>      Ed25519 private key (required)
  --out-dir <directory>        Directory for published.json (default: ./data)
  --version <version>          Explicit version; auto-generated when omitted
  --interval-ms <milliseconds> Loop interval (default: 21600000 / 6 hours)
  --once                       Run one cycle and exit
  --force                      Allow a catalog model-count drop above the guard
  --help                       Show this help

Environment:
  PUBLISHER_EXPORT_COMMAND     Command whose stdout is the catalog JSON.
                               Default: npm run export-catalog -w server -- --stdout --tier live
  PUBLISHER_PREPARE_COMMAND    Optional command run before export.
                               Use this for model discovery/probing.
  PUBLISHER_VALIDATE_COMMAND   Optional command run after export. CATALOG_FILE
                               points at the generated catalog.
  PUBLISHER_DB_PATH            Convenience for the default exporter --db argument.
  PUBLISHER_RUN_ON_START       1/0, default 1.
  PUBLISHER_INTERVAL_MS        Loop interval, default 21600000.
  PUBLISHER_VERSION            Explicit version override.
  PUBLISHER_MIN_MODELS         Refuse a catalog below this model count, default 1.
  PUBLISHER_MAX_MODEL_DROP_PERCENT
                               Refuse larger model-count drops, default 50.
`);
}

function runCommand(command, { captureStdout = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;

    const append = (chunk, stream) => {
      const text = chunk.toString();
      outputBytes += chunk.length;
      if (outputBytes > maxCommandOutputBytes) {
        child.kill('SIGTERM');
        reject(new Error(`command output exceeded ${maxCommandOutputBytes} bytes`));
        return;
      }
      if (stream === 'stdout') {
        stdout += text;
        if (!captureStdout) process.stdout.write(text);
      } else {
        stderr += text;
        process.stderr.write(text);
      }
    };

    child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`command failed with ${reason}: ${command}`));
    });
  });
}

async function readPublisherState(stateFile) {
  try {
    return JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writePublisherState(stateFile, patch) {
  const previous = await readPublisherState(stateFile);
  const state = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function buildDefaultExportCommand() {
  const dbPath = process.env.PUBLISHER_DB_PATH?.trim();
  const dbPart = dbPath ? ` --db ${shellQuote(dbPath)}` : '';
  return `npm run export-catalog -w server --${dbPart} --stdout --tier live`;
}

async function runCycle(options) {
  const stateFile = path.join(options.outputDir, PUBLISHER_STATE_FILE);
  let tempFile;

  try {
    let inputFile = options.inputFile;
    if (!inputFile) {
      const prepareCommand = process.env.PUBLISHER_PREPARE_COMMAND?.trim();
      if (prepareCommand) {
        console.log(`[publisher] prepare: ${prepareCommand}`);
        await runCommand(prepareCommand);
      }

      const exportCommand = process.env.PUBLISHER_EXPORT_COMMAND?.trim() || buildDefaultExportCommand();
      console.log(`[publisher] export: ${exportCommand}`);
      const exported = await runCommand(exportCommand, { captureStdout: true });
      if (exported.stdout.trim() === '') {
        throw new Error('export command produced no catalog JSON on stdout');
      }

      await fs.mkdir(options.outputDir, { recursive: true });
      tempFile = path.join(
        options.outputDir,
        `.publisher-export-${process.pid}-${Date.now()}.json`,
      );
      await fs.writeFile(tempFile, exported.stdout, { mode: 0o600 });
      inputFile = tempFile;
    }

    const validateCommand = process.env.PUBLISHER_VALIDATE_COMMAND?.trim();
    if (validateCommand) {
      console.log(`[publisher] validate: ${validateCommand}`);
      await runCommand(validateCommand, { env: { CATALOG_FILE: inputFile } });
    }

    const result = await runPublisherOnce({
      inputFile,
      privateKeyFile: options.privateKeyFile,
      outputDir: options.outputDir,
      version: options.version,
      minModels: options.minModels,
      maxModelDropRatio: options.maxModelDropRatio,
      force: options.force,
    });

    const attemptedAt = new Date().toISOString();
    await writePublisherState(stateFile, {
      status: 'ok',
      action: result.action,
      version: result.version,
      contentDigest: result.contentDigest,
      modelCount: result.catalog.models.length,
      outputFile: result.outputFile,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: attemptedAt,
      lastError: null,
    });

    if (result.action === 'published') {
      console.log(`[publisher] published ${result.version} (${result.catalog.models.length} models)`);
    } else {
      console.log(`[publisher] unchanged; keeping ${result.version}`);
    }
    return result;
  } catch (error) {
    await writePublisherState(stateFile, {
      status: 'error',
      action: 'failed',
      lastAttemptAt: new Date().toISOString(),
      lastError: error.message,
    }).catch(() => {});
    throw error;
  } finally {
    if (tempFile) {
      await fs.rm(tempFile, { force: true });
    }
  }
}

function parseOptions() {
  if (hasFlag('help') || hasFlag('-h')) {
    usage();
    process.exit(0);
  }
  const inputFile = arg('input');
  const privateKeyFile = arg('private-key');
  if (!privateKeyFile) {
    usage();
    throw new Error('--private-key is required');
  }

  const rawInterval = arg('interval-ms');
  const intervalMs = rawInterval === undefined
    ? integerEnv('PUBLISHER_INTERVAL_MS', defaultIntervalMs)
    : Number(rawInterval);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    throw new Error('--interval-ms must be an integer >= 1000');
  }

  return {
    inputFile: inputFile ? path.resolve(inputFile) : undefined,
    privateKeyFile: path.resolve(privateKeyFile),
    outputDir: path.resolve(arg('out-dir') ?? './data'),
    version: arg('version') ?? (process.env.PUBLISHER_VERSION?.trim() || undefined),
    intervalMs,
    minModels: integerEnv('PUBLISHER_MIN_MODELS', 1, 0),
    maxModelDropRatio: percentEnv('PUBLISHER_MAX_MODEL_DROP_PERCENT', 50) / 100,
    force: hasFlag('force'),
    once: hasFlag('once'),
  };
}

async function main() {
  const options = parseOptions();
  const runOnStart = process.env.PUBLISHER_RUN_ON_START !== '0';

  if (options.once) {
    await runCycle(options);
    return;
  }

  let stopped = false;
  let timer = null;
  let running = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(runLoop, options.intervalMs);
    console.log(`[publisher] next run in ${Math.round(options.intervalMs / 1000)}s`);
  };

  const runLoop = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runCycle(options);
    } catch (error) {
      console.error(`[publisher] cycle failed: ${error.message}`);
    } finally {
      running = false;
      schedule();
    }
  };

  const stop = (signal) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    console.log(`[publisher] ${signal}; exiting after the current cycle`);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  if (runOnStart) {
    await runLoop();
  } else {
    schedule();
  }
}

try {
  await main();
} catch (error) {
  console.error(`[publisher] ${error.message}`);
  process.exit(1);
}
