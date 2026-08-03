#!/usr/bin/env node
/**
 * telegram-docs cache refresher.
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

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CACHE_DIR = join(SKILL_ROOT, 'cache');
const DEFAULT_MAX_AGE_S = 86_400; // 24 h

// --- CLI args ---------------------------------------------------------------

function usage() {
  return `Usage: node refresh.mjs [options]

Options:
  --force               Rebuild even when the remote content hash is unchanged
  --max-age <seconds>   Cache verification TTL (default: 86400; 0 = always check)
  --cache-dir <path>    Generated cache directory (default: <skill>/cache)
  --print-cache-dir     Print the resolved cache directory and exit
  --self-test           Run offline converter regression checks and exit
  -h, --help            Show this help and exit`;
}

const args = process.argv.slice(2);
let force = false;
let maxAgeS = DEFAULT_MAX_AGE_S;
let cacheDirArg = DEFAULT_CACHE_DIR;
let printCacheDir = false;
let selfTest = false;

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

// --- HTML → markdown --------------------------------------------------------

const ENTITIES = {
  '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'",
  '&nbsp;': ' ', '&raquo;': '»', '&laquo;': '«', '&mdash;': '—', '&ndash;': '–',
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

function absolutize(href) {
  if (href.startsWith('http')) return href;
  if (href.startsWith('#')) return `https://core.telegram.org/bots/api${href}`;
  if (href.startsWith('/')) return `https://core.telegram.org${href}`;
  return href;
}

/** Convert inline HTML (inside a paragraph/cell/list item) to markdown. */
function inlineToMd(html, baseUrl) {
  let s = html;
  // Emoji images carry the emoji in alt and become that character. A content
  // image with an empty alt (a diagram, or the Stars pricing table published as
  // a picture) must still leave a reference behind: dropping it removes
  // information silently, and no character count can notice because the tag
  // contributed no text in the first place.
  s = s.replace(/<img\b[^>]*>/g, (tag) => {
    const alt = tag.match(/\balt="([^"]*)"/)?.[1] ?? '';
    const src = tag.match(/\bsrc="([^"]*)"/)?.[1];
    // Emoji sprites are text, not illustrations: they become their character.
    const isEmoji = /\bclass="[^"]*\bemoji\b/.test(tag) || (src ?? '').includes('/img/emoji/');
    if (isEmoji || !src) return alt;
    return `![${alt}](${absolutize(src)})`;
  });
  // A <video> keeps its media in a nested <source>; neither tag contributes
  // text, so without this the whole player vanishes silently — 23 sections of
  // the guides illustrate a feature with nothing but a video.
  s = s.replace(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi, (_, attrs, inner) => {
    const src =
      inner.match(/<source\b[^>]*\bsrc="([^"]*)"/i)?.[1] ?? attrs.match(/\bsrc="([^"]*)"/)?.[1];
    const poster = attrs.match(/\bposter="([^"]*)"/i)?.[1];
    if (src) return `[video](${absolutize(src)})`;
    return poster ? `![](${absolutize(poster)})` : '';
  });
  // Preserve intentional HTML line breaks separately from source formatting
  // whitespace and numeric entities that describe control characters.
  s = s.replace(/<br\s*\/?>/g, '\u0001');
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs, (_, href, text) => {
    const inner = inlineToMd(text, baseUrl).trim();
    if (!inner) return '';
    const abs = href.startsWith('#') ? `${baseUrl}${href}` : absolutize(href);
    return `[${inner}](${abs})`;
  });
  s = s.replace(/<(?:b|strong)>(.*?)<\/(?:b|strong)>/gs, '**$1**');
  s = s.replace(/<(?:i|em)>(.*?)<\/(?:i|em)>/gs, '*$1*');
  // A <mark> badge annotates a name rather than being part of it: plain text
  // turns "signature NEW" into something a reader takes for the field name.
  s = s.replace(/<mark\b[^>]*>(.*?)<\/mark>/gs, '**$1**');
  // Code spans: strip tags INSIDE the span first, then decode, then hide the
  // result behind a placeholder. Decoding before the generic tag-strip below
  // would turn e.g. `&lt;value&gt;` into `<value>` and the stripper would eat
  // it as if it were markup (this silently gutted ~24 cache files once).
  const codeSpans = [];
  s = s.replace(/<code>(.*?)<\/code>/gs, (_, c) => {
    // A <br> inside the span already became \u0001 above; turn it into a real
    // newline here so markdownCodeSpan escapes it visibly instead of leaking
    // a raw control character into the cache.
    codeSpans.push(decodeEntities(c.replace(/<[^>]+>/g, '')).replace(/\u0001/g, '\n'));
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  s = s.replace(/<[^>]+>/g, ''); // strip anything left
  s = s.replace(/&#(?:10|x0*a);/gi, '\u0002');
  s = decodeEntities(s)
    .replace(/[ \t\r\n]+/g, ' ')
    // Preserve <br> as an explicit Markdown hard break rather than a bare
    // newline that CommonMark may collapse into an ordinary space.
    .replace(/\u0001/g, '  \n')
    .replace(/\u0002/g, '\\n');
  // Bounds-check the restore: a sentinel that does not map to a captured span
  // must vanish, not render as `undefined` or crash.
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) =>
    codeSpans[Number(i)] === undefined ? '' : markdownCodeSpan(codeSpans[Number(i)]),
  );
}

