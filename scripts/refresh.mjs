#!/usr/bin/env node
/**
 * telegram-bot-docs cache refresher.
 *
 * Downloads the official Telegram Bot API and Mini Apps documentation pages,
 * verifies freshness against the local cache (sha256 of the documentation
 * content region), and when the content changed, re-splits the pages into
 * per-section markdown files plus a searchable index.
 *
 * Freshness model: Telegram serves these pages with `cache-control: no-store`
 * and no ETag/Last-Modified, so the only way to check freshness IS a full
 * download (~800 KB, ~1.5 s). That is cheap enough to do on every use, but a
 * TTL (default 24 h) skips even that when the cache was verified recently.
 * Note the resulting contract: "fresh (cached, TTL not expired)" means
 * "verified within the TTL window", not "verified this instant".
 *
 * Usage:
 *   node refresh.mjs                  # check (network only if TTL expired)
 *   node refresh.mjs --force          # ignore TTL, always re-download
 *   node refresh.mjs --max-age 3600   # custom TTL in seconds (0 = always)
 *
 * Exit codes: 0 = cache verified fresh (or refreshed); 2 = cache is usable
 * but could not be verified right now (network down, page layout changed, or
 * another refresh is in progress) — callers must disclose this; 1 = hard
 * error (at least one source has no usable cache; every source is still
 * attempted before exiting).
 *
 * Concurrency/durability: a lock directory prevents two refreshes from
 * clobbering each other; section directories are staged in a temp dir and
 * atomically swapped in; meta.json/index.md are persisted after each source
 * so a failure in the second source never orphans the first one's files.
 *
 * No dependencies. Requires Node >= 20 (global fetch).
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILL_ROOT = join(dirname(SCRIPT_PATH), '..');
const DEFAULT_CACHE_DIR = join(SKILL_ROOT, 'cache');
const DEFAULT_MAX_AGE_S = 86_400; // 24 h
const FIXTURE_DIR = join(SKILL_ROOT, 'tests', 'fixtures');

// "Fresh" cannot mean only "upstream is unchanged": a cache built by an earlier,
// buggier converter would then stay fresh forever. Hashing this file makes any
// edit to the converter invalidate every cached page automatically, so applying
// a fix never depends on someone remembering to pass --force. A rebuild costs
// ~1.5 s per page, which is cheap enough that invalidating on a comment change
// is not worth avoiding.
const CONVERTER_HASH = createHash('sha256').update(readFileSync(SCRIPT_PATH)).digest('hex').slice(0, 16);

// --- CLI args ---------------------------------------------------------------

function usage() {
  return `Usage: node refresh.mjs [options]

Options:
  --force               Rebuild even when the remote content hash is unchanged
  --max-age <seconds>   Cache verification TTL (default: 86400; 0 = always check)
  --cache-dir <path>    Generated cache directory (default: <skill>/cache)
  --print-cache-dir     Print the resolved cache directory and exit
  --self-test           Run offline converter regression checks and exit
  --golden              Convert the saved test fixtures offline and diff against
                        their recorded output; exit non-zero on any difference
  --update-golden       Re-record the fixture output after an intended change
  -h, --help            Show this help and exit`;
}

const args = process.argv.slice(2);
let force = false;
let maxAgeS = DEFAULT_MAX_AGE_S;
let cacheDirArg = DEFAULT_CACHE_DIR;
let printCacheDir = false;
let selfTest = false;
let golden = false;
let updateGolden = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--force') {
    force = true;
  } else if (arg === '--max-age') {
    const value = args[++i];
    maxAgeS = Number(value);
    if (value === undefined || !Number.isFinite(maxAgeS) || maxAgeS < 0) {
      console.error('error: --max-age must be followed by a non-negative number of seconds');
      process.exit(1);
    }
  } else if (arg === '--cache-dir') {
    const value = args[++i];
    if (!value) {
      console.error('error: --cache-dir must be followed by a path');
      process.exit(1);
    }
    cacheDirArg = value;
  } else if (arg === '--print-cache-dir') {
    printCacheDir = true;
  } else if (arg === '--self-test') {
    selfTest = true;
  } else if (arg === '--golden') {
    golden = true;
  } else if (arg === '--update-golden') {
    golden = true;
    updateGolden = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log(usage());
    process.exit(0);
  } else {
    console.error(`error: unknown option ${arg}\n\n${usage()}`);
    process.exit(1);
  }
}

const CACHE_DIR = resolve(cacheDirArg);
if (printCacheDir) {
  console.log(CACHE_DIR);
  process.exit(0);
}

// A published installation contains only cache/.gitkeep, and callers may also
// point --cache-dir at a path that does not exist yet. Cold start must create it
// before the lock directory is acquired.
mkdirSync(CACHE_DIR, { recursive: true });

const META_PATH = join(CACHE_DIR, 'meta.json');
const INDEX_PATH = join(CACHE_DIR, 'index.md');
const LOCK_DIR = join(CACHE_DIR, '.refresh-lock');
const LOCK_STALE_MS = 300_000; // a crashed run's lock is taken over after 5 min

// `prose: true` marks guide pages that contain no API methods/types: every
// section is classified as plain 'section' (changelog dates excepted), so the
// camelCase/PascalCase heading heuristic cannot mislabel prose headings like
// "Commands" or "Keyboards" as types. `min` overrides the default minimum
// section count guard for legitimately small pages.
const SOURCES = [
  {
    key: 'botapi',
    label: 'Bot API',
    url: 'https://core.telegram.org/bots/api',
    dir: 'bot-api',
  },
  {
    key: 'webapps',
    label: 'Mini Apps',
    url: 'https://core.telegram.org/bots/webapps',
    dir: 'webapps',
  },
  {
    key: 'features',
    label: 'Bot Features',
    url: 'https://core.telegram.org/bots/features',
    dir: 'features',
    prose: true,
  },
  {
    key: 'changelog',
    label: 'API Changelog',
    url: 'https://core.telegram.org/bots/api-changelog',
    dir: 'changelog',
    prose: true,
  },
  {
    key: 'webhooks',
    label: 'Webhooks Guide',
    url: 'https://core.telegram.org/bots/webhooks',
    dir: 'webhooks',
    prose: true,
  },
  {
    key: 'payments',
    label: 'Payments',
    url: 'https://core.telegram.org/bots/payments',
    dir: 'payments',
    prose: true,
  },
  {
    key: 'stars',
    label: 'Payments via Stars',
    url: 'https://core.telegram.org/bots/payments-stars',
    dir: 'payments-stars',
    prose: true,
  },
  {
    key: 'inline',
    label: 'Inline Mode',
    url: 'https://core.telegram.org/bots/inline',
    dir: 'inline',
    prose: true,
    min: 4,
  },
  {
    key: 'games',
    label: 'Games',
    url: 'https://core.telegram.org/bots/games',
    dir: 'games',
    prose: true,
    min: 5,
  },
  {
    key: 'faq',
    label: 'Bot FAQ',
    url: 'https://core.telegram.org/bots/faq',
    dir: 'faq',
    prose: true,
  },
];

/**
 * Reinstate anything left behind by a replacement that was interrupted between
 * its two renames. This recovery used to live inside replaceWithRollback, which
 * only runs after a successful download and conversion — so offline, a complete
 * cache sitting in `<dir>.backup` was invisible and the run reported FATAL with
 * the real data intact beside it.
 *
 * Runs before meta.json is read, since the only good copy of it may itself be a
 * backup, and an empty meta makes every source look uncached.
 */
function recoverBackups() {
  const targets = [...SOURCES.map((s) => join(CACHE_DIR, s.dir)), META_PATH, INDEX_PATH];
  for (const target of targets) {
    const backup = `${target}.backup`;
    if (!existsSync(backup)) continue;
    try {
      if (existsSync(target)) rmSync(backup, { recursive: true, force: true });
      else renameSync(backup, target);
    } catch {
      // A read-only cache cannot be repaired; the guards still report honestly
      // on whatever is readable.
    }
  }
}
recoverBackups();

// --- HTML → markdown --------------------------------------------------------

// An unlisted entity used to survive as its literal source text, and no ratio
// guard could notice: "&hellip;" counts as the six letters "hellip" on both the
// HTML and the Markdown side, so fidelity reads a perfect 1.000 while the cache
// shows readers a raw entity.
const ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&raquo;': '»', '&laquo;': '«', '&mdash;': '—', '&ndash;': '–',
  '&hellip;': '…', '&lsquo;': '‘', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”',
  '&times;': '×', '&divide;': '÷', '&plusmn;': '±', '&deg;': '°', '&middot;': '·',
  '&bull;': '•', '&dagger;': '†', '&sect;': '§', '&para;': '¶', '&copy;': '©',
  '&reg;': '®', '&trade;': '™', '&euro;': '€', '&pound;': '£', '&yen;': '¥',
  '&cent;': '¢', '&larr;': '←', '&rarr;': '→', '&uarr;': '↑', '&darr;': '↓',
  '&harr;': '↔', '&ne;': '≠', '&le;': '≤', '&ge;': '≥', '&minus;': '−',
  '&frac12;': '½', '&frac14;': '¼', '&frac34;': '¾', '&sup2;': '²', '&sup3;': '³',
  '&alpha;': 'α', '&beta;': 'β', '&infin;': '∞', '&ensp;': ' ', '&emsp;': ' ',
  '&thinsp;': ' ', '&shy;': '', '&zwj;': '‍', '&zwnj;': '‌',
};

