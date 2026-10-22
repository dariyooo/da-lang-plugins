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
  // Yomitan tags carry no 'v' prefix (e.g. 26.6.15.0).
  if (requested) return requested.replace(/^v/, '');
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

// ── plugin settings (DOM scan mechanics; kept in sync with plugin.dapm) ───────
let _s = {
  layoutAwareScan:      true,
  deepDomScan:          false,
  normalizeCssZoom:     true,
  alphanumeric:         false,
  selectText:           true,
  scanWithoutMouseMove: true,
};

// ── profile settings (delivered via da.profile) ───────────────────────────────
// Only how much text to read. The app applies the scan settings — tap/hover,
// modifiers, delay — to every report.
let _p = {
  scanLength:     16,
  sentenceExtent: 200,
};

const _generator = new TextSourceGenerator();

// Recent reports by id, so applySelection highlights the scan the app accepted
// rather than whatever was reported after it.
const _reported = new Map();
const _maxReported = 16;
let _nextId = 0;

// The last reported source and modifiers, so hovering within the same character
// doesn't report it again.
let _lastReported = null;
let _lastReportedModifiers = '';

// The range currently highlighted in the page.
let _highlighted = null;

if (typeof da !== 'undefined') {
  da.onSettingsChanged((s) => { _s = { ..._s, ...s }; });
  da.onProfileChanged((p) => {
    _p = { ..._p, ...p };
    _lastReported = null;
  });

  // Down-channel: the app resolved the unit of scan [id] and sends its length,
  // so we highlight exactly that unit. There's no selectionchange listener here,
  // so selecting can't loop back into a new scan.
  da.register('applySelection', (range) => {
    const end = (range && range.end) || 0;
    const source = range && range.id != null ? _reported.get(range.id) : _lastReported;
    if (!_s.selectText || !source || !source.clone || end <= 0) return false;
    try {
      const narrowed = source.clone();
      if (narrowed.setEndOffset) narrowed.setEndOffset(end, false, _s.layoutAwareScan);
      if (narrowed.select) narrowed.select();
      _highlighted = narrowed;
      return true;
    } catch (_) {
      return false;
    }
  });

  // Down-channel: another lookup surface took over, so the page highlight goes.
  // Hovering the same word afterwards reports it again.
  da.register('clearSelection', () => {
    try {
      if (_highlighted && _highlighted.deselect) _highlighted.deselect();
    } catch (_) {}
    _highlighted = null;
    _lastReported = null;
    return true;
  });
}

// ── the modifier keys held during a page event ────────────────────────────────
function _modifiersOf(e) {
  return [
    e.altKey && 'alt',
    e.ctrlKey && 'ctrl',
    e.shiftKey && 'shift',
    e.metaKey && 'meta',
  ].filter(Boolean);
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
function _scanAt(x, y, trigger, modifiers, skipSameWord = false) {
  try {
    _scanAtImpl(x, y, trigger, modifiers, skipSameWord);
  } catch (e) {
    if (typeof da !== 'undefined') da.log('error', 'text-selection', String(e));
  }
}

function _scanAtImpl(x, y, trigger, modifiers, skipSameWord) {
  const { x: ax, y: ay } = _adjustCoords(x, y);
  const source = _generator.getRangeFromPoint(ax, ay, {
    forceOffset: false,
    allowExtensionUrl: false,
    normalizeCssZoom: _s.normalizeCssZoom,
  });
  if (!source) return;
  if (
    skipSameWord &&
    _lastReported &&
    _lastReported.hasSameStart(source) &&
    _lastReportedModifiers === modifiers.join()
  ) return;

  // getRangeFromPoint returns a collapsed caret range; grow it forward to
  // capture the text before reading it.
  if (source.setEndOffset) {
    try {
      source.setEndOffset(_p.scanLength, false, _s.layoutAwareScan);
    } catch (_) {}
  }

  const text = source.text();
  if (typeof da !== 'undefined') da.log('debug', 'scan', 'text: ' + JSON.stringify(text));
  if (!text || !text.trim()) return;

  // alphanumeric filter: skip if text has no CJK characters and setting is off
  if (!_s.alphanumeric && !/[\\u3000-\\u9fff\\uf900-\\ufaff\\u{20000}-\\u{2a6df}]/u.test(text)) return;

  _lastReported = source;
  _lastReportedModifiers = modifiers.join();
  const id = ++_nextId;
  _reported.set(id, source);
  if (_reported.size > _maxReported) _reported.delete(_reported.keys().next().value);

  const rects = (source.getRects ? source.getRects() : []).map((r) => ({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
  }));

  let sentence = '';
  let sentenceOffset = 0;
  if (_p.sentenceExtent > 0) {
    const extracted = _extractSentence(source, _p.sentenceExtent);
    sentence = extracted.text;
    sentenceOffset = extracted.offset;
  }

  if (typeof da !== 'undefined') {
    const payload = { id, text, sentence, sentenceOffset, trigger, modifiers, rects };
    da.log('info', 'selection', 'selected: ' + text, payload);
    da.emit('selection', payload);
  }
}

// ── mouse ─────────────────────────────────────────────────────────────────────
// Hover scans run at most once per frame; the app applies the scan delay.
let _lastX = 0, _lastY = 0;
let _hoverModifiers = [];
let _hoverFrame = 0;
let _loggedMove = false;
if (typeof da !== 'undefined') da.log('debug', 'input', 'listeners attached');

function _cancelHoverFrame() {
  cancelAnimationFrame(_hoverFrame);
  _hoverFrame = 0;
}

document.addEventListener('mousemove', (e) => {
  if (!_loggedMove && typeof da !== 'undefined') {
    _loggedMove = true;
    da.log('debug', 'input', 'mousemove received');
  }
  _lastX = e.clientX;
  _lastY = e.clientY;
  _hoverModifiers = _modifiersOf(e);
  if (_hoverFrame) return;
  _hoverFrame = requestAnimationFrame(() => {
    _hoverFrame = 0;
    _scanAt(_lastX, _lastY, 'hover', _hoverModifiers, true);
  });
}, { passive: true });

// Leaving the page tells the app to drop a pending hover lookup.
function _pointerLeft() {
  _cancelHoverFrame();
  _lastReported = null;
  if (typeof da !== 'undefined') da.emit('pointerLeft', null);
}

document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget === null) _pointerLeft();
}, { passive: true });
document.addEventListener('pointercancel', _pointerLeft, { passive: true });
document.addEventListener('pointerdown', _cancelHoverFrame, { passive: true });

// ── scan without mouse move ───────────────────────────────────────────────────
// Re-scan at the last known pointer position when the page regains focus so the
// user doesn't need to wiggle the mouse after switching tabs or closing a popup.
// Focus events carry no key state, so these report no modifiers.
document.addEventListener('visibilitychange', () => {
  if (!_s.scanWithoutMouseMove) return;
  if (document.visibilityState === 'visible') _scanAt(_lastX, _lastY, 'hover', []);
});

window.addEventListener('focus', () => {
  if (_s.scanWithoutMouseMove) _scanAt(_lastX, _lastY, 'hover', []);
});

// ── touch ─────────────────────────────────────────────────────────────────────
// pointerup fires for mouse, touch, and pen with client coordinates — unlike
// click, which the embedded webview may not deliver.
document.addEventListener('pointerup', (e) => {
  if (typeof da !== 'undefined') da.log('debug', 'input', 'pointerup received');
  _scanAt(e.clientX, e.clientY, 'tap', _modifiersOf(e));
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
