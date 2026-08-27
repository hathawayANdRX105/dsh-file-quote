# Changelog

All notable changes to dsh-file-quote.

## [0.1.0] — 2026-08-25

First public release. Unified quoting for DeepSeek Harness Web:

- **Quote chat messages** — select conversation text → annotate → 「引用#N」 chip
  → click jumps back to the source message row (anchor-key location).
- **Quote file-editor text** — select text in the workbench editor, the
  better-sidebar editor, or a Markdown preview → the quote block carries the
  file path and the exact line range (`> 📄 引用来源：path（第 X-Y 行）`).
- **Collapsed in chat & history** — sent quote blocks fold into a hoverable
  chip (the AI sees the full quote + source; the user sees it on hover);
  clicking the chip jumps back to the original (editor highlight / message-row
  flash / source overlay fallback).
- **Turn-tail buttons** — 「引用提问 / 引用回答」 on every finished turn.
- **Robust serialization** — quote blocks carry leading/trailing newlines so
  consecutive quotes never glue together; insertable at any text position,
  unlimited quantity.
- **Optional dsh-better-sidebar cooperation** — file quotes locate and
  highlight inside the sidebar's own editors and Markdown previews (via the
  `betterSidebar` service); degrades gracefully when it is absent.
- **Repo structure** — source lives in `src/` (`src/index.js` host half,
  `src/client.js` client half); `lib/` is generated build output (gitignored)
  produced by the zero-dependency `npm run build` (also runs via `prepare` /
  `prepack`).