function decodeEntities(s) {
  // Never emit C0 control characters (except \t \n \r): a literal &#0;/&#1;/
  // &#2; in the page could otherwise forge the placeholder sentinels used in
  // inlineToMd. Also reject out-of-range/surrogate codepoints instead of
  // letting String.fromCodePoint throw mid-refresh.
  const cp = (n) =>
    n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff))
      ? String.fromCodePoint(n)
      : '';
  return s
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => cp(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m] ?? m);
}

function markdownCodeSpan(value) {
  // Inline Markdown code cannot safely contain a physical newline. Telegram
  // uses entities such as &#10; when documenting separator characters, so keep
  // their meaning visible instead of producing malformed multi-line spans.
  const singleLine = value.replace(/\r\n?|\n/g, '\\n');
  const longestRun = Math.max(0, ...[...singleLine.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longestRun + 1);
  // CommonMark requires a space pad when the content starts/ends with a backtick.
  const pad = singleLine.startsWith('`') || singleLine.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${singleLine}${pad}${fence}`;
}

// --- HTML tokenizer and tree --------------------------------------------------

/*
 * The converter used to scan HTML with regular expressions. Every round of
 * review found new defects of one shape: a pattern matched the markup someone
 * remembered and missed the rest — `<tr>` but not `<tr class="new">`, `<br>` but
 * not `<BR>`, `href` but also `data-href`, `<ul>` but not `<dl>`. Patching each
 * one only moved the boundary; the next round found the next omission, including
 * omissions inside the previous round's patches.
 *
 * A tokenizer cannot have that class of defect. It implements the grammar rather
 * than a list of remembered cases, so attribute quoting, tag-name case, unknown
 * elements, nesting and omitted end tags are handled by construction. What the
 * tokenizer does not know it reports, which is the project's standing rule:
 * doubt is cheaper than a quiet lie.
 */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Elements whose content is text, not markup.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/** Split HTML into text, start-tag and end-tag tokens. */
function tokenize(html) {
  const tokens = [];
  const n = html.length;
  let i = 0;
  const pushText = (value) => {
    if (value) tokens.push({ type: 'text', value });
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const closing = html[lt + 1] === '/';
    const nameAt = lt + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(html.slice(nameAt));
    if (!nameMatch) {
      // A bare "<" in prose is text, not the start of a tag.
      pushText('<');
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    let j = nameAt + nameMatch[0].length;
    const attrs = new Map();
    let selfClosing = false;
    while (j < n) {
      while (j < n && /\s/.test(html[j])) j += 1;
      if (html[j] === '>') {
        j += 1;
        break;
      }
      if (html[j] === '/' && html[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const attrMatch = /^[^\s=/>]+/.exec(html.slice(j));
      if (!attrMatch) {
        j += 1;
        continue;
      }
      const attrName = attrMatch[0].toLowerCase();
      j += attrMatch[0].length;
      while (j < n && /\s/.test(html[j])) j += 1;
      let value = '';
      if (html[j] === '=') {
        j += 1;
        while (j < n && /\s/.test(html[j])) j += 1;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = end === -1 ? html.slice(j + 1) : html.slice(j + 1, end);
          j = end === -1 ? n : end + 1;
        } else {
          const valueMatch = /^[^\s>]*/.exec(html.slice(j));
          value = valueMatch[0];
          j += valueMatch[0].length;
        }
      }
      // First occurrence wins, as in HTML. Attribute names are compared whole,
      // so `data-href` can never be read as `href`.
      if (!attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
    }
    i = j;
    if (closing) {
      tokens.push({ type: 'end', name });
      continue;
    }
    tokens.push({ type: 'start', name, attrs, selfClosing: selfClosing || VOID_ELEMENTS.has(name) });
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const rest = html.slice(i);
      const close = new RegExp(`</${name}\\s*>`, 'i').exec(rest);
      pushText(close ? rest.slice(0, close.index) : rest);
      tokens.push({ type: 'end', name });
      i += close ? close.index + close[0].length : rest.length;
    }
  }
  return tokens;
}

// Block-level elements, used both for implicit <p> closing and to decide what an
// unknown element is allowed to be.
const BLOCK_LEVEL = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'div',
  'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'ul',
]);

// An open element of the key is closed by a start tag named in the value set.
// This is what lets HTML omit </li>, </tr>, </td>, </p> and friends.
const IMPLICITLY_CLOSED_BY = {
  p: BLOCK_LEVEL,
  // HTML forbids a link inside a link, so a browser closes the open one. The
  // webhooks page relies on this, writing <a href="X"><a href="X">X</a></a>;
  // honouring the literal nesting produces [[X](X)](X).
  a: new Set(['a']),
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  tr: new Set(['tr', 'tbody', 'tfoot', 'thead']),
  td: new Set(['td', 'th', 'tr', 'tbody', 'tfoot', 'thead']),
  th: new Set(['td', 'th', 'tr', 'tbody', 'tfoot', 'thead']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  option: new Set(['option']),
};

/** Build a tree of {name, attrs, children} from tokens. */
function buildTree(tokens) {
  const root = { name: '#root', attrs: new Map(), children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  for (const token of tokens) {
    if (token.type === 'text') {
      top().children.push({ name: '#text', value: token.value });
      continue;
    }
    if (token.type === 'start') {
      while (stack.length > 1 && IMPLICITLY_CLOSED_BY[top().name]?.has(token.name)) stack.pop();
      const node = { name: token.name, attrs: token.attrs, children: [] };
      top().children.push(node);
      if (!token.selfClosing) stack.push(node);
      continue;
    }
    // An end tag closes the nearest matching open element, and with it anything
    // still open inside — that is how </ul> closes a dangling <li>. An end tag
    // with no match anywhere is stray markup and is ignored.
    let at = -1;
    for (let k = stack.length - 1; k >= 1; k -= 1) {
      if (stack[k].name === token.name) {
        at = k;
        break;
      }
    }
    if (at !== -1) stack.length = at;
  }
  return root;
}

function parseHtml(html) {
  return buildTree(tokenize(html));
}

// --- HTML → markdown ----------------------------------------------------------

const children = (node) => node.children ?? [];

/** All text under a node, entities decoded, whitespace untouched. */
function rawText(node) {
  if (node.name === '#text') return decodeEntities(node.value);
  if (node.name === 'br') return '\n';
  if (node.name === 'img') return node.attrs.get('alt') ?? '';
  return children(node).map(rawText).join('');
}

/**
 * Resolve a URL found on a documentation page against that page.
 *
 * Hand-rolled prefix matching passed document-relative hrefs through untouched —
 * 23 links such as `[Mini Apps](webapps)` shipped in the cache, pointing at paths
 * that do not exist once a page is split into per-section files — and turned
 * protocol-relative `//host/x` into `https://core.telegram.org//host/x`.
 */
function absolutize(href, baseUrl) {
  let url;
  try {
    url = new URL(href.trim(), baseUrl ?? 'https://core.telegram.org/bots/api').href;
  } catch {
    // A malformed href is content, not a reason to abort the refresh.
    url = href.trim();
  }
  // A markdown destination ends at the first unbalanced ")", so a URL carrying
  // parentheses has to be escaped or the link silently truncates. Telegram
  // publishes exactly this today: .../OpenID#OpenID_Connect_(OIDC%29.
  return /[()\s]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url;
}

/** Elements rendered as inline markup; anything else inline is transparent. */
const INLINE_TRANSPARENT = new Set([
  'span', 'sup', 'sub', 'u', 's', 'strike', 'small', 'big', 'abbr', 'cite', 'dfn',
  'kbd', 'samp', 'var', 'time', 'data', 'bdi', 'bdo', 'q', 'ins', 'del', 'font',
  'tt', 'label', 'noscript', 'nobr', 'ruby', 'rt', 'rp', 'token', 'output',
  'picture', 'map', 'select', 'optgroup', 'option', 'button', 'legend', 'caption',
  // The Login Widget configurator on the Mini Apps page is a live form; its
  // textarea holds the embed code, which is content worth keeping.
  'textarea',
]);

/** Elements that carry no text and are dropped without comment. */
const IGNORED_ELEMENTS = new Set(['input', 'track', 'param', 'col', 'colgroup', 'wbr', 'area', 'base', 'link', 'meta', 'source', 'script', 'style']);

function mediaFromVideo(node, baseUrl) {
  const source = children(node).find((c) => c.name === 'source');
  const src = source?.attrs.get('src') ?? node.attrs.get('src');
  if (src) return `[video](${absolutize(src, baseUrl)})`;
  const poster = node.attrs.get('poster');
  return poster ? `![](${absolutize(poster, baseUrl)})` : '';
}

/**
 * What the renderer actually emitted, counted as it emits.
 *
 * Structure used to be recovered by scanning the finished markdown for pipes and
 * backticks, which cannot tell a table row from a shell pipeline inside a code
 * fence, and cannot see a table at all once a blockquote has indented it. Both
 * mistakes rejected correct output. Counting at the point of emission compares
 * like with like: the tree says what the page contains, these say what was
 * written, and a deficit is a real loss rather than a parsing accident.
 */
let emitted = null;
const countEmitted = (kind, by = 1) => {
  if (emitted) emitted[kind] = (emitted[kind] ?? 0) + by;
};

/** Does this element wrap a picture or a player? A link around one has content. */
function hasMedia(node) {
  return children(node).some(
    (c) => c.name === 'img' || c.name === 'video' || c.name === 'audio' || hasMedia(c),
  );
}

// Whether an element is one the renderer is expected to turn into markdown.
// These mirror the emit conditions in renderInline exactly: an expectation
// derived from different rules than the output would measure the difference
// between the two rules rather than anything about the conversion.
const EMITS = {
  // An anchor with no visible content is a link target, not a link — every
  // heading on these pages is preceded by one.
  link: (node) => node.attrs.has('href') && Boolean(rawText(node).trim() || hasMedia(node)),
  // Emoji sprites become their character, and an image with no source has
  // nothing to point at.
  image: (node) =>
    Boolean(node.attrs.get('src')) &&
    !/\bemoji\b/.test(node.attrs.get('class') ?? '') &&
    !(node.attrs.get('src') ?? '').includes('/img/emoji/'),
  player: (node) =>
    Boolean(children(node).find((c) => c.name === 'source')?.attrs.get('src')) ||
    Boolean(node.attrs.get('src')) ||
    Boolean(node.attrs.get('poster')),
};

/** What the parsed page contains that the renderer owes markdown for. */
function countTree(node, into = {}) {
  const name = node.name;
  if (name === 'table') into.tables = (into.tables ?? 0) + 1;
  else if (name === 'tr') into.rows = (into.rows ?? 0) + 1;
  else if (name === 'pre') into.fences = (into.fences ?? 0) + 1;
  else if (name === 'a') {
    if (EMITS.link(node)) into.links = (into.links ?? 0) + 1;
  } else if (name === 'img') {
    if (EMITS.image(node)) into.media = (into.media ?? 0) + 1;
  } else if (name === 'video' || name === 'audio') {
    if (EMITS.player(node)) into.media = (into.media ?? 0) + 1;
  } else if (name === 'code') into.codes = (into.codes ?? 0) + 1;
  // A <pre> is rendered from its raw text, so nothing inside it becomes markdown
  // of its own: a <code> there is part of the fence and a link is example text.
  if (name === 'pre') return into;
  for (const child of children(node)) countTree(child, into);
  return into;
}

/** Convert inline content to markdown. */
function renderInline(nodes, baseUrl) {
  let out = '';
  for (const node of nodes) {
    switch (node.name) {
      case '#text': {
        // A literal &#10; documents a control character rather than ending a
        // line; keep it visible instead of turning it into layout.
        const marked = node.value.replace(/&#(?:10|x0*a);/gi, '\u0002');
        out += decodeEntities(marked)
          .replace(/[ \t\r\n]+/g, ' ')
          .replace(/\u0002/g, '\\n');
        break;
      }
      case 'br':
        // An explicit markdown hard break; a bare newline would be collapsed.
        out += '  \n';
        break;
      case 'img': {
        const alt = node.attrs.get('alt') ?? node.attrs.get('title') ?? '';
        const src = node.attrs.get('src');
        // Emoji sprites are text and become their character; an illustration
        // must leave a reference behind even with no caption, because a dropped
        // image costs information no character count can notice.
        const isEmoji =
          /\bemoji\b/.test(node.attrs.get('class') ?? '') || (src ?? '').includes('/img/emoji/');
        out += isEmoji || !src ? alt : `![${alt}](${absolutize(src, baseUrl)})`;
        countEmitted('media');
        break;
      }
      case 'video':
      case 'audio': {
        const media = mediaFromVideo(node, baseUrl);
        out += media;
        if (media) countEmitted('media');
        break;
      }
      case 'a': {
        const inner = renderInline(children(node), baseUrl).trim();
        const href = node.attrs.get('href');
        if (href === undefined) out += inner; // an anchor target, not a link
        else if (inner) {
          out += `[${inner}](${absolutize(href, baseUrl)})`;
          countEmitted('links');
        }
        break;
      }
      case 'b':
      case 'strong':
      case 'mark': {
        // A <mark> badge annotates a name rather than being part of it.
        const inner = renderInline(children(node), baseUrl);
        out += inner.trim() ? `**${inner}**` : '';
        break;
      }
      case 'i':
      case 'em': {
        const inner = renderInline(children(node), baseUrl);
        // Empty emphasis emits nothing: the anchor icon before every heading is
        // an <i> with no content, and bare markers there forge visible text.
        out += inner.trim() ? `*${inner}*` : '';
        break;
      }
      case 'code':
        out += markdownCodeSpan(rawText(node));
        countEmitted('codes');
        break;
      default:
        if (IGNORED_ELEMENTS.has(node.name)) break;
        if (INLINE_TRANSPARENT.has(node.name)) {
          out += renderInline(children(node), baseUrl);
          break;
        }
        // A block element reached inline context: its boundary is a word
        // boundary, so flattening it without a separator would glue sentences
        // together at a perfect character count. Refusing is the safe direction.
        throw new Error(`unsupported element <${node.name}> in inline content`);
    }
  }
  return out;
}

function tableToMd(node, baseUrl) {
  const rows = [];
  const collect = (n) => {
    for (const child of children(n)) {
      if (child.name === 'tr') {
        rows.push(
          children(child)
            .filter((c) => c.name === 'td' || c.name === 'th')
            .map((c) =>
              renderInline(children(c), baseUrl)
                .replace(/[ \t]*\n/g, '<br>')
                .replace(/\|/g, '\\|')
                .trim(),
            ),
        );
      } else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') {
        collect(child);
      }
    }
  };
  collect(node);
  if (rows.length === 0) return '';
  countEmitted('tables');
  countEmitted('rows', rows.length);
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

/**
 * Language label for a code fence, read from the markup and never guessed.
 *
 * Telegram tags 4 of the 53 code blocks it publishes. The other 49 get no hint:
 * there is no signal in their markup, and content-sniffing is unsafe here —
 * most are not code at all but MarkdownV2 syntax samples and bare URLs set in a
 * monospace font, and the block that looks most like JSON is an openssl INI
 * config. A guessed language is indistinguishable from documented fact.
 */
function codeFenceLang(pre) {
  const code = children(pre).find((c) => c.name === 'code');
  for (const node of [code, pre]) {
    if (!node) continue;
    const found =
      /\b(?:lang|language|highlight|brush)-([^\s]+)/i.exec(node.attrs.get('class') ?? '')?.[1] ??
      node.attrs.get('data-lang') ??
      node.attrs.get('data-language');
    // Deliberately not a bare `lang=`: in HTML that attribute carries the
    // natural language of the content, so <pre lang="en"> would produce ```en.
    if (found === undefined) continue;
    const lang = found.trim().toLowerCase();
    // Real language names: c++, c#, objective-c, f#, asp.net, shell-session.
    if (/^[a-z0-9][a-z0-9+#._-]{0,19}$/.test(lang)) return lang;
  }
  return '';
}

function preToMd(node) {
  const text = rawText(node).replace(/^\n/, '').replace(/\s+$/, '');
  // The docs' own Markdown examples contain ``` lines, so the fence must always
  // outgrow the longest backtick run inside it.
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((r) => r[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  countEmitted('fences');
  return `${fence}${codeFenceLang(node)}\n${text}\n${fence}`;
}

function listToMd(node, baseUrl) {
  const items = children(node).filter((c) => c.name === 'li');
  return items
    .map((item, index) => {
      const marker = node.name === 'ul' ? '-' : `${index + 1}.`;
      const kids = [...children(item)];
      // The item's own text is whatever precedes its first block child. A
      // leading <p> is that text too, not a separate block — otherwise every
      // list on a page that wraps item prose in <p> renders with empty markers.
      const lead = [];
      while (kids.length > 0 && !isBlock(kids[0])) lead.push(kids.shift());
      if (lead.every((n) => isBlank(n)) && kids[0]?.name === 'p') {
        lead.push(...children(kids.shift()));
      }
      const text = renderInline(lead, baseUrl).trim().replace(/\n/g, '\n  ');
      // A bare marker is not content. Sections are cut at their headings, and
      // the webhooks page puts those headings inside <li>, so a section body can
      // legitimately begin with a list item whose content belongs to the next
      // section — emitting "- " for it would invent a bullet the page never had.
      // Block children are rendered as blocks and indented underneath: a nested
      // list, but equally a <pre> or a <table>. The webhooks guide keeps 14 of
      // its 22 shell snippets inside <li> elements.
      const sub = renderBlocks(kids, baseUrl)
        .split('\n')
        .map((l) => (l ? `  ${l}` : l))
        .join('\n')
        .trimEnd();
      // A bare marker is not content. Sections are cut at their headings, and
      // the webhooks page puts those headings inside <li>, so a section body can
      // legitimately begin with a list item whose content belongs to the next
      // section — emitting "- " for it would invent a bullet the page never had.
      if (!text && !sub.trim()) return '';
      if (!text) {
        // An item made only of blocks: put the marker on the first line rather
        // than leaving it alone above indented content.
        const lines = sub.split('\n');
        const first = lines.findIndex((l) => l.trim());
        lines[first] = `${marker} ${lines[first].trim()}`;
        return lines.join('\n');
      }
      const head = `${marker} ${text}`;
      return sub.trim() ? `${head}\n${sub}` : head;
    })
    .filter(Boolean)
    .join('\n');
}

const isBlank = (node) => node.name === '#text' && !node.value.trim();

const RENDERED_BLOCKS = new Set([
  'p', 'div', 'table', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'center',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'main', 'header',
  'footer', 'aside', 'figure', 'figcaption', 'details', 'summary', 'form',
  'fieldset', 'address', 'nav', 'hgroup', 'dl', 'dt', 'dd', 'li',
]);

const isBlock = (node) => RENDERED_BLOCKS.has(node.name);

/** Convert a sequence of nodes to markdown blocks separated by blank lines. */
function renderBlocks(nodes, baseUrl) {
  const out = [];
  let inline = [];
  const flushInline = () => {
    if (inline.length === 0) return;
    // Content between recognised blocks is content too: the docs place an image
    // or a video in a bare <a>/<video> beside a <p> caption, and collecting only
    // the blocks dropped it whenever a sibling block existed.
    const text = renderInline(inline, baseUrl).trim();
    if (text) out.push(text);
    inline = [];
  };
  for (const node of nodes) {
    if (!isBlock(node)) {
      inline.push(node);
      continue;
    }
    flushInline();
    switch (node.name) {
      case 'p':
      case 'dt':
      case 'dd':
      case 'figcaption':
      case 'summary':
      case 'address': {
        const text = renderInline(children(node), baseUrl).trim();
        if (text) out.push(node.name === 'dd' ? `  ${text}` : text);
        break;
      }
      case 'table':
        out.push(tableToMd(node, baseUrl));
        break;
      case 'ul':
      case 'ol':
        out.push(listToMd(node, baseUrl));
        break;
      case 'blockquote':
        out.push(
          renderBlocks(children(node), baseUrl)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
        break;
      case 'pre':
        out.push(preToMd(node));
        break;
      case 'hr':
        out.push('---');
        break;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        out.push(`#### ${renderInline(children(node), baseUrl).trim()}`);
        break;
      case 'li': {
        // A stray <li> outside any list still carries content. Sections are cut
        // at their headings and this page nests headings inside list items, so a
        // body routinely ends with the opening <li> of the next section — an
        // empty one, which must not become a bullet the page never had.
        const item = listToMd({ name: 'ul', attrs: node.attrs, children: [node] }, baseUrl);
        if (item) out.push(item);
        break;
      }
      default:
        // Wrappers with no markdown of their own: render their children.
        out.push(renderBlocks(children(node), baseUrl));
        break;
    }
  }
  flushInline();
  return out.filter(Boolean).join('\n\n');
}

/** Convert inline HTML (a heading, a cell, a fragment) to markdown. */
function inlineToMd(html, baseUrl) {
  return renderInline(children(parseHtml(html)), baseUrl);
}

/** Convert a block of section HTML to markdown. */
function blockToMd(html, baseUrl) {
  return renderBlocks(children(parseHtml(html)), baseUrl);
}

/** Render a parsed section and report what the renderer emitted. */
function renderCounted(tree, baseUrl) {
  const previous = emitted;
  emitted = {};
  try {
    return { md: renderBlocks(children(tree), baseUrl), stats: emitted };
  } finally {
    emitted = previous;
  }
}

// --- Body fidelity ------------------------------------------------------------

/**
 * Counts letters and digits only. Markdown syntax (pipes, fences, brackets,
 * list markers, emphasis) is punctuation, so this compares the actual words on
 * both sides rather than the formatting wrapped around them.
 */
function alnumCount(s) {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function htmlBodyLength(html) {
  return alnumCount(decodeEntities(html.replace(/<[^>]+>/g, ' ')));
}

// A markdown link or image destination, in either plain or angle-bracket form.
const MD_TARGET = /\((?:<[^>]*>|[^)]*)\)/.source;

/**
 * Text on the markdown side that also exists on the HTML side.
 *
 * The HTML measurement strips tags, so everything carried in an attribute is
 * invisible to it: link targets, image captions, and the generated `[video]`
 * label exist only in the markdown. Counting them made the ratio a measure of
 * how illustrated a section is rather than how faithfully it converted — adding
 * `title` as an image caption, a strict improvement, pushed two pages past the
 * duplication ceiling and turned them STALE.
 */
function markdownBodyLength(md) {
  return alnumCount(
    md
      .replace(new RegExp(`!\\[[^\\]]*\\]${MD_TARGET}`, 'g'), '')
      .replace(new RegExp(`\\[video\\]${MD_TARGET}`, 'g'), '')
      .replace(new RegExp(`\\]${MD_TARGET}`, 'g'), ']'),
  );
}

// Below this the ratio is dominated by noise: heading-only sections, one-line
// stubs, and bodies that are a single image.
const FIDELITY_MIN_CHARS = 40;

// Conversion legitimately loses a little text: an <a href="X">X</a> shown in an
// example collapses into one markdown link, so the URL is counted once here and
// twice on the HTML side. The measured floor across all ~970 sections is 0.93,
// while the nested-list defect this guard was written for scored 0.67 — 0.85
// sits clear of both.
const FIDELITY_MIN_RATIO = 0.85;

// Page text that precedes the first anchored heading is published under this
// reserved anchor. Telegram's own anchors are lowercase words joined by hyphens
// (`recent-changes`, `star-pricing`) and one page already uses `overview` for a
// real section, so the leading underscore both avoids a collision today and
// marks the file as generated rather than mirrored.
const INTRO_ANCHOR = '_intro';
const INTRO_TITLE = 'Introduction';
const INTRO_MIN_CHARS = 40;

// Whole-page accounting tolerance. Measured across all ten pages the kept ratio
// is 0.998-1.005 — it can exceed 1.0 because image alt text exists only on the
// markdown side. Dropping the intros alone scored 0.968 on the webhooks page and
// 0.961 on payments, so 0.98 separates the two cleanly. Note the limit of a
// ratio: on the 389k-character Bot API page the same defect cost 0.05% and would
// have passed. Exact coverage is asserted separately in splitSections; this
// guard exists for loss that coverage cannot see, inside the converter.
const MASS_MIN_RATIO = 0.98;

// Every guard below was a lower bound only, so duplicated content was invisible
// to all of them. Measured ceilings: per-section 1.07, whole-page 1.005.
const FIDELITY_MAX_RATIO = 1.15;
const MASS_MAX_RATIO = 1.02;

// How much of the previous build's section count a new build must retain.
// Telegram does remove things — a deprecated method, a merged section — so this
// is not an equality, but a page cannot lose a quarter of its sections in one
// edit without something having gone wrong with the parse. A restructuring that
// genuinely shrank a page is accepted by rerunning with --force.
const SHRINK_MIN_RATIO = 0.75;




if (selfTest) {
  const BASE = 'https://core.telegram.org/bots/api';
  const inlineCases = [
    ['<code>&#10;</code>', '`\\n`'],
    // Attribute tolerance. Every one of these tags matched only in its bare
    // form once, so a single added class silently deleted a whole category of
    // content while every guard still passed: a highlighted table row vanished,
    // code spans became plain text, bold markers disappeared. Telegram adding a
    // class to mark something new is routine, so this is drift, not paranoia.
    ['<code class="tg">x</code>', '`x`'],
    ['<strong class="x">bold</strong>', '**bold**'],
    ['<em data-k="1">it</em>', '*it*'],
    ['<mark>NEW</mark>', '**NEW**'],
    // Empty emphasis must vanish, not emit bare markers. Every heading on these
    // pages is preceded by <a class="anchor"><i class="anchor-icon"></i></a>;
    // once the emphasis rules learned to tolerate attributes, that icon started
    // producing "**", which in turn made the surrounding anchor look like a link
    // with visible text and put "[**](url)" in front of 24 headings.
    ['<i class="anchor-icon"></i>', ''],
    ['<b></b>text', 'text'],
    [
      '<a class="anchor" name="x" href="#x"><i class="anchor-icon"></i></a>Title',
      'Title',
    ],
    // Attribute values are not always double-quoted in real HTML.
    ["<a href='/bots/api'>x</a>", '[x](https://core.telegram.org/bots/api)'],
    ['<a href=/bots/faq>y</a>', '[y](https://core.telegram.org/bots/faq)'],
    // Document-relative hrefs must resolve against the page, not pass through:
    // 23 links such as [Mini Apps](webapps) shipped in the cache pointing at
    // paths that do not exist once the page is split into per-section files.
    ['<a href="webapps">Mini Apps</a>', '[Mini Apps](https://core.telegram.org/bots/webapps)'],
    ['<a href="webapps#design">d</a>', '[d](https://core.telegram.org/bots/webapps#design)'],
    // Protocol-relative URLs must keep their host instead of being prefixed.
    ['<a href="//telegram.org/blog">b</a>', '[b](https://telegram.org/blog)'],
    // Entities outside the hand-maintained table must not leak their source
    // form into the cache; both sides count "hellip" as text, so no ratio guard
    // can see this.
    ['a&hellip;b', 'a…b'],
    ['x&rsquo;s', 'x’s'],
    ["character ('&#10;', 0x0A)", "character ('\\n', 0x0A)"],
    ['first<br>second', 'first  \nsecond'],
    ['<code>a`b</code>', '``a`b``'],
    ['<strong>bold</strong>', '**bold**'],
    ['<a href="#sendmessage">sendMessage</a>', '[sendMessage](https://core.telegram.org/bots/api#sendmessage)'],
    // A <br> inside a code span must not leak a raw control character.
    ['<code>x<br>y</code>', '`x\\ny`'],
    // CommonMark requires space padding around leading/trailing backticks.
    ['<code>`a</code>', '`` `a ``'],
    // A literal &#0; must neither forge a placeholder nor render `undefined`.
    ['<code>a</code>&#0;1&#0;', '`a`1'],
  ];
  const blockCases = [
    // The fence must outgrow any backtick run in the content — the docs' own
    // Markdown examples contain literal ``` lines inside <pre>.
    ['<pre><code>a\n```\nb</code></pre>', '````\na\n```\nb\n````'],
    // A language the docs declare is carried onto the fence...
    ['<pre><code class="lang-json">{"a": 1}</code></pre>', '```json\n{"a": 1}\n```'],
    // ...and an undeclared one is left blank rather than guessed. This block is
    // an openssl INI config on the webhooks page; content-sniffing calls it JSON.
    ['<pre><code>[NewRequest]\nSubject = "CN=x"</code></pre>', '```\n[NewRequest]\nSubject = "CN=x"\n```'],
    // Conventions Telegram does not use today must still come through if it
    // starts: label on the <pre>, other class prefixes, data attributes, a
    // multi-class list, and punctuation that is part of real language names.
    ['<pre class="lang-bash"><code>ls</code></pre>', '```bash\nls\n```'],
    ['<pre><code class="hljs language-python">x = 1</code></pre>', '```python\nx = 1\n```'],
    ['<pre><code class="prettyprint highlight-c++">int x;</code></pre>', '```c++\nint x;\n```'],
    ['<pre data-language="Go"><code>package main</code></pre>', '```go\npackage main\n```'],
    ['<pre><code class="lang-objective-c">@end</code></pre>', '```objective-c\n@end\n```'],
    // A bare lang= is HTML's natural-language attribute, not a code language.
    ['<pre lang="en"><code>hello</code></pre>', '```\nhello\n```'],
    // A table row carrying a class must not disappear. Losing one row leaves a
    // structurally valid table that has silently shifted: in the real currency
    // table the header vanished and the first data row took its place.
    [
      '<table><tr class="new"><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
    ],
    // HTML lets </tr> be omitted; the next <tr> closes the row implicitly.
    [
      '<table><tr><th>A</th><tr><td>1</td></table>',
      '| A |\n| --- |\n| 1 |',
    ],
    // A label that could break the fence line is dropped, not written through.
    ['<pre><code class="lang-a`b">x</code></pre>', '```\nx\n```'],
    // A nested list must not truncate its parent at the inner </ul>: this ate
    // four top-level entries of the Bot Features navigation list in practice.
    [
      '<ul><li><b>A</b><ul><li>a1</li></ul></li><li><b>B</b></li></ul>',
      '- **A**\n  - a1\n- **B**',
    ],
    // Sibling blocks after a nested list must still be reached.
    ['<ul><li>x<ul><li>y</li></ul></li></ul><p>after</p>', '- x\n  - y\n\nafter'],
    // An omitted </li> still closes the previous item.
    ['<ul><li>one<li>two</ul>', '- one\n- two'],
    // Ordered lists keep their numbering across nesting.
    ['<ol><li>one<ol><li>inner</li></ol></li><li>two</li></ol>', '1. one\n  1. inner\n2. two'],
    // <p><table> — the paragraph must close implicitly at the table, or the
    // table is flattened into run-on text with every character still present.
    [
      '<p>intro<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></p>',
      'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',
    ],
    // A content image with no alt must leave a reference behind.
    [
      '<p><img src="/file/x.png" alt="" /></p>',
      '![](https://core.telegram.org/file/x.png)',
    ],
  ];
  // Emoji sprites collapse to their character; a content image keeps its src.
  // Both discriminators the converter uses are exercised here.
  const imgCases = [
    ['<img class="emoji" src="//telegram.org/img/emoji/40/F0.png" alt="😀">', '😀'],
    ['<img src="//telegram.org/img/emoji/40/F0.png" alt="😀">', '😀'],
    ['<img src="/file/abc" alt="Types of buttons">', '![Types of buttons](https://core.telegram.org/file/abc)'],
    ['<video poster="/file/p"><source src="/file/v.mp4" type="video/mp4"></video>', '[video](https://core.telegram.org/file/v.mp4)'],
    ['signature <sup><mark class="mark-new">NEW</mark></sup>', 'signature **NEW**'],
  ];
  for (const [html, expected] of imgCases) {
    const actual = inlineToMd(html, BASE);
    if (actual !== expected) {
      console.error(`self-test failed for ${JSON.stringify(html)}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
      process.exit(1);
    }
  }
  const checks = [
    ...inlineCases.map(([html, expected]) => [html, expected, inlineToMd]),
    ...blockCases.map(([html, expected]) => [html, expected, blockToMd]),
  ];
  for (const [html, expected, convert] of checks) {
    const actual = convert(html, BASE);
    if (actual !== expected) {
      console.error(`self-test failed for ${JSON.stringify(html)}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
      process.exit(1);
    }
  }
  // Markup the renderer has no rule for must abort rather than be flattened.
  // A block element carries a word boundary; stripping it to nothing glues
  // sentences together at a perfect character count, which no ratio guard can
  // see. These are the shapes that reached production as run-on text before.
  const mustThrow = [
    ['<dl><dt>Invoice</dt><dd>A request for payment.</dd></dl>', 'definition list'],
    ['<p>a</p><figure><figcaption>Caption</figcaption></figure>', 'figure'],
    ['<details><summary>More</summary><p>Body</p></details>', 'disclosure'],
  ];
  for (const [html, label] of mustThrow) {
    let threw = false;
    try {
      inlineToMd(html, BASE);
    } catch {
      threw = true;
    }
    if (!threw) {
      console.error(`self-test failed: ${label} markup was flattened instead of refused`);
      process.exit(1);
    }
  }
  console.log(`self-test passed (${checks.length + mustThrow.length} converter cases)`);
  process.exit(0);
}

// --- Golden fixtures ----------------------------------------------------------

// Whole real pages, saved verbatim, converted offline and diffed against their
// recorded output. The self-test above checks hand-written fragments, which only
// exercise the markup someone already thought to write down; every defect found
// in this converter so far came from markup nobody had thought of. These two
// pages between them carry the structures that broke it: a 95-row table, shell
// snippets nested inside list items, videos, content images and emoji sprites.
// Frozen input means the recorded output changes only when the converter does.
// webapps is the one reference page here, and the only fixture that exercises
// prose:false — method/type classification — and the language-tagged fences.
const GOLDEN_FIXTURES = [
  { file: 'webhooks.html', url: 'https://core.telegram.org/bots/webhooks', prose: true },
  { file: 'payments.html', url: 'https://core.telegram.org/bots/payments', prose: true },
  { file: 'webapps.html', url: 'https://core.telegram.org/bots/webapps', prose: false },
];

function renderGolden(sections) {
  return sections
    .map((s) =>
      [
        `=== ${s.anchor} | ${s.kind} | h${s.level} | parent=${s.parent ?? '-'} ===`,
        `# ${s.title}`,
        '',
        s.md,
        '',
      ].join('\n'),
    )
    .join('\n');
}

if (golden) {
  let failed = 0;
  for (const fixture of GOLDEN_FIXTURES) {
    const htmlPath = join(FIXTURE_DIR, fixture.file);
    const goldenPath = join(FIXTURE_DIR, `${fixture.file.replace(/\.html$/, '')}.golden.md`);
    if (!existsSync(htmlPath)) {
      console.error(`golden: missing fixture ${htmlPath}`);
      process.exit(1);
    }
    let actual;
    try {
      // Guards included: a fixture that stops converting cleanly must fail the
      // test rather than silently re-record a degraded page.
      actual = renderGolden(splitSections(contentRegion(readFileSync(htmlPath, 'utf8')), fixture.url, fixture.prose));
    } catch (err) {
      console.error(`golden: ${fixture.file} failed to convert: ${err.message}`);
      failed++;
      continue;
    }
    if (updateGolden) {
      writeFileSync(goldenPath, actual);
      console.log(`golden: recorded ${fixture.file} (${actual.length} bytes)`);
      continue;
    }
    const expected = existsSync(goldenPath) ? readFileSync(goldenPath, 'utf8') : null;
    if (expected === null) {
      console.error(`golden: no recorded output for ${fixture.file} — run --update-golden`);
      failed++;
      continue;
    }
    if (actual === expected) {
      console.log(`golden: ${fixture.file} matches (${(actual.match(/^=== /gm) ?? []).length} sections)`);
      continue;
    }
    const a = actual.split('\n');
    const b = expected.split('\n');
    const at = a.findIndex((line, i) => line !== b[i]);
    console.error(
      `golden: ${fixture.file} differs from recorded output at line ${at + 1}\n` +
        `  expected: ${JSON.stringify(b[at] ?? '<end of file>')}\n` +
        `  actual:   ${JSON.stringify(a[at] ?? '<end of file>')}\n` +
        `  (${b.length} recorded lines vs ${a.length} produced)\n` +
        '  If the change is intended, rerun with --update-golden and review the diff.',
    );
    failed++;
  }
  process.exit(failed > 0 ? 1 : 0);
}

// --- Page splitting -----------------------------------------------------------

/** Extract the documentation content region of a core.telegram.org page. */
/**
 * The documentation content of a core.telegram.org page: the inside of the
 * element carrying id="dev_page_content".
 *
 * The boundary used to be the first occurrence of the literal
 * `<div class="footer_wrap"`, which is not a boundary at all but a guess that
 * the string appears exactly once and only after the content. Both halves fail:
 * a rename made it absent (silently appending the whole site footer to the last
 * section), and an example reusing that class inside the documentation truncated
 * the page — with 26 of 107 sections published and every guard satisfied,
 * because they all measured the truncated region against itself.
 *
 * Finding the element's own end tag removes the guess. Depth counting makes
 * nesting irrelevant, and running out of document is a refusal rather than a
 * silent "take the rest".
 */
function contentRegion(html) {
  const start = html.indexOf('id="dev_page_content"');
  if (start === -1) throw new Error('page layout changed: no dev_page_content');
  // Back up to the opening "<" of the tag carrying the id, then forward past it.
  const tagStart = html.lastIndexOf('<', start);
  const openEnd = html.indexOf('>', start);
  if (tagStart === -1 || openEnd === -1) {
    throw new Error('page layout changed: unterminated dev_page_content tag');
  }
  const tagName = /^<\s*([a-zA-Z][^\s/>]*)/.exec(html.slice(tagStart))?.[1]?.toLowerCase();
  if (!tagName) throw new Error('page layout changed: dev_page_content is not an element');

  const scanner = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
  scanner.lastIndex = openEnd + 1;
  let depth = 0;
  let m;
  while ((m = scanner.exec(html)) !== null) {
    if (m[1] === '/') {
      if (depth === 0) return html.slice(openEnd + 1, m.index);
      depth -= 1;
    } else if (!/\/>$/.test(m[0])) {
      depth += 1;
    }
  }
  throw new Error(`page layout changed: <${tagName} id="dev_page_content"> is never closed`);
}

function classifySection(anchor, title, level, parentAnchor, prose) {
  if (/^\w+-\d+-\d{4}$/.test(anchor) || parentAnchor === 'recent-changes') return 'changelog';
  // Guide pages document no methods or types, so the naming heuristic below
  // must not run: headings like "Commands" or "Keyboards" are prose, not types.
  if (prose) return 'section';
  if (level === 3) return 'section';
  if (/^[a-z]/.test(title) && !/\s/.test(title)) return 'method';
  if (/^[A-Z]/.test(title) && !/\s/.test(title)) return 'type';
  return 'section';
}

/**
 * Split a page's content region into sections at every h3/h4 anchor heading.
 * Returns [{anchor, title, kind, level, parent, md, summary}].
 * Throws when the markup does not parse cleanly — callers must treat that as
 * "keep the old cache", never as "write a partial one".
 */
function splitSections(region, baseUrl, prose = false) {
  // Comments and script/style bodies can legally contain "<h3" text that is
  // not a real heading; strip them so the raw-count guard below cannot report
  // a false mismatch (which would present as a permanent STALE). Parsing and
  // counting must run on the same sanitized string.
  region = region
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  // Attribute order inside the <a> tag is matched via lookaheads, and the
  // heading tag may carry attributes — Telegram's markup is stable today but
  // this must not silently drop a section if it drifts.
  const headingRe =
    /<h([34])(?:\s[^>]*)?><a\b(?=[^>]*\bclass="anchor")(?=[^>]*\bname="([^"]+)")[^>]*>(?:<i[^>]*><\/i>)?<\/a>(.*?)<\/h\1>/gs;
  const marks = [];
  const seenAnchors = new Set();
  let m;
  while ((m = headingRe.exec(region)) !== null) {
    const anchor = m[2];
    // The anchor becomes a filename; anything outside this allowlist (e.g. a
    // "../" segment from a tampered response) must abort the whole refresh.
    // Dots and underscores are tolerated for future anchor drift, but never
    // path traversal or hidden-file names.
    if (!/^[\w.-]+$/.test(anchor) || anchor.includes('..') || anchor.startsWith('.')) {
      throw new Error(`unsafe anchor name "${anchor}"`);
    }
    // Anchors become filenames, so two sections sharing one would leave the
    // second silently overwriting the first while meta.json and the index still
    // advertise both. Compared case-insensitively because the cache is written
    // to disks that do not distinguish case.
    const key = anchor.toLowerCase();
    if (seenAnchors.has(key)) {
      throw new Error(`duplicate anchor "${anchor}" — two sections would share one file`);
    }
    seenAnchors.add(key);
    marks.push({
      level: Number(m[1]),
      anchor,
      // Collapsed to one line: the title is interpolated into index.md, which
      // is one section per line, so an embedded newline would forge an entry.
      title: inlineToMd(m[3], baseUrl).replace(/\s+/g, ' ').trim(),
      start: m.index,
      bodyStart: m.index + m[0].length,
      headLen: m[0].length,
    });
  }
  // Every h3/h4 in the region is expected to be an anchor heading. A mismatch
  // means some heading variant did not parse — refuse rather than silently
  // publish a cache with missing sections.
  const rawHeadingCount = (region.match(/<h[34](?:\s[^>]*)?>/g) ?? []).length;
  if (marks.length !== rawHeadingCount) {
    throw new Error(
      `parsed ${marks.length} of ${rawHeadingCount} h3/h4 headings — markup may have changed`,
    );
  }
  // Everything before the first anchored heading belongs to no section, so the
  // per-section guards below are structurally blind to it — and it is not
  // filler: the webhooks page opens with 1088 characters comparing getUpdates
  // and setWebhook. Carry it as one synthetic section that goes through exactly
  // the same conversion and guards as the real ones.
  const firstStart = marks.length > 0 ? marks[0].start : region.length;
  const introHtml = region.slice(0, firstStart);
  const segments = marks.map((mark, i) => ({
    ...mark,
    bodyHtml: region.slice(mark.bodyStart, i + 1 < marks.length ? marks[i + 1].start : region.length),
  }));
  if (htmlBodyLength(introHtml) >= INTRO_MIN_CHARS) {
    if (marks.some((mark) => mark.anchor === INTRO_ANCHOR)) {
      throw new Error(`page now defines an anchor named "${INTRO_ANCHOR}", which is reserved`);
    }
    segments.unshift({
      level: 3,
      anchor: INTRO_ANCHOR,
      title: INTRO_TITLE,
      synthetic: true,
      bodyHtml: introHtml,
    });
  }
  // Exact coverage. The segment ranges must tile the region: every byte belongs
  // to a heading tag, to a segment that gets converted, or to a sub-threshold
  // intro deliberately skipped just above. This is the zero-tolerance form of
  // the accounting the ratio guard at the end does statistically, and it is what
  // makes "content reached no section" impossible to reintroduce unnoticed — a
  // future refactor of the range arithmetic breaks this before it ships.
  const skippedIntro = segments.some((s) => s.synthetic) ? 0 : introHtml.length;
  const accounted =
    skippedIntro +
    segments.reduce((n, s) => n + s.bodyHtml.length, 0) +
    marks.reduce((n, mark) => n + mark.headLen, 0);
  if (accounted !== region.length) {
    throw new Error(
      `splitter covered ${accounted} of ${region.length} bytes — ` +
        `${region.length - accounted} bytes of the page belong to no section`,
    );
  }

  const sections = [];
  const fidelity = [];
  const structural = [];
  let currentH3 = null;
  for (const mark of segments) {
    const bodyHtml = mark.bodyHtml;
    if (mark.level === 3) currentH3 = mark.anchor;
    const tree = parseHtml(bodyHtml);
    const { md, stats } = renderCounted(tree, baseUrl);
    const htmlLen = htmlBodyLength(bodyHtml);
    if (htmlLen >= FIDELITY_MIN_CHARS) {
      fidelity.push({ anchor: mark.anchor, ratio: markdownBodyLength(md) / htmlLen, htmlLen });
    }
    // Structure is compared between what the page contains and what the renderer
    // wrote, both counted from the same parse. Text volume cannot see a table
    // flattened into a paragraph — every character survives while the rows and
    // columns are destroyed — and reading the finished markdown back cannot tell
    // a table row from a shell pipeline inside a code fence, nor find a table
    // that a blockquote has indented. Losing one row of the 95-currency table
    // promoted the first data row into the header's place: still valid markdown,
    // no longer true.
    const inPage = countTree(tree);
    for (const [kind, key] of [
      ['table', 'tables'],
      ['table row', 'rows'],
      ['code block', 'fences'],
      ['link', 'links'],
      ['image or video', 'media'],
      ['inline code span', 'codes'],
    ]) {
      const expected = inPage[key] ?? 0;
      const got = stats[key] ?? 0;
      if (got < expected) structural.push({ anchor: mark.anchor, kind, expected, got });
    }
    const firstPara = md.split('\n\n').find((b) => b && !b.startsWith('|') && !b.startsWith('```'));
    const summary = (firstPara ?? '').replace(/\n/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    sections.push({
      anchor: mark.anchor,
      title: mark.title,
      level: mark.level,
      parent: mark.level === 4 ? currentH3 : null,
      kind: mark.synthetic
        ? 'section'
        : classifySection(mark.anchor, mark.title, mark.level, mark.level === 4 ? currentH3 : null, prose),
      synthetic: mark.synthetic === true,
      md,
      summary: summary.length > 160 ? `${summary.slice(0, 157)}...` : summary,
    });
  }
  // The heading guard above proves every section was *found*; this proves each
  // one was carried over *whole*. Without it a converter that silently drops
  // part of a body still reports "fresh", which is the one way this cache can
  // mislead without any visible symptom.
  if (structural.length > 0) {
    const worst = structural
      .slice(0, 5)
      .map((s2) => `${s2.anchor}: ${s2.expected} ${s2.kind}(s) -> ${s2.got}`)
      .join(', ');
    throw new Error(
      `block structure lost in ${structural.length} section(s) — ` +
        `the converter may not handle the current markup: ${worst}`,
    );
  }
  const lost = fidelity.filter((f) => f.ratio < FIDELITY_MIN_RATIO);
  if (lost.length > 0) {
    const worst = [...lost]
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 5)
      .map((f) => `${f.anchor} (${Math.round(f.ratio * 100)}%)`)
      .join(', ');
    throw new Error(
      `body text lost in ${lost.length} of ${fidelity.length} measurable sections — ` +
        `the converter may not handle the current markup: ${worst}`,
    );
  }
  const bloated = fidelity.filter((f) => f.ratio > FIDELITY_MAX_RATIO);
  if (bloated.length > 0) {
    const worst = [...bloated]
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 5)
      .map((f) => `${f.anchor} (${Math.round(f.ratio * 100)}%)`)
      .join(', ');
    throw new Error(
      `body text duplicated in ${bloated.length} of ${fidelity.length} measurable sections: ${worst}`,
    );
  }
  // Links, images and code spans used to be compared page-wide with loose ratios
  // because reading them back out of finished markdown was unreliable. They are
  // now counted per section at the point of emission, in the structural guard
  // above, which is both exact and free of that ambiguity.

  // Conservation of mass. Both guards above weigh section bodies against section
  // bodies, so neither can see text that ended up in no section at all — which
  // is precisely how the dropped page intros survived two full audits. This
  // weighs the whole page against everything written out, and is the only guard
  // that closes over content the splitter never claimed.
  const pageMass = htmlBodyLength(region);
  const keptMass = sections.reduce(
    (sum, s) => sum + markdownBodyLength(s.md) + alnumCount(s.title),
    0,
  );
  if (pageMass > 0 && keptMass / pageMass < MASS_MIN_RATIO) {
    throw new Error(
      `${pageMass - keptMass} of ${pageMass} characters on the page reached no section ` +
        `(${Math.round((keptMass / pageMass) * 100)}% kept) — the splitter is discarding content`,
    );
  }
  if (pageMass > 0 && keptMass / pageMass > MASS_MAX_RATIO) {
    throw new Error(
      `output holds ${Math.round((keptMass / pageMass) * 100)}% of the page's text — ` +
        'the converter is duplicating content',
    );
  }
  return sections;
}

// --- Cache writing ------------------------------------------------------------

/** Replace a file or directory while preserving a rollback copy on failure. */
function replaceWithRollback(stagedPath, targetPath) {
  const backupPath = `${targetPath}.backup`;

  // Recover from a previous interrupted replacement before starting a new one.
  if (existsSync(backupPath)) {
    if (existsSync(targetPath)) rmSync(backupPath, { recursive: true, force: true });
    else renameSync(backupPath, targetPath);
  }

  if (existsSync(targetPath)) renameSync(targetPath, backupPath);
  try {
    renameSync(stagedPath, targetPath);
  } catch (err) {
    if (!existsSync(targetPath) && existsSync(backupPath)) renameSync(backupPath, targetPath);
    throw err;
  }
  rmSync(backupPath, { recursive: true, force: true });
}

function writeFileSafely(path, contents) {
  const stagedPath = `${path}.tmp`;
  rmSync(stagedPath, { force: true });
  writeFileSync(stagedPath, contents);
  replaceWithRollback(stagedPath, path);
}

/** Stage sections in a temp dir, then replace the old directory with rollback. */
function writeSections(source, sections) {
  const dir = join(CACHE_DIR, source.dir);
  const tmp = join(CACHE_DIR, `.${source.dir}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const s of sections) {
    // The synthetic intro has no anchor upstream, so it must cite the page
    // itself — a "#_intro" fragment would be a link that does not resolve.
    const header = [
      `# ${s.title}`,
      '',
      `> Source: ${source.url}${s.synthetic ? '' : `#${s.anchor}`} (official Telegram documentation)`,
      `> Kind: ${s.kind}`,
      '',
      '',
    ].join('\n');
    writeFileSync(join(tmp, `${s.anchor}.md`), `${header}${s.md}\n`);
  }
  replaceWithRollback(tmp, dir);
}

function writeIndex(meta) {
  const lines = [
    '# Telegram docs index',
    '',
    'Format: `name — kind — summary` → file path relative to `cache/`.',
    '',
  ];
  for (const source of SOURCES) {
    const entry = meta[source.key];
    if (!entry?.sections) continue;
    lines.push(`## ${source.label} (${source.url})`, '');
    for (const s of entry.sections) {
      lines.push(`- **${s.title}** — ${s.kind} — ${s.summary} → \`${source.dir}/${s.anchor}.md\``);
    }
    lines.push('');
  }
  writeFileSafely(INDEX_PATH, lines.join('\n'));
}

// --- Main ---------------------------------------------------------------------

function loadMeta() {
  try {
    return JSON.parse(readFileSync(META_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The version banner is only meaningful inside the "Recent changes" section;
 * matching the whole page could pick up an unrelated "Bot API X.Y" mention.
 */
function extractVersion(region) {
  const idx = region.indexOf('name="recent-changes"');
  let scope = idx === -1 ? region : region.slice(idx);
  // Bound the scope at the next top-level heading so a stray "Bot API X.Y"
  // mention later in the page can never be mistaken for the version banner.
  const nextH3 = scope.search(/<h3[\s>]/);
  if (idx !== -1 && nextH3 !== -1) scope = scope.slice(0, nextH3);
  return scope.match(/Bot API ([0-9]+\.[0-9]+)/)?.[1] ?? null;
}

function hoursAgo(iso) {
  return ((Date.now() - new Date(iso).getTime()) / 3_600_000).toFixed(1);
}

const meta = loadMeta();
let indexDirty = false;
let metaDirty = false;
let exitCode = 0;
let fatal = false;
let lockAcquired = false;

// Written into the lock directory so a run can prove the lock it deletes is
// still its own. Worst-case runtime (ten sources x a 30 s fetch timeout) equals
// LOCK_STALE_MS exactly, so a slow-but-healthy run can have its lock taken over;
// without this check it would then delete the new owner's lock on the way out
// and leave two runs writing the same cache.
const LOCK_TOKEN = `${process.pid}-${CONVERTER_HASH}`;
const LOCK_ID_PATH = join(LOCK_DIR, 'owner');

// The reason a lock could not be taken. Reporting "another refresh is already
// running" for a permission error sent read-only installations into permanent,
// misdiagnosed staleness with no way to tell the two cases apart.
let lockFailure = 'another refresh is already running';

function acquireLock() {
  if (lockAcquired) return true;
  const claim = () => {
    mkdirSync(LOCK_DIR);
    writeFileSync(LOCK_ID_PATH, LOCK_TOKEN);
    lockAcquired = true;
    return true;
  };
  try {
    return claim();
  } catch (err) {
    if (err.code && err.code !== 'EEXIST') {
      lockFailure = `cache directory is not writable (${err.code})`;
      return false;
    }
    lockFailure = 'another refresh is already running';
    try {
      if (Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
        // Atomic takeover of a crashed run's lock: rename succeeds for exactly
        // one contender, so two processes can never both "acquire" here.
        const trash = `${LOCK_DIR}.stale-${process.pid}`;
        renameSync(LOCK_DIR, trash);
        rmSync(trash, { recursive: true, force: true });
        return claim();
      }
    } catch {
      // Lock vanished, another contender won the takeover, or someone re-made
      // the directory first — treat as busy this run.
    }
    return false;
  }
}

function releaseLock() {
  if (!lockAcquired) return;
  lockAcquired = false;
  try {
    // Only remove a lock we still own. If a takeover happened while this run was
    // working, the directory now belongs to someone else and must be left alone.
    if (readFileSync(LOCK_ID_PATH, 'utf8') !== LOCK_TOKEN) return;
  } catch {
    return; // no owner file: not ours to delete
  }
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

// The lock outlives the process unless release is unconditional. Piping this
// script into `head`, or interrupting it, used to leave the directory behind,
// after which every invocation for the next five minutes reported STALE and the
// agent dutifully told users the cache could not be verified — a false
// disclosure, since it had been verified seconds earlier.
let released = false;
function releaseOnce() {
  if (released) return;
  released = true;
  try {
    releaseLock();
  } catch {
    // Never let cleanup mask the original failure.
  }
}
process.on('exit', releaseOnce);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    releaseOnce();
    process.exit(130);
  });
}
// A closed stdout (`| head`) otherwise raises EPIPE as an unhandled error and
// kills the run mid-refresh.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

/** Persist meta/index if anything changed. Called per-source AND at the end. */
function persist() {
  if (indexDirty) writeIndex(meta);
  if (metaDirty || indexDirty) {
    writeFileSafely(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
  }
  indexDirty = false;
  metaDirty = false;
}

/**
 * A source could not be verified/refreshed. With a usable cache this degrades
 * to STALE (exit 2, caller continues); with no cache the run is marked fatal
 * (exit 1 at the end) — but the remaining sources are still attempted, so one
 * source's outage can never block building the other's cache.
 */
function sourceProblem(source, entry, hasCache, reason) {
  if (hasCache) {
    console.log(
      `${source.label}: STALE — ${reason}; using cache from ${entry.fetchedAt} (${entry.version ? `Bot API ${entry.version}` : 'unversioned'}). Disclose this when answering.`,
    );
    exitCode = 2;
    return;
  }
  console.error(`${source.label}: FATAL — ${reason} and no usable cache exists`);
  fatal = true;
}

for (const source of SOURCES) {
  const entry = meta[source.key];
  const hasCache = Boolean(entry?.hash) && existsSync(join(CACHE_DIR, source.dir));

  // A converter change must take effect on the next run, not after the TTL
  // expires, so it bypasses the offline fast path as well.
  const builtByThisConverter = entry?.converter === CONVERTER_HASH;

  if (!force && hasCache && builtByThisConverter && entry.checkedAt) {
    const ageS = (Date.now() - new Date(entry.checkedAt).getTime()) / 1000;
    if (ageS < maxAgeS) {
      console.log(
        `${source.label}: fresh (cached${entry.version ? `, Bot API ${entry.version}` : ''}, checked ${hoursAgo(entry.checkedAt)}h ago, TTL not expired)`,
      );
      continue;
    }
  }

  if (!acquireLock()) {
    sourceProblem(source, entry, hasCache, lockFailure);
    continue;
  }

  let html;
  try {
    const res = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    sourceProblem(source, entry, hasCache, `network check failed (${err.message})`);
    continue;
  }

  // Hash only the documentation content region: the full page embeds a
  // "page generated in NN ms" comment that changes on every request.
  let region;
  try {
    region = contentRegion(html);
  } catch (err) {
    sourceProblem(source, entry, hasCache, err.message);
    continue;
  }
  const hash = createHash('sha256').update(region).digest('hex');
  const now = new Date().toISOString();
  const version = source.key === 'botapi' ? extractVersion(region) : null;

  // An unchanged page is only reason to skip the rebuild if the cache was also
  // produced by the converter running now; otherwise the files on disk are the
  // old converter's output and have to be regenerated.
  if (hasCache && entry.hash === hash && builtByThisConverter && !force) {
    entry.checkedAt = now;
    metaDirty = true;
    console.log(
      `${source.label}: fresh (verified against live page just now${version ? `, Bot API ${version}` : ''})`,
    );
    continue;
  }

  let sections;
  try {
    sections = splitSections(region, source.url, source.prose);
    // Small guide pages legitimately have fewer sections than the reference
    // pages; this catches a cold-start page that parsed to almost nothing.
    const min = source.min ?? 10;
    if (sections.length < min) {
      throw new Error(`parsed only ${sections.length} sections (expected at least ${min})`);
    }
    // The documentation only grows, so a build that shrinks is the strongest
    // signal available that something stopped being recognised — and it is the
    // only one that does not depend on knowing today's markup. An absolute floor
    // cannot provide it: when the Mini Apps page had its sub-headings demoted a
    // level, 107 sections became 15 and were published as `refreshed`, because
    // 15 clears a floor of 10. Every method and type file on that page would
    // have disappeared while the run reported success.
    // --force is the operator saying "I have looked at this, rebuild anyway",
    // which is the escape hatch for a restructuring that really did shrink.
    const before = force ? 0 : entry?.sectionCount ?? 0;
    if (before > 0 && sections.length < before * SHRINK_MIN_RATIO) {
      throw new Error(
        `section count fell from ${before} to ${sections.length} ` +
          `(${Math.round((sections.length / before) * 100)}% of the last build) — ` +
          'the page structure may have changed in a way the splitter no longer recognises',
      );
    }
  } catch (err) {
    sourceProblem(source, entry, hasCache, err.message);
    continue;
  }

  writeSections(source, sections);
  meta[source.key] = {
    url: source.url,
    // Persisted so consumers (and the consistency test) can map a meta key to
    // its cache directory without duplicating the SOURCES table.
    dir: source.dir,
    version,
    hash,
    // Which build of the converter produced these files; a mismatch on a later
    // run forces a rebuild even when the page itself has not changed.
    converter: CONVERTER_HASH,
    fetchedAt: now,
    checkedAt: now,
    sectionCount: sections.length,
    sections: sections.map(({ md, level, ...rest }) => rest),
  };
  indexDirty = true;
  metaDirty = true;
  // Persist immediately so a failure in a later source never orphans this one.
  persist();
  const prev = entry?.version;
  // Distinguish "Telegram published something new" from "we rebuilt because the
  // converter changed" — otherwise a converter bump looks like a docs update.
  const cause = hasCache && entry.hash === hash && !builtByThisConverter ? 'converter changed, ' : '';
  console.log(
    `${source.label}: refreshed (${cause}${prev && version && prev !== version ? `Bot API ${prev} → ${version}, ` : version ? `Bot API ${version}, ` : ''}${sections.length} sections)`,
  );
}

persist();
releaseOnce();
process.exit(fatal ? 1 : exitCode);
