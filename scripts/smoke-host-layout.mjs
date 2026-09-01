#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'telegram-bot-docs';
const HOSTS = {
  'claude-code': (root) => join(root, 'home', '.claude', 'skills', SKILL_NAME),
  codex: (root) => join(root, 'codex-home', 'skills', SKILL_NAME),
  universal: (root) => join(root, 'project', '.agents', 'skills', SKILL_NAME),
};

const hostArg = process.argv.indexOf('--host');
const selected = hostArg === -1 ? Object.keys(HOSTS) : [process.argv[hostArg + 1]];
for (const host of selected) {
  assert.ok(HOSTS[host], `unknown host ${host}; expected ${Object.keys(HOSTS).join(', ')}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

const tempRoot = mkdtempSync(join(tmpdir(), 'telegram-bot-docs-hosts-'));
const npmCache = join(tempRoot, 'npm-cache');
mkdirSync(npmCache, { recursive: true });

try {
  run('npm', ['pack', '--silent', '--pack-destination', tempRoot], {
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_update_notifier: 'false',
    },
  });
  const archives = readdirSync(tempRoot).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, `expected one package archive, found ${archives.length}`);

  for (const host of selected) {
    const installed = HOSTS[host](tempRoot);
    const outsideCwd = join(tempRoot, 'unrelated-working-directory', host);
    mkdirSync(installed, { recursive: true });
    mkdirSync(outsideCwd, { recursive: true });
    run('tar', ['-xzf', join(tempRoot, archives[0]), '-C', installed, '--strip-components=1']);

    for (const path of ['SKILL.md', 'agents/openai.yaml', 'reference/basics.md', 'scripts/refresh.mjs']) {
      assert.ok(existsSync(join(installed, path)), `${host} layout is missing ${path}`);
    }
    const skill = readFileSync(join(installed, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: telegram-bot-docs\n/m);

    const env = {
      PATH: process.env.PATH,
      HOME: host === 'claude-code' ? join(tempRoot, 'home') : join(tempRoot, 'empty-home'),
      CODEX_HOME: host === 'codex' ? join(tempRoot, 'codex-home') : join(tempRoot, 'empty-codex-home'),
      NO_PROXY: '*',
      no_proxy: '*',
    };
    const script = join(installed, 'scripts', 'refresh.mjs');
    const cacheDir = run(process.execPath, [script, '--print-cache-dir'], { cwd: outsideCwd, env });
    const reportedCache = cacheDir.stdout.trim();
    const canonicalReported = join(realpathSync(dirname(reportedCache)), basename(reportedCache));
    const canonicalExpected = join(realpathSync(installed), 'cache');
    assert.equal(canonicalReported, canonicalExpected);
    assert.match(run(process.execPath, [script, '--self-test'], { cwd: outsideCwd, env }).stdout, /self-test passed/);

    console.log(`${host} layout passed: ${installed}`);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
