'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-express-package-'));
const consumerRoot = path.join(tempRoot, 'consumer');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const childEnv = { ...process.env };

// `npm publish --dry-run` exports its configuration to lifecycle scripts. The
// consumer test must perform a real nested pack and install even when its
// parent publication is only a dry run.
delete childEnv.npm_config_dry_run;
delete childEnv.NPM_CONFIG_DRY_RUN;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: childEnv,
    ...options
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }

  return result;
}

try {
  fs.mkdirSync(consumerRoot);

  const packResult = run(
    npmCommand,
    ['pack', '--json', '--pack-destination', tempRoot],
    { cwd: projectRoot }
  );
  const packMetadata = JSON.parse(packResult.stdout)[0];
  const tarball = path.join(tempRoot, packMetadata.filename);

  assert.equal(packMetadata.files.some(file => file.path.startsWith('test/')), false);
  assert.equal(packMetadata.files.some(file => file.path.startsWith('.github/')), false);
  assert.equal(packMetadata.files.some(file => file.path.startsWith('examples/')), false);
  assert.equal(packMetadata.files.some(file => file.path === 'docs/api.md'), true);

  run(
    npmCommand,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: consumerRoot }
  );

  const importResult = run(
    process.execPath,
    ['-e', [
      "const middleware = require('ratelimitly-express');",
      "const client = require('ratelimitly-client');",
      "if (typeof middleware !== 'function') throw new Error('default export is not a function');",
      "if (middleware.RClient !== client.RClient) throw new Error('runtime client dependency is not loadable');",
      "const tracker = middleware.latencyTracker('packed-consumer');",
      "if (!Object.isFrozen(tracker)) throw new Error('latency tracker is not immutable');",
      "if (!(middleware.guard(tracker, 10) instanceof client.LatencyGuard)) throw new Error('guard helper is not loadable');",
      "if (!(middleware.latencyBlock(tracker, 1) instanceof client.ServiceLatencyBlock)) throw new Error('latency report helper is not loadable');"
    ].join('')],
    { cwd: consumerRoot }
  );

  assert.equal(importResult.status, 0);
  process.stdout.write(`Packed consumer import passed (${packMetadata.filename}, ${packMetadata.entryCount} files).\n`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
