#!/usr/bin/env node
// Render docs/WHITEPAPER_EN.md to PDF. Optional documentation tooling, not a protocol dependency.
// Zero npm dependencies: converts the limited Markdown used by the paper to HTML, then prints it with a
// locally installed Chrome/Chromium (CHROME=/path/to/binary to override). Fonts come from the host system,
// so line breaks and PDF bytes depend on the machine; the footer carries the Markdown's SHA-256 prefix.
//
//   node docs/tools/render-whitepaper-en.mjs [output.pdf] [--html output.html] [--theme classic|modern]
// The default "classic" theme follows the layout of the Bitcoin whitepaper: US Letter, Times, centred title,
// run-in indented abstract, plain numbered headings, continuous flow, [n] references, page number only.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = join(ROOT, 'docs/WHITEPAPER_EN.md');
const args = process.argv.slice(2);
const htmlFlag = args.indexOf('--html');
const htmlOut = htmlFlag >= 0 ? resolve(args.splice(htmlFlag, 2)[1]) : null;
const themeFlag = args.indexOf('--theme');
const THEME = themeFlag >= 0 ? args.splice(themeFlag, 2)[1] : 'classic';
if (!['classic', 'modern'].includes(THEME)) throw new Error('--theme must be classic or modern');
const classic = THEME === 'classic';
const OUTPUT = resolve(args[0] ?? join(ROOT, 'docs/WHITEPAPER_EN.pdf'));

const markdown = readFileSync(SOURCE, 'utf8');
const digest = createHash('sha256').update(markdown).digest('hex').slice(0, 12);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:)]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/§(\d+(?:\.\d+)?)/g, '§&#8288;$1')
    // Digit groups written with spaces ("969 546") must not break across lines.
    .replace(/(\d) (?=\d{3}(?!\d))/g, '$1\u202F');
  // Short code spans are atomic so justification never stretches the spaces inside them.
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const c = codes[Number(i)];
    return `<code${c.length <= (classic ? 18 : 44) ? ' class="atom"' : ''}>${esc(c)}</code>`;
  });
}