function tableToMd(html, baseUrl) {
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) =>
    [...m[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gs)].map((c) =>
      inlineToMd(c[1], baseUrl).replace(/[ \t]*\n/g, '<br>').replace(/\|/g, '\\|').trim(),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

/**
 * Index of the closing tag for an element whose body starts at `from`,
 * counting nested elements of the same name. A non-greedy `<ul>(.*?)</ul>`
 * stops at the *inner* `</ul>` of a nested list and silently truncates
 * everything after it — that is a real defect this replaces, not a hypothetical.
 */
function findClose(html, from, tag) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === '/') {
      if (depth === 0) return m.index;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return -1;
}

// Block-level start tags that implicitly close an open <p>.
const BLOCK_START = /<(?:table|div|ul|ol|blockquote|pre|h[1-6])\b/i;

// Block children of a list item that lose meaning if flattened to inline text.
const BLOCK_IN_ITEM = /<(?:ul|ol|pre|table|blockquote)\b/i;

/** Split a list body into top-level <li> bodies, skipping nested lists. */
function splitListItems(html) {
  const items = [];
  const re = /<(\/?)(ul|ol|li)\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'li') {
      if (depth > 0) continue;
      if (!closing) {
        // HTML allows an omitted </li>; a new opening tag closes the previous item.
        if (start !== -1) items.push(html.slice(start, m.index));
        start = m.index + m[0].length;
      } else if (start !== -1) {
        items.push(html.slice(start, m.index));
        start = -1;
      }
    } else if (start !== -1) {
      depth += closing ? -1 : 1;
      if (depth < 0) depth = 0;
    }
  }
  if (start !== -1) items.push(html.slice(start));
  return items;
}

