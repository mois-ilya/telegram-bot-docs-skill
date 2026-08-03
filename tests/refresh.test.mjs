import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('whole saved pages convert to their recorded output', () => {
  // End-to-end over real markup, offline. The self-test above only covers
  // fragments someone thought to write down; every converter defect found so far
  // came from markup nobody anticipated, which is what a frozen real page holds.
  const output = execFileSync(process.execPath, [SCRIPT, '--golden'], { encoding: 'utf8' });
  assert.match(output, /webhooks\.html matches/);
  assert.match(output, /payments\.html matches/);
});

test('page text before the first anchored heading is published, not dropped', () => {
  // The splitter used to start at the first anchor, silently discarding the
  // intro of every page — 5196 characters in total, including the getUpdates vs
  // setWebhook comparison that opens the webhooks guide.
  const golden = readFileSync(join(ROOT, 'tests', 'fixtures', 'webhooks.golden.md'), 'utf8');
  assert.match(golden, /^=== _intro \| section \|/);
  assert.match(golden, /getUpdates.+setWebhook/);
});

test('the cache records which converter built it', () => {
  // Freshness that tracks only upstream would keep a cache built by an older,
  // buggier converter marked fresh forever. Every fix this session needed a
  // manual --force precisely because this field did not exist.
  const metaPath = join(ROOT, 'cache', 'meta.json');
  if (!existsSync(metaPath)) return;

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const script = readFileSync(SCRIPT);
  const expected = createHash('sha256').update(script).digest('hex').slice(0, 16);
  for (const [key, entry] of Object.entries(meta)) {
    if (!entry.dir) continue;
    assert.equal(entry.converter, expected, `${key} was built by a different converter`);
  }
});

test('a closed stdout does not leave the lock behind', () => {
  // Piping into `head` used to raise an unhandled EPIPE, killing the run with
  // the lock directory still in place; every invocation for the next five
  // minutes then reported STALE and the agent passed that on to the user as a
  // failed verification that had in fact just succeeded.
  const tempRoot = mkdtempSync(join(tmpdir(), 'telegram-docs-test-'));
  const cacheDir = join(tempRoot, 'cache');
  try {
    const result = spawnSync(
      'sh',
      ['-c', `"${process.execPath}" "${SCRIPT}" --cache-dir "${cacheDir}" --help | head -1`],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(cacheDir, '.refresh-lock')), false, 'lock directory leaked');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('an interrupted directory swap is recovered before meta is read', () => {
  // The recovery used to live inside the swap itself, which only runs after a
  // successful download and conversion — so offline, a complete cache sitting
  // in <dir>.backup was invisible and the run reported FATAL beside intact data.
  const tempRoot = mkdtempSync(join(tmpdir(), 'telegram-docs-test-'));
  const cacheDir = join(tempRoot, 'cache');
  try {
    mkdirSync(join(cacheDir, 'bot-api.backup'), { recursive: true });
    writeFileSync(join(cacheDir, 'bot-api.backup', 'sendmessage.md'), '# sendMessage\n');
    writeFileSync(join(cacheDir, 'meta.json.backup'), '{"botapi":{"dir":"bot-api"}}\n');
    execFileSync(process.execPath, [SCRIPT, '--cache-dir', cacheDir, '--self-test']);
    assert.ok(existsSync(join(cacheDir, 'bot-api', 'sendmessage.md')), 'section dir not restored');
    assert.ok(existsSync(join(cacheDir, 'meta.json')), 'meta.json not restored');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a build that loses most of its sections is refused, not published', () => {
  // The documentation only grows. When the Mini Apps page had its sub-headings
  // demoted one level, 107 sections became 15 and were published as `refreshed`
  // because 15 cleared the absolute floor of 10 — every method and type file on
  // that page would have vanished while the run reported success.
  const metaPath = join(ROOT, 'cache', 'meta.json');
  if (!existsSync(metaPath)) return;

  const tempRoot = mkdtempSync(join(tmpdir(), 'telegram-docs-test-'));
  const cacheDir = join(tempRoot, 'cache');
  try {
    cpSync(join(ROOT, 'cache'), cacheDir, { recursive: true });
    const meta = JSON.parse(readFileSync(join(cacheDir, 'meta.json'), 'utf8'));
    const key = Object.keys(meta).find((k) => meta[k].sectionCount > 20);
    if (!key) return;
    // Claim the previous build was far larger, then force a live re-check.
    meta[key].sectionCount *= 5;
    meta[key].hash = 'stale-on-purpose';
    writeFileSync(join(cacheDir, 'meta.json'), JSON.stringify(meta, null, 2));

    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--cache-dir', cacheDir, '--max-age', '0'],
      { encoding: 'utf8' },
    );
    assert.match(result.stdout, /section count fell from/);
    assert.equal(result.status, 2, 'a shrinking build must degrade to STALE, not publish');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
  const checked = [];
  for (const [key, entry] of Object.entries(meta)) {
    // The refresh writes `dir` into every entry it produces. Deriving it here
    // instead of hardcoding a key->dir map means a newly added source is
    // actually verified rather than silently skipped.
    const dir = entry.dir;
    if (!dir || !Array.isArray(entry.sections)) continue;
    const files = new Set(readdirSync(join(ROOT, 'cache', dir)).filter((name) => name.endsWith('.md')));
    assert.equal(files.size, entry.sections.length, `section count mismatch for ${key}`);
    for (const section of entry.sections) {
      assert.ok(files.has(`${section.anchor}.md`), `missing ${dir}/${section.anchor}.md`);
    }
    checked.push(key);
  }
  // A meta.json that exists but yielded nothing to verify means the entries lost
  // their `dir` field — the assertions above would vacuously pass.
  assert.ok(checked.length > 0, 'meta.json present but no source could be verified');
});

test('every cache path cited by reference/basics.md exists', () => {
  const basicsPath = join(ROOT, 'reference', 'basics.md');
  if (!existsSync(basicsPath) || !existsSync(join(ROOT, 'cache', 'meta.json'))) return;

  // basics.md is hand-maintained and not freshness-checked, so it rots silently
  // when upstream renames an anchor. Routing a reader to a file that no longer
  // exists is worse than not routing at all — fail loudly instead.
  const cited = new Set(
    [...readFileSync(basicsPath, 'utf8').matchAll(/`([a-z0-9-]+\/[a-z0-9._-]+\.md)`/g)].map((m) => m[1]),
  );
  assert.ok(cited.size > 10, 'basics.md cites suspiciously few cache paths');
  // Section paths are written relative to cache/; a path that already names
  // cache/ (such as the index itself) is relative to the skill root.
  const missing = [...cited].filter(
    (p) => !existsSync(p.startsWith('cache/') ? join(ROOT, p) : join(ROOT, 'cache', p)),
  );
  assert.deepEqual(missing, [], `basics.md points at non-existent cache files: ${missing.join(', ')}`);
});

test('every configured source is represented in the generated cache', () => {
  const metaPath = join(ROOT, 'cache', 'meta.json');
  if (!existsSync(metaPath)) return;

  const script = readFileSync(join(ROOT, 'scripts', 'refresh.mjs'), 'utf8');
  const table = script.slice(script.indexOf('const SOURCES = ['), script.indexOf('// --- HTML'));
  const keys = [...table.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 2, 'could not parse the SOURCES table');

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  for (const key of keys) {
    assert.ok(meta[key]?.sections?.length, `source "${key}" has no cached sections`);
  }
});
