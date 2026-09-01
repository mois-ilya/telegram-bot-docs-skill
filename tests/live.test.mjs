import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'refresh.mjs');

function runRefresh(cacheDir, ...args) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--cache-dir', cacheDir, ...args],
    { encoding: 'utf8', timeout: 180_000 },
  );
}

test('live documentation builds completely and rejects a destructive rebuild', { timeout: 360_000 }, () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'telegram-bot-docs-live-'));
  const cacheDir = join(tempRoot, 'cache');

  try {
    const initial = runRefresh(cacheDir, '--max-age', '0');
    assert.equal(initial.error, undefined, initial.error?.message);
    assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`);

    const metaPath = join(cacheDir, 'meta.json');
    assert.ok(existsSync(metaPath), 'live refresh did not create meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.equal(Object.keys(meta).length, 10, 'expected all ten official documentation sources');

    let totalSections = 0;
    for (const [key, entry] of Object.entries(meta)) {
      assert.ok(entry.dir, `${key} has no output directory`);
      assert.ok(Array.isArray(entry.sections) && entry.sections.length > 0, `${key} has no sections`);
      const files = readdirSync(join(cacheDir, entry.dir)).filter((name) => name.endsWith('.md'));
      assert.equal(files.length, entry.sections.length, `${key} section files disagree with metadata`);
      totalSections += entry.sections.length;
    }
    assert.ok(totalSections > 900, `live build produced only ${totalSections} sections`);

    const index = readFileSync(join(cacheDir, 'index.md'), 'utf8');
    assert.match(index, /bot-api\/sendmessage\.md/);
    assert.match(index, /webapps\/validating-data-received-via-the-mini-app\.md/);

    const basics = readFileSync(join(ROOT, 'reference', 'basics.md'), 'utf8');
    const cited = new Set(
      [...basics.matchAll(/`([a-z0-9-]+\/[a-z0-9._-]+\.md)`/g)].map((match) => match[1]),
    );
    const missing = [...cited].filter((path) => {
      const relative = path.startsWith('cache/') ? path.slice('cache/'.length) : path;
      return !existsSync(join(cacheDir, relative));
    });
    assert.deepEqual(missing, [], `reference/basics.md has broken live routes: ${missing.join(', ')}`);

    // Pretend a previous build was much larger. A forced live check must retain
    // the usable cache and report STALE instead of publishing the smaller build.
    const key = Object.keys(meta).find((candidate) => meta[candidate].sectionCount > 20);
    assert.ok(key, 'no sufficiently large source found for shrink-guard verification');
    meta[key].sectionCount *= 5;
    meta[key].hash = 'stale-on-purpose';
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    const guarded = runRefresh(cacheDir, '--max-age', '0');
    assert.equal(guarded.error, undefined, guarded.error?.message);
    assert.match(guarded.stdout, /section count fell from/);
    assert.equal(guarded.status, 2, 'a shrinking build must degrade to STALE, not publish');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