/** Convert a block of section HTML to markdown. */
function blockToMd(html, baseUrl) {
  const out = [];
  // Match top-level blocks in document order. Each block is consumed whole via
  // findClose, so nesting cannot truncate it, and the scan resumes past its end.
  const openRe = /<(p|table|ul|ol|blockquote|pre|h[56]|div)(?:\s[^>]*)?>/gi;
  let cursor = 0;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    if (m.index < cursor) {
      openRe.lastIndex = cursor;
      continue;
    }
    // Content between recognized blocks is content too. The docs place an
    // image or a video in a bare <a>/<video> beside a <p> caption; collecting
    // only the matched blocks dropped it whenever a sibling block existed,
    // which is how 32 illustrations disappeared without changing any guard.
    const gap = inlineToMd(html.slice(cursor, m.index), baseUrl).trim();
    if (gap) out.push(gap);
    const tag = m[1].toLowerCase();
    const bodyStart = m.index + m[0].length;
    const closeAt = findClose(html, bodyStart, tag);
    if (closeAt === -1) continue;
    let bodyEnd = closeAt;
    let resumeAt = closeAt + tag.length + 3; // past "</tag>"
    if (tag === 'p') {
      // A <p> cannot contain block-level content: HTML closes it implicitly at
      // the next block start tag. The Bot API page relies on this, writing
      // <p><table>...</table></p>. Honouring the literal </p> would hand the
      // whole table to inlineToMd, which strips tags and flattens it into
      // run-on text — real damage that a character count cannot detect,
      // because every character survives.
      const implicit = html.slice(bodyStart, closeAt).search(BLOCK_START);
      if (implicit !== -1) {
        bodyEnd = bodyStart + implicit;
        resumeAt = bodyEnd; // rescan from the block tag itself
      }
    }
    const inner = html.slice(bodyStart, bodyEnd);
    openRe.lastIndex = resumeAt;
    cursor = resumeAt;
    switch (tag) {
      case 'p':
        out.push(inlineToMd(inner, baseUrl).trim());
        break;
      case 'table':
        out.push(tableToMd(inner, baseUrl));
        break;
      case 'ul':
      case 'ol': {
        const items = splitListItems(inner).map((raw, i) => {
          const marker = tag === 'ul' ? '-' : `${i + 1}.`;
          // Block children of an item (a nested list, but equally a <pre> or a
          // <table>) are rendered as blocks and indented underneath it. Passing
          // them to inlineToMd would strip their tags and mash a code block
          // into the surrounding prose — the webhooks guide keeps 14 of its 22
          // shell snippets inside <li> elements.
          const blockAt = raw.search(BLOCK_IN_ITEM);
          const own = blockAt === -1 ? raw : raw.slice(0, blockAt);
          const head = `${marker} ${inlineToMd(own, baseUrl).trim().replace(/\n/g, '\n  ')}`;
          if (blockAt === -1) return head;
          const sub = blockToMd(raw.slice(blockAt), baseUrl)
            .split('\n')
            .map((l) => (l ? `  ${l}` : l))
            .join('\n');
          return sub ? `${head}\n${sub}` : head;
        });
        out.push(items.join('\n'));
        break;
      }
      case 'blockquote':
        out.push(
          blockToMd(inner, baseUrl)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
        break;
      case 'pre': {
        const code = inner
          .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1')
          .replace(/<\/?code[^>]*>/g, '');
        const text = decodeEntities(code.replace(/<[^>]+>/g, '')).trim();
        // The docs' own Markdown examples contain ``` lines — the fence must
        // always be longer than any backtick run in the content.
        const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((r) => r[0].length));
        const fence = '`'.repeat(Math.max(3, longestRun + 1));
        out.push(`${fence}\n${text}\n${fence}`);
        break;
      }
      case 'h5':
      case 'h6':
        out.push(`#### ${inlineToMd(inner, baseUrl).trim()}`);
        break;
      case 'div':
        out.push(blockToMd(inner, baseUrl));
        break;
    }
  }
  const tail = inlineToMd(html.slice(cursor), baseUrl).trim();
  if (tail) out.push(tail);
  // Fallback: section had no recognized blocks but has visible text.
  if (out.length === 0) {
    const text = inlineToMd(html, baseUrl).trim();
    if (text) out.push(text);
  }
  return out.filter(Boolean).join('\n\n');
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

function markdownBodyLength(md) {
  // Link targets exist only on the markdown side; counting them would let a
  // link-heavy section hide prose the converter dropped.
  return alnumCount(md.replace(/\]\([^)]*\)/g, ']'));
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