const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function render(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let h2Count = 0;
  let title = '';
  let metaLeft = 0;       // classic: centred metadata lines under the title
  let inAbstract = false; // classic: paragraphs until the next rule form the abstract block
  let refs = false;       // classic: the next ordered list is the bibliography
  const isTableSep = (l) => /^\|\s*:?-{3,}/.test(l);
  const isBlockStart = (l) =>
    /^(#{1,4} |```|> |---\s*$|<!--|\|)/.test(l) || /^\s*(- |\d+\. )/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^<!--\s*pagebreak\s*-->/.test(line)) { if (!classic) out.push('<div class="pagebreak"></div>'); i++; continue; }
    if (/^---\s*$/.test(line)) {
      if (inAbstract) { out.push('</div>'); inAbstract = false; }
      if (!classic) out.push('<hr>');
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4}) (.*)$/);
    if (h) {
      const level = h[1].length;
      const body = inline(h[2]);
      if (level === 2) h2Count++;
      if (classic && level === 1) { title = body; i++; continue; }
      // The first h2 directly under the title is the subtitle.
      if (level === 2 && h2Count === 1) {
        if (classic) {
          const [name, ...rest] = title.split(' · ');
          out.push(`<h1 class="title">${name}: ${body}</h1>`);
          if (rest.length) out.push(`<p class="meta">${rest.join(' · ')}</p>`);
          metaLeft = 2;
        } else out.push(`<p class="subtitle">${body}</p>`);
        i++;
        continue;
      }
      if (classic && level === 2 && h[2] === 'Abstract') { out.push('<div class="abstract">'); inAbstract = true; i++; continue; }
      if (classic && level === 2 && h[2] === 'Contents') {
        // The classic layout flows continuously and carries no table of contents.
        i++;
        while (i < lines.length && !/^(<!--|## )/.test(lines[i])) i++;
        continue;
      }
      if (inAbstract) { out.push('</div>'); inAbstract = false; }
      refs = classic && h[2] === 'References';
      out.push(`<h${level} id="${slug(h[2])}">${body}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="${lang === 'bash' ? 'shell' : 'formula'}"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.startsWith('> ')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(classic ? `<p class="note">${inline(buf.join(' '))}</p>` : `<aside class="status"><p>${inline(buf.join(' '))}</p></aside>`);
      continue;
    }
    if (line.startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? 'right' : 'left'));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      const th = head.map((c, k) => `<th style="text-align:${align[k]}">${inline(c)}</th>`).join('');
      const tb = rows
        .map((r) => `<tr>${r.map((c, k) => `<td style="text-align:${align[k]}">${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }
    const li = line.match(/^(\s*)(- |\d+\. )(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(- |\d+\. )(.*)$/);
        if (m) { items.push(m[3]); i++; continue; }
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}${refs && ordered ? ' class="refs"' : ''}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++].trim());
    const text = buf.join(' ');
    if (metaLeft > 0) { metaLeft--; out.push(`<p class="meta">${inline(text)}</p>`); continue; }
    if (inAbstract && !out[out.length - 1].startsWith('<p')) {
      out.push(`<p><strong>Abstract.</strong> ${inline(text)}</p>`);
      continue;
    }
    const cls = /^\*\*Table \d+\./.test(text) ? ' class="caption"'
      : /^\*\*(Proposition|Lemma) \d+/.test(text) ? ' class="proposition"'
      : /^\*Proof\.\*/.test(text) ? ' class="proof"' : '';
    out.push(`<p${cls}>${inline(text)}</p>`);
  }
  return out.join('\n');
}

const classicCss = `
@page { size: letter; margin: 1in 1in 0.9in 1in;
  @bottom-center { content: counter(page); font: 10pt "Times New Roman", Times, serif; color: #000; } }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #000; background: #fff;
  font: 10.5pt/1.32 "Times New Roman", Times, "STIX Two Text", "Songti SC", serif; hyphens: auto; }
h1.title { font: bold 15pt/1.3 "Times New Roman", Times, serif; text-align: center; margin: 0 0.3in 10pt; }
.meta { text-align: center !important; margin: 0 0 2pt !important; font-size: 10.5pt; hyphens: none; }
.meta + .meta + .meta { font-size: 9pt; }
.meta code { font-size: 9pt; }
p.note { margin: 12pt 0.5in 0 !important; font-size: 9pt; line-height: 1.3; text-align: justify; }
.abstract { margin: 14pt 0.5in 18pt; }
.abstract p { margin: 0 0 6pt; text-indent: 0; }
h2 { font: bold 12pt/1.3 "Times New Roman", Times, serif; margin: 16pt 0 6pt; break-after: avoid; }
h3 { font: bold 10.5pt/1.3 "Times New Roman", Times, serif; margin: 11pt 0 4pt; break-after: avoid; }
h4 { font: italic 10.5pt/1.3 "Times New Roman", Times, serif; margin: 9pt 0 3pt; break-after: avoid; }
p { margin: 0 0 7pt; text-align: justify; orphans: 2; widows: 2; }
code { font: 9pt "Courier New", Courier, monospace; color: #000; hyphens: none; overflow-wrap: anywhere; }
code.atom { display: inline-block; text-indent: 0; }
pre { margin: 4pt 0 8pt 0.2in; padding: 0; white-space: pre-wrap; break-inside: avoid; }
pre code { font-size: 8.4pt; line-height: 1.35; overflow-wrap: normal; }
ul, ol { margin: 0 0 7pt; padding-left: 0.3in; }
li { margin: 0 0 3pt; text-align: justify; }
ol.refs { list-style: none; padding-left: 0.3in; counter-reset: ref; }
ol.refs li { counter-increment: ref; text-indent: -0.3in; text-align: left; }
ol.refs li::before { content: "[" counter(ref) "]"; display: inline-block; width: 0.3in; text-indent: 0; }
table { border-collapse: collapse; margin: 4pt auto 10pt; font-size: 9pt; line-height: 1.25; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { font-weight: bold; border-top: 0.8pt solid #000; border-bottom: 0.5pt solid #000; padding: 2.5pt 6pt; vertical-align: bottom; }
td { padding: 2pt 6pt; vertical-align: top; }
tbody tr:last-child td { border-bottom: 0.8pt solid #000; }
td code { font-size: 8.3pt; }
.caption { text-align: center; margin: 10pt 0 3pt; break-after: avoid; }
.caption strong { font-weight: normal; }
.proposition { margin: 8pt 0 4pt; break-inside: avoid; }
.proof { margin-bottom: 8pt; }
em { font-style: italic; }
a { color: #000; text-decoration: none; }
`;

const css = `
@page { size: A4; margin: 22mm 21mm 24mm 21mm;
  @bottom-left { content: "WUJI Technical Whitepaper v1.0"; font: 7.5pt "Helvetica Neue", Arial, sans-serif; color: #6b7480; }
  @bottom-center { content: counter(page) " / " counter(pages); font: 8pt "Helvetica Neue", Arial, sans-serif; color: #6b7480; }
  @bottom-right { content: "source sha256 ${digest}"; font: 7.5pt "SF Mono", Menlo, monospace; color: #9aa2ab; }
}
@page :first { @bottom-left { content: none; } @bottom-right { content: none; } @bottom-center { content: none; } }
:root { --ink: #16202b; --muted: #5b6672; --rule: #cfd6dd; --accent: #8a5a12; --code: #2f4b63; --tint: #f5f3ee; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: var(--ink); background: #fff;
  font: 10.4pt/1.52 Charter, "Bitstream Charter", "Iowan Old Style", Georgia, "Songti SC", serif;
  hyphens: auto; text-rendering: optimizeLegibility; font-variant-numeric: oldstyle-nums proportional-nums; }
h1, h2, h3, h4, .subtitle, th, .caption, aside, .meta { font-family: "Helvetica Neue", Helvetica, Arial, "PingFang SC", sans-serif; }
h1 { font-size: 34pt; font-weight: 700; letter-spacing: -0.01em; margin: 34mm 0 4mm; line-height: 1.1; }
.subtitle { font-size: 16pt; line-height: 1.3; font-weight: 400; color: #24313d; margin: 0 0 12mm; max-width: 150mm; }
h1 + .subtitle + p, h1 + .subtitle + p + p { font: 9.5pt/1.5 "Helvetica Neue", Arial, sans-serif; color: var(--muted); margin: 0 0 1.5mm; hyphens: none; }
h2 { font-size: 15pt; font-weight: 700; margin: 0 0 3.5mm; padding-top: 2mm; break-after: avoid; }
h3 { font-size: 11pt; font-weight: 700; color: var(--accent); margin: 5mm 0 1.8mm; break-after: avoid; }
h4 { font-size: 10pt; margin: 4mm 0 1.5mm; break-after: avoid; }
p { margin: 0 0 2.6mm; text-align: left; orphans: 3; widows: 3; }
strong { font-weight: 700; }
code { font: 8.6pt "SF Mono", Menlo, Consolas, monospace; color: var(--code); font-variant-numeric: normal; hyphens: none; overflow-wrap: anywhere; }
pre { margin: 2mm 0 3.4mm; padding: 2.6mm 3.6mm; background: var(--tint); border-left: 2px solid var(--accent);
  white-space: pre-wrap; break-inside: avoid; }
code.atom { display: inline-block; text-indent: 0; }
pre code { font-size: 8.4pt; line-height: 1.5; color: #1f2d3a; overflow-wrap: normal; }
pre.shell { border-left-color: #5d7a92; }
hr { border: 0; border-top: 0.6pt solid var(--rule); margin: 6mm 0; }
.pagebreak { break-after: page; }
aside.status { margin: 8mm 0 6mm; padding: 3.5mm 4.5mm; border: 0.7pt solid var(--rule); border-left: 3px solid #b23b2e;
  background: #fbf9f6; font-size: 8.9pt; line-height: 1.5; }
aside.status p { margin: 0; text-align: left; }
ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
li { margin: 0 0 1.4mm; }
table { width: 100%; border-collapse: collapse; margin: 1.5mm 0 4.5mm; font-size: 8.7pt; line-height: 1.38; break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { font-size: 8pt; font-weight: 700; text-transform: none; color: #2a3744; border-bottom: 0.9pt solid #6e7a86; padding: 1.4mm 2mm; vertical-align: bottom; }
td { border-bottom: 0.4pt solid var(--rule); padding: 1.3mm 2mm; vertical-align: top; }
td code { font-size: 7.8pt; }
.caption { font-size: 8.8pt; margin: 4mm 0 1mm; text-align: left; break-after: avoid; }
.proposition { background: #f3f6f8; border-left: 2px solid #4d6b82; padding: 2.2mm 3.4mm; margin: 3mm 0 2mm; break-inside: avoid; }
.proof { font-size: 9.8pt; color: #2b3540; margin-bottom: 3.4mm; }
em { font-style: italic; }
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>WUJI Technical Whitepaper v1.0</title><style>${classic ? classicCss : css}</style></head>
<body>${render(markdown)}</body></html>`;

if (htmlOut) writeFileSync(htmlOut, html);

const candidates = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) throw new Error('No Chrome/Chromium found; set CHROME=/path/to/binary');

const work = mkdtempSync(join(tmpdir(), 'wuji-paper-'));
try {
  const page = join(work, 'paper.html');
  writeFileSync(page, html);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--no-first-run',
    `--user-data-dir=${join(work, 'profile')}`, `--print-to-pdf=${OUTPUT}`, pathToFileURL(page).href,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (!existsSync(OUTPUT) || statSync(OUTPUT).size < 10_000) throw new Error('PDF was not produced');
console.log(`${OUTPUT} (${statSync(OUTPUT).size} bytes, source sha256 ${digest})`);
