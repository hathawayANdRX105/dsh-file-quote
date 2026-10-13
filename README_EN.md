# dsh-file-quote

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">Select to quote — the quote block points straight back to the source</b><br /><br />
  <code>select &amp; annotate</code> <code>file quoting</code> <code>line-range location</code> <code>collapsed both ends</code> <code>click to jump back</code><br /><br />
  <a href="https://www.npmjs.com/package/dsh-file-quote"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-file-quote" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/topics/dsh-better-sidebar"><img alt="Plugin ecosystem: GitHub topic dsh-better-sidebar" src="https://img.shields.io/badge/plugin%20ecosystem-topic%20dsh--better--sidebar-4d6bfe" /></a><br /><br />
  <b>DeepSeek Harness (DSH) Web plugin</b>: in a conversation, <b>select any text → annotate → send a compact 「引用#N」 quote block</b> —<br />
  the AI sees the <b>full quote and its exact location</b> (file path + line range) while the chat stays tidy. Precision quoting for AI-assisted programming.
</div>

<div align="center">
  🌏 <a href="./README.md">中文</a> · <a href="./README_EN.md"><b>English</b></a>
</div>

<div align="center">
  <img alt="dsh-file-quote demo" src="https://github.com/Sunday2Mo/dsh-file-quote/releases/download/v0.1.0/demo.gif" width="100%" />
</div>

## ✨ Features

- **📝 Select &amp; annotate** — quote the detailed content of files previewed in the sidebar: the block is wrapped automatically and carries the file address plus the quoted text's exact line range — for **every file type the sidebar can preview or edit**. Select conversation text or file-editor text (workbench CodeMirror / better-sidebar editor / Markdown preview) → annotate float → a 「引用#N」 chip lands in the composer
- **📄 File quoting with line range** — the quote block automatically carries the file path and the quoted text's **exact line range** (`> 📄 引用来源：path（第 X-Y 行）`), for every file type the sidebar can preview or edit
- **🧩 Any position, unlimited quantity** — quote blocks insert at any text position; consecutive quotes never glue together (self-contained leading/trailing newlines, idempotent)
- **🗜️ Collapsed in chat &amp; history** — quote blocks stay collapsed in BOTH the composer and the sent conversation history — the AI receives the full quote and its source, the user sees a 「引用内容 · 悬停查看」 chip and reveals the text on hover
- **🎯 Click to jump back** — clicking a quote chip (in the composer or in the history) locates the original: editor locate + highlight / message-row scroll + flash / file-source overlay fallback

