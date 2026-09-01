import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
  assert.ok(match, 'SKILL.md must contain a YAML frontmatter block and a body');

  const frontmatter = match[1];
  const keys = [...frontmatter.matchAll(/^([a-z][a-z0-9-]*):/gm)].map((entry) => entry[1]);
  assert.deepEqual(keys, ['name', 'description'], 'frontmatter must contain only name and description');

  const name = frontmatter.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim();
  const descriptionBlock = frontmatter.match(/^description:\s*>-\n((?: {2,}[^\n]*\n?)*)$/m)?.[1];
  assert.ok(name, 'frontmatter name is missing');
  assert.ok(descriptionBlock, 'description must use a folded YAML block');

  const description = descriptionBlock
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return { name, description, body: match[2] };
}

test('SKILL.md follows the portable Agent Skills contract', () => {
  const { name, description, body } = parseFrontmatter(read('SKILL.md'));

  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(name.length <= 64, `skill name is ${name.length} characters; maximum is 64`);
  assert.ok(description.length <= 1024, `description is ${description.length} characters; maximum is 1024`);
  assert.ok(description.length >= 100, 'description is too short to route the skill reliably');
  assert.ok(body.split('\n').length < 500, 'SKILL.md body should remain below 500 lines');

  for (const hostSpecific of ['~/.claude', '~/.codex', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    assert.doesNotMatch(body, new RegExp(hostSpecific.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('runtime paths in SKILL.md are relocatable and internally consistent', () => {
  const skill = read('SKILL.md');
  const rootPaths = [...skill.matchAll(/<SKILL_ROOT>\/([^\s`)>]+)/g)].map((match) => match[1]);
  assert.ok(rootPaths.includes('scripts/refresh.mjs'));
  assert.ok(rootPaths.includes('reference/basics.md'));
  assert.ok(rootPaths.includes('cache/index.md'));

  for (const path of rootPaths.filter((value) => !value.startsWith('cache/'))) {
    assert.doesNotThrow(() => read(path), `SKILL.md points at missing file ${path}`);
  }

  const cachePaths = [...skill.matchAll(/`((?:cache\/)?[a-z0-9-]+\/[a-z0-9._-]+\.md)`/g)]
    .map((match) => match[1]);
  assert.ok(cachePaths.length >= 10, 'SKILL.md should route concrete documentation sections');
  for (const path of cachePaths) {
    assert.equal(path, path.toLowerCase(), `cache path must be lowercase: ${path}`);
    assert.doesNotMatch(path, /(?:^|\/)\.\.(?:\/|$)/, `cache path escapes the skill root: ${path}`);
  }
});

test('published package is explicit, complete, and excludes generated or development files', () => {
  const packageJson = JSON.parse(read('package.json'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(packageJson[field], undefined, `${field} contradicts the zero-dependency runtime contract`);
  }
  assert.ok(Array.isArray(packageJson.files), 'package.json must define an explicit files allowlist');
  for (const required of ['SKILL.md', 'agents/', 'reference/', 'scripts/refresh.mjs']) {
    assert.ok(packageJson.files.includes(required), `package files allowlist is missing ${required}`);
  }

  const npmCache = mkdtempSync(join(tmpdir(), 'telegram-bot-docs-npm-cache-'));
  try {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_update_notifier: 'false',
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `npm pack failed:\n${result.stdout}\n${result.stderr}`);

    const report = JSON.parse(result.stdout)[0];
    const paths = report.files.map((file) => file.path).sort();
    for (const required of [
      'SKILL.md',
      'agents/openai.yaml',
      'package.json',
      'reference/basics.md',
      'scripts/refresh.mjs',
    ]) {
      assert.ok(paths.includes(required), `published package is missing ${required}`);
    }
    const referencedRuntimePaths = [...read('SKILL.md').matchAll(/<SKILL_ROOT>\/([^\s`)>]+)/g)]
      .map((match) => match[1])
      .filter((path) => !path.startsWith('cache/'));
    for (const path of referencedRuntimePaths) {
      assert.ok(paths.includes(path), `SKILL.md references ${path}, but the published package omits it`);
    }
    for (const path of paths) {
      assert.doesNotMatch(path, /^(?:cache|tests|\.github)\//, `published package leaks ${path}`);
    }
    assert.ok(!paths.includes('scripts/smoke-install.mjs'));
    assert.ok(!paths.includes('scripts/smoke-host-layout.mjs'));
  } finally {
    rmSync(npmCache, { recursive: true, force: true });
  }
});

test('public install examples preserve the portable skill identifier', () => {
  const { name } = parseFrontmatter(read('SKILL.md'));
  const readme = read('README.md');

  assert.equal(name, 'telegram-bot-docs');
  assert.match(readme, new RegExp(`\\.claude/skills/${name}`));
  assert.match(readme, new RegExp(`\\.codex/skills/${name}`));
  assert.match(readme, new RegExp(`\\$${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`));
  assert.match(readme, new RegExp(`/${name}`));
  assert.equal(basename(join('/tmp', name)), name);
});
