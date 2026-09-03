#!/usr/bin/env node
/**
 * md2pdf.cjs — конвертация текста/markdown/HTML в PDF (A4, кириллица).
 *
 * Использование:  node md2pdf.cjs <входной-файл> <выходной-pdf> [html-out]
 *
 * Правила:
 *   .md / .markdown — полный Markdown (marked, GFM): заголовки, списки,
 *                     ТАБЛИЦЫ, инлайн-код, bold/italic, ссылки, цитаты,
 *                     task-списки; fenced-код — с ПОДСВЕТКОЙ синтаксиса
 *                     (highlight.js, тема atom-one-dark);
 *   .html / .htm    — рендер как есть (стили берутся из файла);
 *   остальное       — verbatim в <pre> (monospace, soft wrap).
 *
 * Шрифты: DejaVu Sans / DejaVu Sans Mono (системные), подстановка подмножества
 * в PDF делает ToUnicode — текст копируется и ищется.
 *
 * Требуется: node + playwright + Chromium (в ~/.cache/ms-playwright).
 * marked/highlight.js берутся из node_modules пакета pi (или из PATH-модулей).
 */
'use strict';

let pw;
try {
  pw = require('/home/pi/.pi/agent/npm/node_modules/playwright');
} catch (e) {
  pw = require('playwright');
}
const {chromium} = pw;
const fs = require('fs');
const path = require('path');

// ── поиск зависимостей (node_modules пакета pi в первую очередь) ──────────
function findModule(pkg) {
  const cands = [pkg];
  try {
    cands.push(`/home/pi/.pi/agent/npm/node_modules/${pkg}`);
    const base = '/home/pi/.local/share/pi-node';
    for (const v of fs.readdirSync(base).sort().reverse()) {
      const nm = path.join(base, v, 'lib', 'node_modules');
      if (fs.existsSync(nm)) {
        cands.push(path.join(nm, pkg));
        cands.push(path.join(nm, '@earendil-works', 'pi-coding-agent', 'node_modules', pkg));
      }
    }
  } catch { /* ignore */ }
  for (const c of cands) {
    try { return require(c); } catch { /* следующая */ }
  }
  return null;
}

const markedMod = findModule('marked');
const marked = markedMod && (markedMod.marked || markedMod);
const hljs = findModule('highlight.js');

// CSS темы для подсветки (atom-one-dark) — инлайним в сам HTML
function loadHljsTheme() {
  try {
    const cands = [];
    const base = '/home/pi/.local/share/pi-node';
    for (const v of fs.readdirSync(base).sort().reverse()) {
      const nm = path.join(base, v, 'lib', 'node_modules');
      if (fs.existsSync(nm)) {
        cands.push(path.join(nm, '@earendil-works', 'pi-coding-agent', 'node_modules', 'highlight.js', 'styles', 'atom-one-dark.css'));
        cands.push(path.join(nm, 'highlight.js', 'styles', 'atom-one-dark.css'));
      }
    }
    for (const c of cands) if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8');
  } catch { /* ignore */ }
  return '';
}

// ── утилиты HTML ────────────────────────────────────────────────
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/"/g, '&quot;');  // '>' не трогам: легально в текстовом контексте и нужен для <blockquote>

function inline(s) {
  // s уже экранирован на уровне блока; обрабатываем разметку
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');                       // инлайн-код
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');            // **bold**
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');            // *italic*
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');                      // ~~strike~~
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');  // [t](u)
  return s;
}

function mdToHtmlFallback(md) {
  // Резервный минимальный рендер, если marked недоступен (заголовки, списки, code, bold/italic, ссылки, цитаты)
  const lines = esc(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  let list = null; // 'ul' | 'ol'

  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara(); flushList();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    // GFM-таблица (упрощённо: строки |a|b|, разделитель |---|)
    if (/^\s*\|(.+)\|\s*$/.test(line) && i + 1 < lines.length &&
        /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const isHead = /\|[\s:|-]+\|/.test(lines[i + 1]);
      if (isHead) {
        flushPara(); flushList();
        const rows = ['<table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>'];
        i += 2;
        while (i < lines.length && /^\s*\|(.+)\|\s*$/.test(lines[i])) {
          rows.push('<tr>' + parseRow(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
          i++;
        }
        rows.push('</tbody></table>');
        out.push(rows.join(''));
      }
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_]){3,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); i++; continue; }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); flushList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); i++; continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      i++; continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara(); flushList();
  return out.join('\n');
}

