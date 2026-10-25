# da-lang-plugins

Plugins and packs for DaLang-based applications (DaKanji, …).

## File types

| ext | what it is |
| --- | --- |
| `.dap` | the plugin **script** (the code) |
| `.dapm` | a single plugin's **metadata** sidecar |
| `.dapp` | a plugin **pack** — a manifest listing one or more plugins |

Pack manifests are JSON, so `.dapp` and `.json` are interchangeable endings — a
pack's `index.json` is a `.dapp`.

## Layout

```text
packs/
  <pack>/
    index.json                 ← the pack manifest (.dapp)
    plugins/
      <plugin-id>/
        plugin.dapm            ← metadata sidecar
        script.dap             ← the script
```

A pack manifest lists its plugins inline, each with a `codeUrl` pointing at the
`.dap` (relative to the manifest, or an absolute URL). A pack holds **one
family** — set the manifest's top-level `family` (or let it be inferred from the
members); a mismatched plugin makes the install throw.

## Packs

- **default** (`da.default`) — ships with the app. Its manifest is published in
  the version-pinned DaKanji-Data release as `dalang_default.dapp`; updates are
  pulled from this repo's `main`.
- **examples** (`da.examples`) — reference plugins covering every API surface;
  loaded in debug builds.
- **extended** (`da.extended`) — extra plugins unlocked by purchase.

## Host APIs (`da.host.*`)

`da.host` lets a plugin use app features the page can't reach on its own. Every
call is async — await the result or catch the error. A plugin may only call
capabilities it lists in `needs` (in its `.dapm`); a call to anything it didn't
list is refused.

`tts`, `ocr` and `llm` each offer a choice of engines. `da.host.<cap>.engines()`
returns the ones usable right now as `[{ id, name }]`; an empty list means none is
available on this device (not downloaded, not bought, or unsupported), so check it
and fall back. Pass `{ engine: id }` to pick one, or leave it out for the default.
`language` has a single implementation and no engine selection.

`da.host.call(capability, op, args, engine?)` is the generic form behind all of
the calls below.

### tts — `needs: { "tts": 1 }`

`language` is a locale tag the engine understands (`ja-JP`), not an ISO code.

| call | returns |
| --- | --- |
| `da.host.tts(text, { language?, voice?, engine? })` | `bool` — whether speech started |
| `da.host.tts.engines()` | `[{ id, name }]` |

### ocr — `needs: { "ocr": 1 }`

`full` takes a base64 image (the plugin already has the bytes, e.g. from an
`<img>`), the languages to look for as ISO 639-3 codes (`["jpn", "eng"]`), and a
level of `"fast"` or `"accurate"`. Boxes are in image pixels; `line` is the line
the region sits on.

| call | returns |
| --- | --- |
| `da.host.ocr.full(imageBase64, { languages?, level?, engine? })` | `[{ text, box: { left, top, width, height }, line }]` |
| `da.host.ocr.engines()` | `[{ id, name, languages: [iso639_3], levels: ["fast", "accurate"] }]` |

### llm — `needs: { "llm": 1 }`

No engine ships yet, so `engines()` returns nothing and `complete` rejects until
one is added.

| call | returns |
| --- | --- |
| `da.host.llm.complete(prompt, { engine? })` | `String` |
| `da.host.llm.engines()` | `[{ id, name }]` |

### language — `needs: { "language": 1 }`

The active language processor — MeCab for Japanese, jieba for Chinese later —
chosen by the app's language.

| call | returns |
| --- | --- |
| `da.host.language.code()` | `{ iso639_1, iso639_2b, iso639_2t, iso639_3 }` — the app's study language in each ISO form |
| `da.host.language.parse(text)` | `[{ surface, base, reading, pos }]`, one per word; `pos` is a list of tags |
| `da.host.language.getTermReadingPairs(pairs, { script? })` | for each `{ term, reading }`, a list of `{ term, ruby }` segments (`ruby` empty for a kana run); `script` is `"hiragana"` (default) or `"katakana"` |
| `da.host.language.findSentences(text)` | `[{ text, start, end }]` |
| `da.host.language.findParagraphs(text)` | `[{ text, start, end }]` |
| `da.host.language.splitIntoLookupUnits(text, startingIndex, maxLength)` | `[String]`, lookup candidates at the cursor, best first |
| `da.host.language.deconjugate(term)` | `[{ deconjugatedTerm, partsOfSpeech, rules }]` |
| `da.host.language.deconjugateAll(terms)` | the same, one list per term |
| `da.host.language.normalize(term)` | `String` |
| `da.host.language.normalizeAll(terms)` | `[String]` |
| `da.host.language.isIdeographic(text)` | `bool` |
| `da.host.language.extractIdeographs(texts)` | `[String]` |

Camera and microphone aren't here: a plugin uses the normal web `getUserMedia`,
and the in-app browser shows the OS permission dialog. Nothing to declare.

## Language codes

When a plugin tells the app a language — a subtitle track's or cue's `language`,
a text selection's `language`, OCR `languages` — any ISO 639 code (`ja`, `jpn`)
or language tag (`ja-JP`) works; the app reads it as ISO 639-3. Prefer ISO 639-3.
TTS is the exception: its `language` goes to the engine as is.

## Errors & the plugin console

Plugins log through `da.log(level, tag, message)` (`level` = `debug` / `info` /
`warn` / `error`). The default plugins send every caught error to this channel as
`da.log('error', '<plugin>', …)`, so a broken plugin reports instead of failing
silently.

Watch the logs live in the app:

1. Enable **Settings → Advanced → local plugin development**.
2. In the in-app browser, open the **⋯** menu and choose **Plugin console**.
3. The console streams each plugin's `da.log` / `da.emit` output, tagged by plugin
   and level — filter to `error` to spot failures.

## Tests

JS-side tests run on Node's built-in runner — no install:

```sh
npm test        # or: node --test
```

`bridge_harness.mjs` loads the real `da_browser_core_bridge.js` from the host app
(`../../flutter_packages/da_lang/...` — this repo checked out as a submodule) into
a fake `window` with a stubbed `flutter_inappwebview` channel, so a test asserts
exactly what a plugin's `da.*` calls send to and receive from the app.
`test/bridge.test.mjs` covers the `da.host.*` payload shapes, per-plugin scoping,
`emit`, `matches`, and `invoke`.

## CI

`.github/workflows/build-default-pack.yml` downloads the latest stable Yomitan,
bundles the default text-selection plugin into a single `script.dap`
(`scripts/build-text-selection.mjs`), and commits the result.
