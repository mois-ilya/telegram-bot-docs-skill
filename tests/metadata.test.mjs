import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('public identity is consistent across package, skill, UI, and README', () => {
  const pkg = JSON.parse(read('package.json'));
  const skill = read('SKILL.md');
  const ui = read('agents/openai.yaml');
  const readme = read('README.md');

  assert.equal(pkg.name, 'telegram-bot-docs-skill');
  assert.match(pkg.version, /^0\.1\.0-beta\.\d+$/);
  assert.match(skill, /^---\nname: telegram-bot-docs\n/m);
  assert.match(ui, /display_name: "Telegram Bot Docs"/);
  assert.match(ui, /\$telegram-bot-docs/);
  assert.match(readme, /^# telegram-bot-docs-skill$/m);
  assert.match(readme, /github\.com\/mois-ilya\/telegram-bot-docs-skill\.git/);
  assert.match(readme, /~\/\.codex\/skills\/telegram-bot-docs\//);
  assert.match(readme, /~\/\.claude\/skills\/telegram-bot-docs/);
  assert.match(readme, /\$telegram-bot-docs/);
  assert.match(readme, /\/telegram-bot-docs/);
});
