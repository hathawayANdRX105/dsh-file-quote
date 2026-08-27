# dsh-file-quote

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">划选即引，引用块直达原文</b><br /><br />
  <code>划选批注</code> <code>文件引用</code> <code>行区间定位</code> <code>双端折叠</code> <code>点击跳回</code><br /><br />
  <a href="https://www.npmjs.com/package/dsh-file-quote"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-file-quote" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/topics/dsh-better-sidebar"><img alt="Plugin ecosystem: GitHub topic dsh-better-sidebar" src="https://img.shields.io/badge/plugin%20ecosystem-topic%20dsh--better--sidebar-4d6bfe" /></a><br /><br />
  <b>DeepSeek Harness（DSH）Web 插件</b>：在对话里<b>划选任意文本 → 批注 → 发送紧凑「引用#N」引用块</b>——<br />
  AI 看到<b>完整引用与精确位置</b>（文件路径 + 行区间），聊天区保持整洁。面向 AI 编程的「精确引用」能力。
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

<div align="center">
  <img alt="dsh-file-quote demo" src="https://github.com/Sunday2Mo/dsh-file-quote/releases/download/v0.1.0/demo.gif" width="100%" />
</div>

## ✨ 功能一览

- **📝 划选批注**：可引用侧边栏中预览文件的详细内容，自动封装为「引用块」，块内自动包含文件地址 + 被引内容在文件中的具体行区间——适用于**所有可在侧边栏预览/编辑的文件类型**。选中会话消息或文件编辑器（工作台 CodeMirror / better-sidebar 编辑器 / Markdown 预览）文本 → 批注浮层 → 「引用#N」chip 插入输入框
- **📄 文件引用带行区间**：引用块自动封装文件地址与被引内容的**精确行区间**（`> 📄 引用来源：路径（第 X-Y 行）`），适用于所有可在侧边栏预览/编辑的文件类型
- **🧩 任意位置插入、数量不限**：引用块可在输入框任意文本位置插入、数量不限，多个引用连续插入互不粘连（序列化自带首尾换行，幂等）
- **🗜️ 双端折叠**：引用块在输入框和已发送会话记录中**都**保持折叠——AI 收到完整引用与来源，用户侧仅见「引用内容 · 悬停查看」chip，悬停查看全文
- **🎯 点击跳回原文**：点击引用 chip（输入框内或历史里）定位原文——编辑器定位高亮 / 消息行滚动闪烁 / 文件原文浮层兜底

> 🔌 **基于 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的 DSH 统一引用插件**：**完整功能依赖 dsh-better-sidebar**——侧边栏文件引用、跳回定位高亮都以它为基础，为获得完整体验请先安装。基础引用流程源自 [dsh-quote-annotate](https://github.com/wangwei-wade/dsh-quote-annotate)（MIT）；侧边栏文件内部内容精确引用、双端折叠、跳回定位为**原创**扩展。

## 前置依赖

DeepSeek Harness Web **0.1.x**（client 使用 `slots` / `inputTriggers` 服务；输入管线缺失时优雅降级为纯文本插入）。**[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 推荐必装**：插件的**完整功能（侧边栏文件内容引用、跳回定位高亮）依赖它**——未安装时仅会话消息引用可用，文件引用退化为原文浮层展示。对应 DSH `0.1.0-rc.8` 及更高。

## 安装

```bash
# 1. 先安装 dsh-better-sidebar（完整功能依赖）

# 2. 再安装本插件（通过 npm，发布后）
dsh plugin --profile web add dsh-file-quote

# 或从 GitHub 源码安装本插件
dsh plugin --profile web add "github:Sunday2Mo/dsh-file-quote"

# 本地开发
dsh plugin --profile web add "link:/path/to/dsh-file-quote"
```

装完硬刷新浏览器（Cmd/Ctrl+Shift+R）；host 半改动需重启 `dsh web`。

## 使用

1. **引用会话消息**：在任意对话中划选一段文本，点击浮层「批注」（可加评论），点「插入输入框」——输入框光标处出现「引用#N」chip。
2. **引用文件文本**：在工作台编辑器、better-sidebar 编辑器或 Markdown 预览中划选代码，同样流程；发送后引用块自带**文件路径 + 行区间**，AI 可直接定位到原文。
3. **发送后**：引用块折叠为「引用内容 · 悬停查看」chip——悬停查看全文，**点击跳回原文并高亮**（编辑器选中高亮 / 消息行闪烁 / 原文浮层兜底）。

## 序列化格式（兼容红线）

发送时引用块序列化为 markdown `>` 块，来源行集成在块内（**中文原样，不随界面语言翻译**）：

```
> 引用正文
> 📄 引用来源：src/a.ts（第 3-5 行）
```

- 引用块自带首尾换行：与前后普通文本/其他引用互不粘连，多个引用连续插入各自独占成块。
- 解析器同时兼容旧版 `> 📄 文件：…` 格式（v0.7），已发送的旧引用块仍可点击定位。

## 架构

```
dsh-file-quote (bundle: dsh.bundle + package.json#dsh.client)
├── src/index.js        host：/dsh-file-quote/read 安全文件读取端点
│                       （workspace realpath jail + 2MB 上限 + 二进制 NUL 检测）
└── src/client.js       浏览器：选区捕获、批注浮层、引用管线、回合按钮、已发送折叠、跳回定位
    ├── 引用管线       inputTriggers.registerSource('file-quote-ref')：chip → 引用块序列化 codec
    ├── 选区分流       消息选区 → anchorKey；编辑器选区（CM6 cmTile）→ relPath + 行区间
    ├── 定位链         编辑器跳转 → Markdown 预览高亮 → tab/文件树激活 → better-sidebar openFile → 原文浮层
    └── 已发送折叠     MutationObserver：把会话记录中的 `> 引用块` 折叠为悬停 chip
```

### 关键数据流

```
划选文本 ─▶ 批注浮层 ─▶ 「引用#N」chip 插入输入框（任意位置、数量不限）
  发送 ─▶ codec 序列化为 `\n> 引用正文\n> 📄 引用来源：路径（第 X-Y 行）\n`
       ─▶ 会话记录折叠为「引用内容 · 悬停查看」chip（AI 可见全文）
点击 chip ─▶ 解析来源行 → 编辑器定位高亮 / 消息行闪烁 / 原文浮层兜底
```

## 开发

源码位于 `src/`（`src/index.js` host 半区、`src/client.js` client 半区，`window.__ModuleLoader__.load` 格式），是唯一真源；`lib/` 为构建产物，由零依赖脚本 `scripts/build.js` 从 `src/` 复制生成（纯 JS 复制式构建，两者内容相同属正常），已被 `.gitignore` 忽略、不提交 GitHub。

```sh
npm run build   # src/ → lib/（npm 安装 / GitHub 安装 / 打包时经 prepare 自动执行）
```

**只改 `src/`，不要手改 `lib/`**：改完先 `npm run build`，再硬刷新浏览器调试 client；host 改动（`src/index.js`）需重启 `dsh web`。

## License

MIT —— 见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)（第三方归属：dsh-quote-annotate）。
