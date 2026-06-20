#!/usr/bin/env node
/**
 * Builds packs/default/plugins/text-selection/script.dap by bundling the
 * relevant Yomitan source files into a single self-contained IIFE.
 *
 * Usage:
 *   node scripts/build-text-selection.mjs [yomitan-version-tag]
 *
 * If no version tag is given, the latest stable Yomitan release is fetched
 * from the GitHub API.
 *
 * Outputs:
 *   packs/default/plugins/text-selection/script.dap  — the bundled plugin
 *   packs/default/plugins/text-selection/plugin.dapm — updated version field
 *   packs/default/index.json                         — updated version for this plugin
 */

import { execSync } from 'child_process';
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { get } from 'https';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { createUnzip } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ── helpers ──────────────────────────────────────────────────────────────────

function httpsGet(url, opts = {}) {
  return new Promise((res, rej) => {
    const req = get(url, { headers: { 'User-Agent': 'da-lang-plugins-builder' }, ...opts }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        httpsGet(r.headers.location, opts).then(res, rej);
        return;
      }
      res(r);
    });
    req.on('error', rej);
  });
}

async function httpsGetJson(url) {
  const res = await httpsGet(url);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function download(url, destPath) {
  const res = await httpsGet(url);
  const out = createWriteStream(destPath);
  await pipeline(res, out);
}

function extractZip(zipPath, destDir) {
  // Use the system unzip — available on all GH-hosted runners and macOS
  mkdirSync(destDir, { recursive: true });
  execSync(`unzip -q -o "${zipPath}" -d "${destDir}"`);
}

// ── version resolution ────────────────────────────────────────────────────────

async function resolveYomitanVersion(requested) {
  if (requested) return requested.startsWith('v') ? requested : `v${requested}`;
  console.log('Fetching latest stable Yomitan release…');
  const release = await httpsGetJson(
    'https://api.github.com/repos/yomidevs/yomitan/releases/latest',
  );
  return release.tag_name;
}

// ── download + extract ────────────────────────────────────────────────────────

async function fetchYomitanSource(tag) {
  const tmp = tmpdir();
  const zipPath = join(tmp, `yomitan-${tag}.zip`);
  const extractDir = join(tmp, `yomitan-${tag}`);

  const zipUrl = `https://github.com/yomidevs/yomitan/archive/refs/tags/${tag}.zip`;
  console.log(`Downloading Yomitan ${tag} from ${zipUrl}…`);
  await download(zipUrl, zipPath);

  console.log('Extracting…');
  extractZip(zipPath, extractDir);

  // GitHub archives extract to <repo>-<tag-without-v>/
  const innerName = `yomitan-${tag.replace(/^v/, '')}`;
  const srcDir = join(extractDir, innerName, 'ext', 'js');
  console.log(`Yomitan source root: ${srcDir}`);
  return { srcDir, tag, extractDir, zipPath };
}

// ── esbuild bundle ────────────────────────────────────────────────────────────

/**
 * Returns the JS source for the esbuild entry point.
 * It imports the Yomitan classes and wires them to the `da` bridge.
 */
function entrySource(srcDir) {
  const gen = join(srcDir, 'dom', 'text-source-generator.js').replace(/\\/g, '/');
  const scanner = join(srcDir, 'dom', 'dom-text-scanner.js').replace(/\\/g, '/');
  return `
import { TextSourceGenerator } from '${gen}';
import { DOMTextScanner } from '${scanner}';

// ── settings (kept in sync with plugin.dapm) ──────────────────────────────────
let _s = {
  scanLength:          16,
  scanDelay:           20,
  layoutAwareScan:     true,
  deepDomScan:         false,
  normalizeCssZoom:    true,
  scanOnHover:         true,
  scanOnTouchTap:      true,
  scanOnTouchMove:     false,
  sentenceExtent:      200,
  alphanumeric:        true,
  selectText:          true,
  scanWithoutMouseMove: true,
};

const _generator = new TextSourceGenerator();

if (typeof da !== 'undefined') {
  da.onSettingsChanged((s) => { _s = { ..._s, ...s }; });
}

// ── coordinate adjustment for CSS zoom ───────────────────────────────────────
function _adjustCoords(x, y) {
  if (!_s.normalizeCssZoom) return { x, y };
  const zoom = parseFloat(document.documentElement.style.zoom) || 1;
  return { x: x / zoom, y: y / zoom };
}

// ── extract surrounding sentence context + the cursor offset within it ────────
function _extractSentence(source, extent) {
  const empty = { text: '', offset: 0 };
  if (extent <= 0 || !source.range) return empty;
  try {
    const node = source.range.startContainer;
    const offset = source.range.startOffset;
    const fwd = new DOMTextScanner(node, offset, false, _s.layoutAwareScan);
    fwd.seek(extent);
    const bwd = new DOMTextScanner(node, offset, false, _s.layoutAwareScan);
    bwd.seek(-extent);
    return { text: bwd.content + fwd.content, offset: bwd.content.length };
  } catch (_) {
    return empty;
  }
}

// ── core scan ────────────────────────────────────────────────────────────────
function _scanAt(x, y) {
  const { x: ax, y: ay } = _adjustCoords(x, y);
  const source = _generator.getRangeFromPoint(ax, ay, {
    forceOffset: false,
    allowExtensionUrl: false,
    normalizeCssZoom: _s.normalizeCssZoom,
  });
  if (!source) return;

  // getRangeFromPoint returns a collapsed caret range; grow it forward to
  // capture the text before reading it.
  if (source.setEndOffset) {
    try {
      source.setEndOffset(_s.scanLength, false, _s.layoutAwareScan);
    } catch (_) {}
  }

  const fullText = source.text();
  if (typeof da !== 'undefined') da.log('debug', 'scan', 'text: ' + JSON.stringify(fullText));
  if (!fullText || !fullText.trim()) return;

  // alphanumeric filter: skip if text has no CJK characters and setting is off
  if (!_s.alphanumeric && !/[\\u3000-\\u9fff\\uf900-\\ufaff\\u{20000}-\\u{2a6df}]/u.test(fullText)) return;

  const text = fullText;

  const rects = source.getRects ? source.getRects() : [];
  const rect  = rects.length > 0 ? rects[0] : null;

  // selectText: highlight the matched range using the source's own select().
  if (_s.selectText && source.select) {
    try {
      source.select();
    } catch (_) {}
  }

  let sentence = '';
  let sentenceOffset = 0;
  if (_s.sentenceExtent > 0) {
    const extracted = _extractSentence(source, _s.sentenceExtent);
    sentence = extracted.text;
    sentenceOffset = extracted.offset;
  }

  if (typeof da !== 'undefined') {
    const payload = {
      text,
      sentence,
      sentenceOffset,
      x,
      y,
      rect: rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null,
    };
    da.log('info', 'selection', 'selected: ' + text, payload);
    da.emit('selection', payload);
  }
}

// ── mouse ─────────────────────────────────────────────────────────────────────
let _lastX = 0, _lastY = 0, _timeoutId = null;
let _loggedMove = false;
if (typeof da !== 'undefined') da.log('debug', 'input', 'listeners attached');

document.addEventListener('mousemove', (e) => {
  if (!_loggedMove && typeof da !== 'undefined') {
    _loggedMove = true;
    da.log('debug', 'input', 'mousemove received');
  }
  _lastX = e.clientX;
  _lastY = e.clientY;
  if (!_s.scanOnHover) return;
  if (_s.scanDelay <= 0) {
    _scanAt(_lastX, _lastY);
    return;
  }
  clearTimeout(_timeoutId);
  _timeoutId = setTimeout(() => _scanAt(_lastX, _lastY), _s.scanDelay);
}, { passive: true });

// ── scan without mouse move ───────────────────────────────────────────────────
// Re-scan at the last known pointer position when the page regains focus so the
// user doesn't need to wiggle the mouse after switching tabs or closing a popup.
document.addEventListener('visibilitychange', () => {
  if (!_s.scanWithoutMouseMove) return;
  if (document.visibilityState === 'visible') _scanAt(_lastX, _lastY);
});

window.addEventListener('focus', () => {
  if (_s.scanWithoutMouseMove) _scanAt(_lastX, _lastY);
});

// ── touch ─────────────────────────────────────────────────────────────────────
// Listeners are unconditional; the setting is checked inside so changes take
// effect without re-registering.
// pointerup fires for mouse, touch, and pen with client coordinates — unlike
// click, which the embedded webview may not deliver.
document.addEventListener('pointerup', (e) => {
  if (typeof da !== 'undefined') da.log('debug', 'input', 'pointerup received; scanOnTouchTap=' + _s.scanOnTouchTap);
  if (!_s.scanOnTouchTap) return;
  _scanAt(e.clientX, e.clientY);
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!_s.scanOnTouchMove) return;
  const t = e.touches[0];
  if (t) _scanAt(t.clientX, t.clientY);
}, { passive: true });
`.trimStart();
}

async function bundle(srcDir) {
  const tmp = tmpdir();
  const entryPath = join(tmp, 'text-selection-entry.mjs');
  writeFileSync(entryPath, entrySource(srcDir), 'utf8');

  const outPath = join(tmp, 'text-selection-bundle.js');

  // esbuild must be available; installed by the GH Action via npm
  execSync(
    `esbuild "${entryPath}" --bundle --format=iife --target=es2020 --outfile="${outPath}"`,
    { stdio: 'inherit' },
  );

  return readFileSync(outPath, 'utf8');
}

// ── version update helpers ────────────────────────────────────────────────────

function updateIndexVersion(indexPath, pluginId, newVersion) {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const p of index.plugins) {
    if (p.id === pluginId) { p.version = newVersion; break; }
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
}

function updateDapmVersion(dapmPath, newVersion) {
  const dapm = JSON.parse(readFileSync(dapmPath, 'utf8'));
  dapm.version = newVersion;
  writeFileSync(dapmPath, JSON.stringify(dapm, null, 2) + '\n', 'utf8');
}

// ── main ──────────────────────────────────────────────────────────────────────

const requestedTag = process.argv[2] ?? '';
const { srcDir, tag, extractDir, zipPath } = await fetchYomitanSource(
  await resolveYomitanVersion(requestedTag),
);

console.log('Bundling with esbuild…');
const bundleJs = await bundle(srcDir);

// Derive a version from the yomitan tag (strip leading 'v')
const yomitanVersion = tag.replace(/^v/, '');
const pluginVersion = `0.1.0-yomitan.${yomitanVersion}`;

const pluginDir = join(repoRoot, 'packs', 'default', 'plugins', 'text-selection');
const scriptPath = join(pluginDir, 'script.dap');
const dapmPath = join(pluginDir, 'plugin.dapm');
const indexPath = join(repoRoot, 'packs', 'default', 'index.json');

console.log(`Writing ${scriptPath}…`);
writeFileSync(scriptPath, bundleJs, 'utf8');

console.log(`Updating version to ${pluginVersion}…`);
updateDapmVersion(dapmPath, pluginVersion);
updateIndexVersion(indexPath, 'da.default.text-selection', pluginVersion);

// Cleanup
console.log('Cleaning up temporary files…');
rmSync(zipPath, { force: true });
rmSync(extractDir, { recursive: true, force: true });

console.log('Done.');
