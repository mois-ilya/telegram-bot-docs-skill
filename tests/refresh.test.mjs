import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'refresh.mjs');

test('CLI help is offline and documents portable cache options', () => {
  const output = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(output, /--cache-dir <path>/);
  assert.match(output, /--print-cache-dir/);
});

test('unknown CLI options fail instead of silently refreshing', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--not-an-option'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option/);
});

test('converter regression checks pass without network access', () => {
  const output = execFileSync(process.execPath, [SCRIPT, '--self-test'], { encoding: 'utf8' });
  assert.match(output, /self-test passed/);
});

test('cold start creates a missing cache directory', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'telegram-docs-test-'));
  const cacheDir = join(tempRoot, 'missing', 'cache');
  try {
    execFileSync(process.execPath, [SCRIPT, '--cache-dir', cacheDir, '--self-test']);
    assert.ok(existsSync(cacheDir));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('default cache directory resolves next to the installed skill', () => {
  const output = execFileSync(process.execPath, [SCRIPT, '--print-cache-dir'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(output, join(ROOT, 'cache'));
});

test('existing generated cache is internally consistent when present', () => {
  const metaPath = join(ROOT, 'cache', 'meta.json');
  if (!existsSync(metaPath)) return;

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  for (const [key, entry] of Object.entries(meta)) {
    const dir = key === 'botapi' ? 'bot-api' : key === 'webapps' ? 'webapps' : null;
    if (!dir || !Array.isArray(entry.sections)) continue;
    const files = new Set(readdirSync(join(ROOT, 'cache', dir)).filter((name) => name.endsWith('.md')));
    assert.equal(files.size, entry.sections.length);
    for (const section of entry.sections) assert.ok(files.has(`${section.anchor}.md`));
  }
});