> 🔌 **A DSH unified-quoting plugin built on [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)**: the **full feature set depends on dsh-better-sidebar** — sidebar file-content quoting and jump-back location highlight are built on it, so install it first for the complete experience. The base quoting flow derives from [dsh-quote-annotate](https://github.com/wangwei-wade/dsh-quote-annotate) (MIT); precision quoting of sidebar file content, persistent collapse, and jump-back location are **original** additions.

## Prerequisites

DeepSeek Harness Web **0.1.x / 0.2.x** (the client uses the `slots` / `inputTriggers` services; input triggers degrade gracefully to plain-text insertion when absent). Verified on DSH `0.2.0-rc.2`. **[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) is required for the full feature set**: the plugin's full functionality (sidebar file-content quoting, jump-back location highlight) depends on it — without it only chat-message quoting works and file quoting falls back to the source overlay. Requires DSH `0.1.0-rc.8` or newer.

## Installation

```bash
# 1. Install dsh-better-sidebar first (the full feature set depends on it)
dsh plugin --profile web add dsh-better-sidebar@latest   # first run fails: pnpm 11 blocks node-pty build scripts (the dependency is still written)
cd ~/.dsh/profiles/web && pnpm approve-builds --all      # allow the build scripts (re-runs the install automatically)
dsh plugin --profile web add dsh-better-sidebar@latest   # re-run succeeds
# After install, hard-refresh the browser (Cmd/Ctrl+Shift+R) to see the sidebar (DSH hot-reloads client changes; only host-half updates need a restart).

# 2. Then install this plugin
# Install from npm (recommended)
dsh plugin --profile web add dsh-file-quote

# Local development (link: hot update)
dsh plugin --profile web add "link:your path/dsh-file-quote"
```

Then hard-refresh the browser (Cmd/Ctrl+Shift+R); restart `dsh web` after host-half changes.

### Updating

```bash
dsh plugin --profile web add dsh-file-quote@latest
```

Then **hard-refresh the browser** (Cmd/Ctrl+Shift+R). Client-half changes are hot-reloaded by DSH, so `dsh web` does not need a restart.

> Quote blocks and composer chips already sent or already in the box are **snapshots taken at insert time** and cannot be repaired retroactively — re-select and insert once after upgrading to verify.
> If nothing changed after upgrading, hard-refresh (Ctrl+F5) first to rule out cached old code.

## Usage

1. **Quote a chat message** — select any message text in a conversation, click the 「批注」 float (optionally add a comment), then 「插入输入框」 — a 「引用#N」 chip appears at the cursor.
2. **Quote file text** — select code in the workbench editor, the better-sidebar editor, or a Markdown preview, same flow; the sent block carries the **file path + line range**, so the AI can locate the original directly.
3. **After sending** — the quote block collapses into a 「引用内容 · 悬停查看」 chip — hover to read the full quote, **click to jump back to the original and highlight it** (editor selection highlight / message-row flash / source overlay fallback).

## Serialization format (compatibility line)

On send the quote block serializes to a markdown `>` block with the source line integrated (kept **in Chinese verbatim**, not translated with the UI):

```
> quoted body
> 📄 引用来源：src/a.ts（第 3-5 行）
```

- The block carries its own leading/trailing newlines: it never glues to surrounding text or other quotes; consecutive quotes each occupy their own block.
- The parser also reads the legacy `> 📄 文件：…` format (v0.7), so already-sent quote blocks stay clickable.

## Architecture

```
dsh-file-quote (bundle: dsh.bundle + package.json#dsh.client)
├── src/index.js        host: /dsh-file-quote/read secure file-read endpoint
│                       (workspace realpath jail + 2MB cap + binary NUL detection)
└── src/client.js       browser: selection capture, annotate float, quote pipeline,
                        turn buttons, sent-quote collapse, jump-back location
    ├── quote pipeline  inputTriggers.registerSource('file-quote-ref'): chip → quote-block codec
    ├── selection route message selection → anchorKey; editor selection (CM6 cmTile) → relPath + line range
    ├── location chain  editor jump → Markdown preview highlight → tab/file-tree activation → better-sidebar openFile → source overlay
    └── sent collapse   MutationObserver: folds `> quote blocks` in the history into hover chips
```

### Key data flow

```
select text ─▶ annotate float ─▶ 「引用#N」 chip into the composer (any position, unlimited)
  send ─▶ codec serializes to `\n> quoted body\n> 📄 引用来源：path（第 X-Y 行）\n`
       ─▶ history collapses it into a 「引用内容 · 悬停查看」 chip (AI sees the full text)
click chip ─▶ parse the source line → editor locate + highlight / message-row flash / source overlay
```

## Development

Source lives in `src/` (`src/index.js` host half, `src/client.js` client half, in the `window.__ModuleLoader__.load` format) and is the single source of truth; `lib/` is the build output, copied from `src/` by the zero-dependency script `scripts/build.js` (a pure-JS copy build, so the two directories hold identical content — that is expected), gitignored and never committed.

```sh
npm run build   # src/ → lib/ (runs automatically via prepare on npm/GitHub install and pack)
```

**Edit only `src/`, never `lib/` by hand**: after changing `src/`, run `npm run build`, then hard-refresh the browser to debug the client; restart `dsh web` after host-half changes (`src/index.js`).

## ⚖️ Third-party attribution

Part of the plugin's design derives from [dsh-quote-annotate](https://github.com/wangwei-wade/dsh-quote-annotate) (MIT License, Copyright (c) 2026 wangwei-wade).

## License

MIT