if (selfTest) {
  const BASE = 'https://core.telegram.org/bots/api';
  const inlineCases = [
    ['<code>&#10;</code>', '`\\n`'],
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
  console.log(`self-test passed (${checks.length} converter cases)`);
  process.exit(0);
}

// --- Page splitting -----------------------------------------------------------

/** Extract the documentation content region of a core.telegram.org page. */
function contentRegion(html) {
  const start = html.indexOf('id="dev_page_content"');
  const end = html.indexOf('<div class="footer_wrap"');
  if (start === -1) throw new Error('page layout changed: no dev_page_content');
  return html.slice(start, end === -1 ? undefined : end);
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
    marks.push({
      level: Number(m[1]),
      anchor,
      title: inlineToMd(m[3], baseUrl).trim(),
      start: m.index,
      bodyStart: m.index + m[0].length,
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
  const sections = [];
  const fidelity = [];
  const structural = [];
  let currentH3 = null;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : region.length;
    if (mark.level === 3) currentH3 = mark.anchor;
    const bodyHtml = region.slice(mark.bodyStart, bodyEnd);
    const md = blockToMd(bodyHtml, baseUrl);
    const htmlLen = htmlBodyLength(bodyHtml);
    if (htmlLen >= FIDELITY_MIN_CHARS) {
      fidelity.push({ anchor: mark.anchor, ratio: markdownBodyLength(md) / htmlLen, htmlLen });
    }
    // Text volume cannot see a table flattened into a paragraph: every
    // character survives while the rows and columns are destroyed. Block
    // structure has to be counted separately.
    const n = (s, re) => (s.match(re) ?? []).length;
    for (const [kind, expected, got] of [
      ['table', n(bodyHtml, /<table\b/gi), n(md, /^[ \t]*\|[\s|:-]*---/gm)],
      ['code block', n(bodyHtml, /<pre\b/gi), Math.floor(n(md, /^[ \t]*`{3,}/gm) / 2)],
    ]) {
      if (got < expected) structural.push({ anchor: mark.anchor, kind, expected, got });
    }
    const firstPara = md.split('\n\n').find((b) => b && !b.startsWith('|') && !b.startsWith('```'));
    const summary = (firstPara ?? '').replace(/\n/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    sections.push({
      anchor: mark.anchor,
      title: mark.title,
      level: mark.level,
      parent: mark.level === 4 ? currentH3 : null,
      kind: classifySection(mark.anchor, mark.title, mark.level, mark.level === 4 ? currentH3 : null, prose),
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
    const header = [
      `# ${s.title}`,
      '',
      `> Source: ${source.url}#${s.anchor} (official Telegram documentation)`,
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

function acquireLock() {
  if (lockAcquired) return true;
  try {
    mkdirSync(LOCK_DIR);
    lockAcquired = true;
    return true;
  } catch {
    try {
      if (Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) {
        // Atomic takeover of a crashed run's lock: rename succeeds for exactly
        // one contender, so two processes can never both "acquire" here.
        const trash = `${LOCK_DIR}.stale-${process.pid}`;
        renameSync(LOCK_DIR, trash);
        rmSync(trash, { recursive: true, force: true });
        mkdirSync(LOCK_DIR);
        lockAcquired = true;
        return true;
      }
    } catch {
      // Lock vanished, another contender won the takeover, or someone re-made
      // the directory first — treat as busy this run.
    }
    return false;
  }
}

function releaseLock() {
  if (lockAcquired) {
    rmSync(LOCK_DIR, { recursive: true, force: true });
    lockAcquired = false;
  }
}

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

  if (!force && hasCache && entry.checkedAt) {
    const ageS = (Date.now() - new Date(entry.checkedAt).getTime()) / 1000;
    if (ageS < maxAgeS) {
      console.log(
        `${source.label}: fresh (cached${entry.version ? `, Bot API ${entry.version}` : ''}, checked ${hoursAgo(entry.checkedAt)}h ago, TTL not expired)`,
      );
      continue;
    }
  }

  if (!acquireLock()) {
    sourceProblem(source, entry, hasCache, 'another refresh is already running');
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

  // --force must rebuild even on an unchanged page: the converter itself may
  // have changed, and a rebuild is the only way to apply it to the cache.
  if (hasCache && entry.hash === hash && !force) {
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
    // pages; the guard still has to catch a page that parsed to almost nothing.
    const min = source.min ?? 10;
    if (sections.length < min) {
      throw new Error(`parsed only ${sections.length} sections (expected at least ${min})`);
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
  console.log(
    `${source.label}: refreshed (${prev && version && prev !== version ? `Bot API ${prev} → ${version}, ` : version ? `Bot API ${version}, ` : ''}${sections.length} sections)`,
  );
}

persist();
releaseLock();
process.exit(fatal ? 1 : exitCode);
