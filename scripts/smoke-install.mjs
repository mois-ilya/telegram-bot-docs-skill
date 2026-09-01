#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'telegram-bot-docs-install-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240_000,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  run('npm', ['pack', '--silent', '--pack-destination', tempRoot]);
  const archives = readdirSync(tempRoot).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, `expected one package archive, found ${archives.length}`);

  run('tar', ['-xzf', join(tempRoot, archives[0]), '-C', tempRoot]);
  const installed = join(tempRoot, 'package');
  for (const path of ['SKILL.md', 'agents/openai.yaml', 'reference/basics.md', 'scripts/refresh.mjs']) {
    assert.ok(existsSync(join(installed, path)), `packed skill is missing ${path}`);
  }

  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'telegram-bot-docs-skill');
  assert.match(pkg.version, /^0\.1\.0-beta\.\d+$/);

  const refresh = run(
    process.execPath,
    [join(installed, 'scripts', 'refresh.mjs'), '--max-age', '0'],
    { cwd: installed },
  );
  assert.match(refresh.stdout, /(?:fresh|refreshed)/);

  const meta = JSON.parse(readFileSync(join(installed, 'cache', 'meta.json'), 'utf8'));
  assert.equal(Object.keys(meta).length, 10);
  const totalSections = Object.values(meta).reduce((sum, entry) => sum + entry.sections.length, 0);
  assert.ok(totalSections > 900, `installed skill produced only ${totalSections} sections`);

  const index = readFileSync(join(installed, 'cache', 'index.md'), 'utf8');
  assert.match(index, /bot-api\/sendmessage\.md/);
  assert.match(index, /webapps\/validating-data-received-via-the-mini-app\.md/);

  console.log(`clean-install smoke test passed (${Object.keys(meta).length} sources, ${totalSections} sections)`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
