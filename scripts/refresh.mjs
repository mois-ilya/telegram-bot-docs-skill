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

/**
 * Attribute value from an opening tag, tolerating single quotes and unquoted
 * values. Hand-written `\battr="([^"]*)"` matchers silently returned nothing
 * for the other two forms, which HTML permits everywhere.
 */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'>]+)`, 'i'));
  if (!m) return undefined;
  const raw = m[1];
  const value = raw[0] === '"' || raw[0] === "'" ? raw.slice(1, -1) : raw;
  return decodeEntities(value);
}

/**
 * Resolve a URL found on a documentation page against that page.
 *
 * This was hand-rolled prefix matching, which passed document-relative hrefs
 * through untouched — 23 links such as `[Mini Apps](webapps)` shipped in the
 * cache, pointing at paths that do not exist once a page is split into
 * per-section files — and turned protocol-relative `//host/x` into
 * `https://core.telegram.org//host/x`. The URL parser handles every form,
 * including the `#anchor` case that was previously hardcoded to /bots/api
 * regardless of which page was being converted.
 */
function absolutize(href, baseUrl) {
  try {
    return new URL(href.trim(), baseUrl ?? 'https://core.telegram.org/bots/api').href;
  } catch {
    // A malformed href is content, not a reason to abort the refresh; keep the
    // original text rather than inventing a target.
    return href;
  }
}