// ── рендерер Markdown (marked + подсветка) ─────────────────────
function mdToHtml(md) {
  if (!marked) {
    console.error('md2pdf: warned — marked недоступен, использую запасной рендерер (без таблиц/подсветки)');
    return mdToHtmlFallback(md);
  }
  try {
    marked.use({
      gfm: true,
      breaks: true,
      renderer: {
        code(t) {
          const text = typeof t === 'string' ? t : (t.text || '');
          const langRaw = typeof t === 'string' ? arguments[1] : (t.lang || '');
          const lang = String(langRaw || '').trim().split(/\s+/)[0].toLowerCase();
          let html;
          let cls = '';
          const H = hljs;
          if (H && typeof H.getLanguage === 'function' && lang && H.getLanguage(lang)) {
            try { html = H.highlight(text, {language: lang, ignoreIllegals: true}).value; cls = 'language-' + lang; }
            catch { html = undefined; }
          }
          if (html === undefined && H && typeof H.highlightAuto === 'function' && text) {
            try { const r = H.highlightAuto(text); if (r && r.relevance >= 2) html = r.value; } catch { /* ignore */ }
          }
          if (html === undefined) html = esc(text);
          return `<pre class="hljs"><code class="hljs ${cls}">${html}</code></pre>`;
        },
      },
    });
    const body = marked.parse(md);
    return typeof body === 'string' ? body : String(body);
  } catch (e) {
    console.error('md2pdf: marked.parse: ' + (e && e.message || e) + ' — запасной рендерер');
    return mdToHtmlFallback(md);
  }
}

const PAGE_CSS = `
  html { font-size: 11pt; }
  body { font-family: 'DejaVu Sans', sans-serif; line-height: 1.5; color: #1f2328; }
  h1,h2,h3,h4,h5,h6 { font-family:'DejaVu Sans',sans-serif; line-height:1.25; margin:0.95em 0 0.45em; color:#0d1117; }
  h1 { font-size:1.75em; border-bottom:1px solid #d0d7de; padding-bottom:.3em; }
  h2 { font-size:1.45em; border-bottom:1px solid #e6e8eb; padding-bottom:.22em; }
  h3 { font-size:1.22em; } h4 { font-size:1.08em; }
  p { margin: 0 0 0.7em; }
  ul,ol { margin:0 0 0.8em; padding-left:1.7em; }
  li { margin:0.18em 0; }
  li > ul, li > ol { margin: 0.2em 0 0.2em; }
  del { color:#57606a; text-decoration:line-through; }
  a { color:#0969da; text-decoration:none; }
  hr { border:none; border-top:1px solid #d8dee4; margin:1.1em 0; }
  blockquote { margin:0 0 0.85em; padding:4px 14px; border-left:4px solid #d0d7de;
               background:#f6f8fa; color:#444c56; border-radius:0 4px 4px 0; }
  input[type="checkbox"] { margin-right:6px; accent-color:#0969da; }
  code { font-family:'DejaVu Sans Mono',monospace; font-size:0.88em;
         background:#eff1f3; color:#cf222e; padding:1.5px 4.5px; border-radius:4px; }
  pre { font-family:'DejaVu Sans Mono',monospace; font-size:9.5pt; line-height:1.5;
        margin:0 0 0.9em; border-radius:6px; padding:10px 12px;
        white-space:pre-wrap; word-break:break-word; overflow:hidden; }
  pre code { background:none; color:inherit; padding:0; font-size:1em; }
  /* таблицы */
  table { border-collapse:collapse; margin:0 0 0.9em; width:auto; max-width:100%; }
  th,td { border:1px solid #d0d7de; padding:5px 10px; vertical-align:top;
          word-wrap:break-word; overflow-wrap:break-word; }
  thead th { background:#eef1f4; font-weight:bold; text-align:left; }
  tbody tr:nth-child(even) { background:#f6f8fa; }
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  /* тема подсветки (atom-one-dark) шрифт перекрываем: DejaVu Sans Mono — кириллица */
  .hljs, pre.hljs, pre.hljs code, code.hljs { font-family:'DejaVu Sans Mono',monospace; }
`;

// ── main ────────────────────────────────────────────────────────
const [inPath, outPath, htmlOut] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('использование: node md2pdf.cjs <in> <out.pdf> [html-out]');
  process.exit(2);
}
const raw = fs.readFileSync(inPath, 'utf8');
const ext = (inPath.match(/\.[^.]+$/) || [''])[0].toLowerCase();

const themeCss = hljs ? loadHljsTheme() : '';

let body;
if (ext === '.html' || ext === '.htm') {
  body = raw; // как есть: у файла уже есть свои head/стили
  if (!/<\s*html[\s>]/i.test(body)) body = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
} else if (ext === '.md' || ext === '.markdown') {
  body = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PAGE_CSS}\n${themeCss}\n</style></head><body>${mdToHtml(raw)}</body></html>`;
} else {
  body = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PAGE_CSS}\n</style></head><body><pre>${esc(raw)}</pre></body></html>`;
}

(async () => {
  if (htmlOut) fs.writeFileSync(htmlOut, body); // отладка/скриншоты
  const browser = await chromium.launch({args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb']});
  try {
    const page = await browser.newPage();
    await page.setViewportSize({width: 1000, height: 1400});
    await page.setContent(body, {waitUntil: 'load'});
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: false,
      margin: {top: '1.9cm', bottom: '1.9cm', left: '1.6cm', right: '1.6cm'},
    });
  } finally {
    await browser.close();
  }
  console.log(`PDF: ${outPath} (${fs.statSync(outPath).size} bytes)`);
})().catch((e) => {
  console.error('md2pdf: ' + (e && e.message || e));
  process.exit(1);
});
