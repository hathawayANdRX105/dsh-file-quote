# Changelog

All notable changes to dsh-file-quote.

## [0.1.2] — 2026-10-16

修复插件搬动全局选区导致输入框（composer）光标被破坏的问题（在 DSH `0.2.1-alpha.4` +
真实 Chromium 上实测；输入框是 Lexical contenteditable，它的 DOM 选区就是用户的光标）：

- **修复「点批注后第一个字落到草稿开头」** — `SelectionToolbar.finish()` 无条件
  `window.getSelection().removeAllRanges()`，输入框持有光标时也照清不误：清完
  `rangeCount` 为 0，Lexical 不会自己补回选区，下一个字符（含中文输入法预编辑）落到
  草稿最开头（实测 `alpha beta gamma` → `Xalpha beta gamma`）。现在输入框持有选区时
  不清空，只收起气泡。
- **修复「打字被吞掉」** — `selectPreviewRowText()` / `highlightInMarkdownPreview()` 用
  `removeAllRanges()` + `addRange()` 把全局选区搬到预览窗格；输入框此时仍持有焦点，
  之后打字完全无效（实测连打两个字符草稿无变化）。现在输入框持有选区时改用临时背景
  高亮（`.dsfq-text-flash`），光标留在原处。
- **修复「整段草稿被替换」** — 插入引用时 `caretSpan()` 读到的是输入框上一次的残留选区；
  光标不在输入框里（用户在批注框里）时，非折叠的残留选区会把整段草稿替换掉。现在只有
  光标真的在输入框里才按选区替换，否则收成插入点。
- **插入后把光标交还输入框** — 插入是在批注框里发起的，输入框此刻没有焦点；现在插入
  成功或回退成纯文本后调用 `input.focus()`，用户可以接着打字。

## [0.1.1] — 2026-10-13

修复「装了但完全没反应」以及文件引用缺失来源/行区间的问题（在 DSH `0.2.0-rc.2` + dsh-better-sidebar `0.25.0` 上实测）：

- **修复插件静默失效（根因）** — 缺少 `exports.inject = ['slots']`：`apply` 在 ui-renderer 的
  `slots` 服务 ACTIVE 之前执行并直接 `return`，插件看起来装上了却完全没有效果。
- **修复活动会话识别** — 原来从 `useSessions` 快照读不存在的 `current` 字段，插入时总是报
  「没有活动会话，无法插入引用」；改为从 `sessions.byId` 取当前保留会话。
- **修复输入框 chip 不出现** — `inputTriggers` 服务在 `apply` 时可能尚未 ACTIVE，引用 source
  从未注册；现在即时注册失败会经 `ctx.inject` 等服务就绪后补注册。
- **修复已发送引用不折叠** — 折叠扫描只收集叶子 `div`，而消息正文实际在 `span.plainRun`
  里，导致 0 个折叠容器；改为深搜取最内层容器。
- **修复一条引用被拆成两个 chip** — 分块标记把「来源行」当作块起始行，而写入格式把来源行
  放在块尾（`引用来源：` 末尾）。
- **修复文件引用没有来源行** — v0.1.0 只认工作台 `[data-path]` 编辑器，右侧「文档预览」窗格
  （本版 harness 默认的文件预览界面）识别不到，引用块因此没有
  `> 📄 引用来源：路径（第 X-Y 行）`，点击跳回报「定位失败：没有定位键」。
  新增三路识别：文档预览窗格（`data-textpreview-line` / 代码行序 / Markdown 预览）、通用
  「带路径输入框的编辑器窗口」、侧边栏唯一路径输入框兜底。
- **新增源码反查补全行区间** — 渲染型预览给不出 DOM 行号时，用源文件文本反查唯一命中区间。
- **修复 CM6 选区定位信息被覆盖** — better-sidebar 的 CodeMirror 自己接管选区（`pointerup`
  已写入定位），随后触发的 DOM `selectionchange` 会把刚拿到的 `relPath` 覆盖成 null；
  选中的仍是同一段文本时改为保留已有定位结果。
- **跳回链路增强** — 编辑器跳转 → Markdown 预览高亮 → 文档预览窗格滚行高亮 →
  `dsh-resource://file/…&line=` 官方资源通路打开再定位 → 原文浮层兜底。
- **诊断开关** — 认不出选区来源的界面会打印一条去重的 `console.warn`（便于后续适配）；
  引用正文中不再携带任何诊断痕迹。

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