/** Convert inline HTML (inside a paragraph/cell/list item) to markdown. */
function inlineToMd(html, baseUrl) {
  let s = html;
  // Emoji images carry the emoji in alt and become that character. A content
  // image with an empty alt (a diagram, or the Stars pricing table published as
  // a picture) must still leave a reference behind: dropping it removes
  // information silently, and no character count can notice because the tag
  // contributed no text in the first place.
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = attr(tag, 'alt') ?? '';
    const src = attr(tag, 'src');
    // Emoji sprites are text, not illustrations: they become their character.
    const cls = attr(tag, 'class') ?? '';
    const isEmoji = /\bemoji\b/.test(cls) || (src ?? '').includes('/img/emoji/');
    if (isEmoji || !src) return alt;
    return `![${alt}](${absolutize(src, baseUrl)})`;
  });
  // A <video> keeps its media in a nested <source>; neither tag contributes
  // text, so without this the whole player vanishes silently — 23 sections of
  // the guides illustrate a feature with nothing but a video.
  s = s.replace(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi, (_, attrs, inner) => {
    const sourceTag = inner.match(/<source\b[^>]*>/i)?.[0] ?? '';
    const src = attr(sourceTag, 'src') ?? attr(attrs, 'src');
    const poster = attr(attrs, 'poster');
    if (src) return `[video](${absolutize(src, baseUrl)})`;
    return poster ? `![](${absolutize(poster, baseUrl)})` : '';
  });
  // Preserve intentional HTML line breaks separately from source formatting
  // whitespace and numeric entities that describe control characters.
  s = s.replace(/<br\s*\/?>/g, '\u0001');
  s = s.replace(/(<a\b[^>]*>)(.*?)<\/a>/gis, (_, tag, text) => {
    const href = attr(tag, 'href');
    const inner = inlineToMd(text, baseUrl).trim();
    if (href === undefined) return inner; // an anchor target, not a link
    if (!inner) return '';
    return `[${inner}](${absolutize(href, baseUrl)})`;
  });
  // Emphasis tags carry attributes in real markup; matching only the bare form
  // dropped the markers and left the text looking like ordinary prose. Empty
  // emphasis emits nothing: the anchor icon before every heading is an <i> with
  // no content, and turning it into bare markers forges visible text.
  const emphasize = (marker) => (_, __, body) => (body.trim() ? `${marker}${body}${marker}` : '');
  s = s.replace(/<(b|strong)\b[^>]*>(.*?)<\/\1>/gis, emphasize('**'));
  s = s.replace(/<(i|em)\b[^>]*>(.*?)<\/\1>/gis, emphasize('*'));
  // A <mark> badge annotates a name rather than being part of it: plain text
  // turns "signature NEW" into something a reader takes for the field name.
  s = s.replace(/<mark\b[^>]*>(.*?)<\/mark>/gs, '**$1**');
  // Code spans: strip tags INSIDE the span first, then decode, then hide the
  // result behind a placeholder. Decoding before the generic tag-strip below
  // would turn e.g. `&lt;value&gt;` into `<value>` and the stripper would eat
  // it as if it were markup (this silently gutted ~24 cache files once).
  const codeSpans = [];
  s = s.replace(/<code\b[^>]*>(.*?)<\/code>/gis, (_, c) => {
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

/**
 * Rows of a table body, in document order.
 *
 * Matching `<tr>(.*?)</tr>` recognised only the bare tag, so a single
 * `<tr class="new">` — exactly how these pages mark something newly added —
 * dropped that row while leaving the Markdown table structurally valid. In the
 * 95-row currency table that deleted the header and promoted the first data row
 * into its place: a table that still looks right and is no longer true. HTML
 * also permits `</tr>` to be omitted, so a row ends at the next row or at the
 * end of the table body, whichever comes first.
 */
function splitRows(html) {
  const openRe = /<tr\b[^>]*>/gi;
  const starts = [...html.matchAll(openRe)];
  return starts.map((m, i) => {
    const from = m.index + m[0].length;
    const explicit = html.slice(from).search(/<\/tr\s*>/i);
    const nextRow = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const end = explicit === -1 ? nextRow : Math.min(from + explicit, nextRow);
    return html.slice(from, end);
  });
}

function tableToMd(html, baseUrl) {
  const rows = splitRows(html).map((body) =>
    [...body.matchAll(/<t([hd])\b[^>]*>([\s\S]*?)(?=<\/t\1\s*>|<t[hd]\b|$)/gi)].map((c) =>
      inlineToMd(c[2], baseUrl).replace(/[ \t]*\n/g, '<br>').replace(/\|/g, '\\|').trim(),
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

/**
 * Language label for a code fence, read from the markup and never guessed.
 *
 * Telegram currently tags 4 of the 53 code blocks it publishes, as
 * `<code class="lang-json">` on the Mini Apps OAuth examples. That is source
 * metadata and discarding it is the same class of fidelity loss as dropping
 * text, so it is carried onto the fence. The other 49 get no hint: there is no
 * signal in the markup, and content-sniffing is unsafe here — most of them are
 * not code at all but MarkdownV2 syntax samples and bare URLs set in a monospace
 * font, and the block that looks most like JSON is an openssl INI config. A
 * wrong language would be indistinguishable from documented fact.
 *
 * The label is read from either the <pre> or the <code> tag, under any of the
 * conventions in common use, and from any position in a multi-class list, so a
 * value Telegram does not currently emit still comes through if it appears.
 * Anything outside the allowlist is dropped rather than written: the label lands
 * on the fence line, where a stray backtick or newline would break the block.
 */
function codeFenceLang(preTag, inner) {
  const codeTag = inner.match(/<code\b[^>]*>/i)?.[0] ?? '';
  for (const tag of [codeTag, preTag]) {
    const found =
      tag.match(/\bclass="[^"]*?\b(?:lang|language|highlight|brush)-([^\s"]+)/i)?.[1] ??
      tag.match(/\bdata-lang(?:uage)?="([^"]+)"/i)?.[1];
    // Deliberately not a bare `lang=`: in HTML that attribute carries the
    // natural language of the content, so <pre lang="en"> would produce an
    // ```en fence.
    if (found === undefined) continue;
    const lang = decodeEntities(found).trim().toLowerCase();
    // Real language names: c++, c#, objective-c, f#, asp.net, shell-session.
    if (/^[a-z0-9][a-z0-9+#._-]{0,19}$/.test(lang)) return lang;
  }
  return '';
}

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
        const lang = codeFenceLang(m[0], inner);
        const code = inner
          .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1')
          .replace(/<\/?code[^>]*>/g, '');
        const text = decodeEntities(code.replace(/<[^>]+>/g, '')).trim();
        // The docs' own Markdown examples contain ``` lines — the fence must
        // always be longer than any backtick run in the content.
        const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((r) => r[0].length));
        const fence = '`'.repeat(Math.max(3, longestRun + 1));
        out.push(`${fence}${lang}\n${text}\n${fence}`);
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
const FIDELITY_MAX_RATIO = 1.3;
const MASS_MAX_RATIO = 1.05;

// Catastrophe detectors for whole categories of inline markup. These do not try
// to notice one lost link; they notice a markup change that makes the converter
// stop recognising links or code spans at all. That is the observed failure
// shape: matching only bare tags meant a single added attribute took out every
// instance at once. Page-level ratios measured across the ten sources are
// 0.64-1.06 for links and 0.96-1.01 for code spans outside <pre>, against
// near-zero for the failures these catch, so the floors sit far from both.
const LINK_MIN_RATIO = 0.4;
const CODE_MIN_RATIO = 0.6;
const INLINE_GUARD_MIN_COUNT = 20;

/** Count inline code spans in markdown, skipping fenced blocks. */
function countCodeSpans(md) {
  let fence = null;
  let total = 0;
  for (const line of md.split('\n')) {
    const f = line.match(/^[ \t]*(`{3,})(.*)$/);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (fence === null) total += Math.floor((line.match(/`+/g) ?? []).length / 2);
  }
  return total;
}

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
  console.log(`self-test passed (${checks.length} converter cases)`);
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
function contentRegion(html) {
  const start = html.indexOf('id="dev_page_content"');
  const end = html.indexOf('<div class="footer_wrap"');
  if (start === -1) throw new Error('page layout changed: no dev_page_content');
  // Start past the end of the container's own opening tag. Slicing from the
  // attribute would leave `id="dev_page_content">` as bare text ahead of the
  // first tag, which the converter would faithfully carry into the output.
  const openEnd = html.indexOf('>', start);
  if (openEnd === -1) throw new Error('page layout changed: unterminated dev_page_content tag');
  // A missing footer marker used to mean "take everything to the end of the
  // document", so renaming that class would silently append the site footer and
  // navigation to the last section. Every guard would accept it, because the
  // extra material is converted faithfully and accounted for. Refusing instead
  // costs one STALE run and cannot corrupt the cache.
  if (end === -1 || end < openEnd) {
    throw new Error('page layout changed: no footer_wrap after the content region');
  }
  return html.slice(openEnd + 1, end);
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
    // Table rows are counted exactly, not as a ratio: across 573 sections with
    // tables the markdown line count equals <tr> plus one separator line per
    // table, with zero exceptions. Counting only whole tables let a dropped row
    // through — losing the header row of the 95-currency table promoted the
    // first data row into its place, leaving a table that still parses, still
    // passes every text-volume check, and is no longer true.
    const expectedRows = n(bodyHtml, /<tr\b/gi) + n(bodyHtml, /<table\b/gi);
    const gotRows = n(md, /^[ \t]*\|/gm);
    if (expectedRows > 0 && gotRows !== expectedRows) {
      structural.push({ anchor: mark.anchor, kind: 'table row', expected: expectedRows, got: gotRows });
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
  // Whole categories of inline markup disappear at once when a tag pattern
  // stops matching, and nothing above can see it: link targets are excluded
  // from the text comparison by design, and emphasis and backticks are
  // punctuation that no character count weighs.
  const nAll = (s, re) => (s.match(re) ?? []).length;
  const mdAll = sections.map((s) => s.md).join('\n');
  const htmlLinks = nAll(region, /<a\b[^>]*\bhref\s*=/gi);
  const mdLinks = nAll(mdAll, /\]\(/g);
  if (htmlLinks >= INLINE_GUARD_MIN_COUNT && mdLinks / htmlLinks < LINK_MIN_RATIO) {
    throw new Error(
      `only ${mdLinks} of ${htmlLinks} links survived conversion — ` +
        'the converter may no longer recognise this page\'s link markup',
    );
  }
  // <code> inside <pre> becomes a fence, not a span, so it is excluded here;
  // with that exclusion the two counts match almost exactly in practice.
  const htmlSpans =
    nAll(region, /<code\b/gi) - nAll(region, /<pre\b[^>]*>\s*<code\b/gi);
  const mdSpans = countCodeSpans(mdAll);
  if (htmlSpans >= INLINE_GUARD_MIN_COUNT && mdSpans / htmlSpans < CODE_MIN_RATIO) {
    throw new Error(
      `only ${mdSpans} of ${htmlSpans} inline code spans survived conversion — ` +
        'the converter may no longer recognise this page\'s <code> markup',
    );
  }
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
