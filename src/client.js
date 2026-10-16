// dsh-file-quote v0.1.1 — Client 半区（浏览器）
// 统一引用插件：合并 dsh-quote-annotate 的全部功能 + 文件编辑器选区引用。
//
// MIT License — Copyright (c) 2026 Sunday2Mo
// Portions derived from dsh-quote-annotate (https://github.com/wangwei-wade/dsh-quote-annotate),
// MIT License — Copyright (c) 2026 wangwei-wade. See LICENSE and NOTICE.
// 功能清单：
//   1. 选中会话消息（非编辑区）→ 批注 → 「引用#N」chip → 点击跳回消息原文行（anchorKey 定位）
//   2. 选中文件编辑器正文（contenteditable / CodeMirror）→ 批注 → 「引用#N」chip → 点击浮层定位文件原文（relPath 定位）
//   3. 每个已结束回合尾部「引用提问 / 引用回答」按钮
//   4. chip 悬停显示原文、Escape 关闭、发送时序列化为 `> 引用块` + 评论
//   5. 已发送消息展示层把 `> 引用块` 折叠为收起的引用块 chip：具体内容仍完整发送给 AI，
//      但用户侧仅在鼠标悬停在引用块上时经提示框查看全文
//   6. 引用来源完全集成在引用块内（末行「> 📄 引用来源：<relPath>（第 X-Y 行）」），
//      AI 可见来源与行区间；用户侧折叠后不显示来源，仅悬停时随引用块全文可见
//   7. 引用序列化文本自带首尾换行：引用块与前后普通文本/其他引用互不粘连，
//      多个引用连续插入也能各自独占成块（幂等，不依赖输入管线行为）
//   8. 已发送消息的折叠引用块也可点击定位：从引用文本解析来源路径（或消息文本），
//      复用编辑器跳转/消息行高亮/浮层兜底定位链
window.__ModuleLoader__.load({
  id: 'dsh-file-quote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let React = require('react')
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch (e) { /* react-dom 不可用时退回原位渲染 */ }
    // 把浮动 UI portal 到 document.body 顶层：应用外壳若带 transform/z-index 会形成层叠上下文，
    // 把内部浮层（z-index 再高）锁在侧边栏之下；挂到 body 顶层后即可盖住侧边栏（z-index ~40）。
    const mountPortal = (node) => (ReactDOM && ReactDOM.createPortal ? ReactDOM.createPortal(node, document.body) : node)

    // ============ 模块级状态 ============
    let rootCtx = null
    let currentSessionId = null
    let refSeq = 0
    // 最近一次指针位置：输入框 chip 的官方激活回调没有事件对象，用它兜底定位气泡
    let lastPointerPos = null
    // 最近一次「认不出选区来源」的祖先链（去重，避免刷屏）
    let lastUnrecognizedSurface = null
    // 调试开关（默认关闭）：置 true 时，认不出选区来源的界面会把祖先链写进引用正文，
    // 便于为新界面补适配。正常发布/正常使用下必须保持 false —— 用户发出的引用里
    // 不会出现任何诊断痕迹。
    const DIAGNOSE_IN_QUOTE = false
    // 引用 source 是否已注册（即时注册与 ctx.inject 迟到注册互斥，重复注册会抛错）
    let quoteSourceRegistered = false
    // 可点击/可悬停的引用 chip 三种形态：
    //   [data-dsfq-quote]     已发送消息里被折叠出的 chip（属性自带全文与定位）
    //   [data-composer-chip]  输入框内的引用节点（本版 harness：data-composer-chip="<source>"）
    //   [data-occurrence]     输入框内的引用节点（旧版 harness：data-occurrence="<occurrenceId>"）
    const CHIP_SELECTOR = '[data-dsfq-quote], [data-composer-chip], [data-occurrence]'
    let pipelineAvailable = null
    let toastTimer = null
    // 程序化高亮选区期间抑制批注工具条弹出（毫秒时间戳）
    let toolbarSuppressUntil = 0
    // ref -> { sessionId, cwd?, relPath?, anchorKey?, text, body, label }：chip 点击/悬停时定位
    const refTargets = new Map()
    // ref -> { body, clipboardText }：提交时经 codec 序列化
    const refCodecs = new Map()

    const MAX_SELECTION = 4000
    const MAX_QUOTE = 2000

    // 输入框（composer）是 Lexical contenteditable：它的 DOM 选区就是用户的光标。
    // 插件任何「清空 / 搬走全局选区」的动作都只在输入框不持有这份选区时才能做，
    // 否则 Lexical 的选区会跟着变成 null 或落到别的窗格，用户回到输入框打第一个字时
    // 会落到草稿开头、把整段草稿替换掉，或者干脆被吞掉。
    function composerHoldsSelection() {
      try {
        const composer = document.querySelector('[data-composer-input]')
        if (composer === null) return false
        const active = document.activeElement
        if (active instanceof Node && (active === composer || composer.contains(active))) return true
        const sel = window.getSelection()
        const node = sel && sel.rangeCount > 0 ? sel.anchorNode : null
        return node !== null && (node === composer || composer.contains(node))
      } catch (e) {
        return false
      }
    }

    // 程序化高亮：输入框持有选区时不能改用原生选区（那会把光标搬出输入框），
    // 退化成给目标元素加一段临时背景——用户仍能看到高亮，光标留在原处。
    function flashElementText(el) {
      try {
        if (!el || !el.classList) return
        el.classList.add('dsfq-text-flash')
        setTimeout(() => { if (el.classList) el.classList.remove('dsfq-text-flash') }, 1800)
      } catch (e) { /* ignore */ }
    }

    // 插入结束后把光标交还输入框：插入是在批注框里发起的，输入框此刻没有焦点；
    // 不交还的话用户回到输入框打第一个字时可能没有光标（字符落到草稿开头或被吞掉）。
    function returnComposerCaret(input) {
      try {
        if (input && typeof input.focus === 'function') input.focus()
      } catch (e) { /* ignore */ }
    }

    // ============ 选区浮动气泡 store ============
    const selectionStore = {
      visible: false,
      text: '',
      rect: null,
      relPath: null,
      anchorKey: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.rect = info.rect
        this.relPath = info.relPath || null
        this.anchorKey = info.anchorKey || null
        this.lineRange = info.lineRange || null
        this.diag = info.diag || ''
        this.emit()
      },
      hide() {
        if (!this.visible) return
        this.visible = false
        this.emit()
      },
    }

    function useSelection() {
      const [, force] = React.useState(0)
      React.useEffect(() => selectionStore.subscribe(() => force((v) => v + 1)), [])
      return selectionStore
    }

    // ============ 批注编辑框 store ============
    const editorStore = {
      item: null,
      rect: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      open(item, rect) {
        this.item = item
        this.rect = rect
        this.emit()
      },
      // 异步补全定位信息（如渲染型预览里反查出来的行区间）后刷新界面
      update(patch) {
        if (!this.item) return
        this.item = Object.assign({}, this.item, patch)
        this.emit()
      },
      close() {
        if (!this.item) return
        this.item = null
        this.rect = null
        this.emit()
      },
    }

    function useEditor() {
      const [, force] = React.useState(0)
      React.useEffect(() => editorStore.subscribe(() => force((v) => v + 1)), [])
      return editorStore
    }

    // ============ 文件定位浮层 store（点击文件引用 chip 后展示原文） ============
    const locatorStore = {
      item: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      open(item) {
        this.item = item
        this.emit()
      },
      close() {
        if (!this.item) return
        this.item = null
        this.emit()
      },
    }

    function useLocator() {
      const [, force] = React.useState(0)
      React.useEffect(() => locatorStore.subscribe(() => force((v) => v + 1)), [])
      return locatorStore
    }

    // ============ 反馈 toast store ============
    const toastStore = {
      text: '',
      pos: null,
      ok: false,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(text, pos, ok) {
        this.text = text
        this.pos = pos
        this.ok = !!ok
        this.emit()
      },
      hide() {
        if (!this.text) return
        this.text = ''
        this.pos = null
        this.emit()
      },
    }

    function useToast() {
      const [, force] = React.useState(0)
      React.useEffect(() => toastStore.subscribe(() => force((v) => v + 1)), [])
      return toastStore
    }

    // ============ 工具函数 ============
    function clipText(text, max) {
      if (!text) return ''
      const t = text.trim()
      return t.length > max ? t.slice(0, max) + '…（已截断）' : t
    }

    function quoteBodyOf(text) {
      return text.split('\n').map((line) => '> ' + line).join('\n')
    }

    // 行区间格式化：[3, 5] → 「第 3-5 行」；[3, 3] → 「第 3 行」；非法 → ''
    function formatLineRange(lineRange) {
      if (!Array.isArray(lineRange) || lineRange.length !== 2) return ''
      const a = lineRange[0]
      const b = lineRange[1]
      return a === b ? '第 ' + a + ' 行' : '第 ' + a + '-' + b + ' 行'
    }

    // 从已发送的引用块全文解析定位信息：{ relPath, body, lineRange }
    // 来源行可能在末行（当前「> 📄 引用来源：」格式）或首行（早期「> 📄 文件：」格式），
    // 逐行匹配；其余行拼接为引用正文（供编辑器文本定位兜底）。行区间从「（第 X-Y 行）」解析
    function parseQuoteLocator(quoteText) {
      const lines = String(quoteText || '').split('\n')
      const bodyLines = []
      let relPath = null
      let lineRange = null
      for (const line of lines) {
        const m = line.trim().match(/^📄\s*(?:引用来源|文件)[：:]\s*(.+)$/)
        if (m && m[1]) {
          const src = m[1].trim()
          const rm = src.match(/（第\s*(\d+)(?:-(\d+))?\s*行）\s*$/)
          if (rm) {
            const a = parseInt(rm[1], 10)
            const b = rm[2] ? parseInt(rm[2], 10) : a
            if (a >= 1 && b >= a) lineRange = [a, b]
          }
          relPath = src.replace(/（第\s*\d+(?:-\d+)?\s*行）\s*$/, '').trim()
        } else {
          bodyLines.push(line)
        }
      }
      return { relPath, body: bodyLines.join('\n').trim(), lineRange }
    }

    // 当前活动会话 id 的唯一取法。
    // harness 的 sessions 列表快照没有 `current` 字段：官方两处权威实现都从
    // `byId` 里挑 retainedBy.mainView > 0 的那一行
    // （@deepseek-ai/dsh-client-ui-session 的 UiSession.publishMain，以及
    //  dsh-client-ui-cordis 侧栏面板的 useSessions((s) => Object.values(s.byId).find(...))）。
    // 这里同时兼容可能存在的 `current` 字段，两种形状都能取到。
    function pickCurrentSessionId(snap) {
      if (!snap) return undefined
      if (typeof snap.current === 'string' && snap.current !== '') return snap.current
      const byId = snap.byId
      if (!byId) return undefined
      const ids = Object.keys(byId)
      for (let i = 0; i < ids.length; i++) {
        const row = byId[ids[i]]
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return ids[i]
      }
      return undefined
    }

    // 不依赖 slot props 的兜底：直接读 sessions 服务的列表快照
    function currentSessionFallback() {
      try {
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!sessions || !sessions.list || !sessions.list.getSnapshot) return undefined
        return pickCurrentSessionId(sessions.list.getSnapshot())
      } catch (e) {
        return undefined
      }
    }

    // 当前活动会话的工作区根（已发送消息的折叠 chip 定位文件时的 cwd 兜底）
    function currentCwd() {
      try {
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!sessions || !sessions.list || !sessions.list.getSnapshot) return null
        const snap = sessions.list.getSnapshot()
        const id = currentSessionId || pickCurrentSessionId(snap)
        const s = snap.byId && snap.byId[id]
        return (s && s.cwd) || null
      } catch (e) {
        return null
      }
    }

    function insertStyleSheet(css) {
      const tag = document.createElement('style')
      tag.setAttribute('data-dsh-file-quote', '')
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    function showToast(text, pos, ok) {
      toastStore.show(text, pos, ok)
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => toastStore.hide(), 2400)
    }

    // ============ 发送后引用收起：把用户气泡里的 `> 引用` 行折叠为引用块 chip ============
    // 发送时 codec 会把「引用#N」序列化为完整 `> 引用块` 文本（AI 侧可见全文）；
    // 这里只做展示层折叠：具体内容不显示在气泡里，悬停 chip 时由 QuoteTooltip 提示全文。

    function hashText(text) {
      let h = 5381
      for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
      return h.toString(36)
    }

    // 把文本按「连续以 > 开头的行」切段：引用段与普通文本段交替（普通段原样保留，含换行）。
    // 分块标记必须与写入格式一致：
    //   当前格式「> 📄 引用来源：…」是引用块的**末行** → 该行之后的下一行才是新块起点；
    //   早期格式「> 📄 文件：…」是**首行** → 该行本身即新块起点。
    // （原实现只按「文件：」在行首切块，遇到当前格式会把来源行切成第二个 chip。）
    // 普通段按整段拼接保留原有换行，避免多行正文被折叠后挤成一行。
    function splitQuoteRuns(text) {
      const lines = String(text || '').split('\n')
      const parts = []
      let buf = []
      let plain = []
      const isSourceCurrent = (line) => /^\s*>\s*📄\s*引用来源[：:]/.test(line)
      const isSourceLegacy = (line) => /^\s*>\s*📄\s*文件[：:]/.test(line)
      const flushQuote = () => {
        if (buf.length === 0) return
        const raw = buf.join('\n')
        const quoteText = buf.map((l) => l.replace(/^\s*>\s?/, '')).join('\n').trim()
        parts.push(quoteText === '' ? { quote: false, text: raw } : { quote: true, text: raw, quoteText })
        buf = []
      }
      const flushPlain = () => {
        if (plain.length === 0) return
        parts.push({ quote: false, text: plain.join('\n') })
        plain = []
      }
      for (const line of lines) {
        if (/^\s*>\s?/.test(line)) {
          const startNew = buf.length > 0 && (buf.some(isSourceCurrent) || isSourceLegacy(line))
          if (startNew) flushQuote()
          flushPlain()
          buf.push(line)
        } else {
          flushQuote()
          plain.push(line)
        }
      }
      flushQuote()
      flushPlain()
      return parts
    }

    // 扫描用户/steering 消息行，把纯文本容器里的引用行折叠为 chip
    function collapseSentQuotes() {
      const rows = document.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"], [data-pending-steering]')
      for (const row of rows) {
        try {
          // 行级粗筛：不含引用行的行直接跳过。本函数挂在 document.body 的
          // MutationObserver 上（流式回答时会频繁触发），先做一次行级判断，
          // 避免对每个用户气泡都拼装整棵子树的 textContent。
          if (!/^\s*>\s?/m.test(row.textContent || '')) continue
          // 正文容器的取法不再假定「div + 全是文本节点」：
          // 本版 harness 用 projectUserText 把用户正文包进 <span class="…plainRun">，
          // 旧的 div 选择器永远匹配不到任何容器，折叠因此整体失效。
          // 现在取「自身文本含引用行、且没有子元素也含引用行」的最深元素。
          const containers = []
          for (const el of row.querySelectorAll('*')) {
            if (el.closest('[data-dsfq-quote]')) continue
            const text = el.textContent
            if (!text || !/^\s*>\s?/m.test(text)) continue
            let childMatches = false
            for (const child of el.children) {
              if (/^\s*>\s?/m.test(child.textContent || '')) {
                childMatches = true
                break
              }
            }
            if (childMatches) continue
            containers.push(el)
          }
          for (const el of containers) {
            const text = el.textContent
            if (!/^\s*>\s?/m.test(text)) continue
            const hash = hashText(text)
            // 已折叠且 chip 仍在（React 重渲染可能重置子节点，此时需重新折叠）
            if (el.getAttribute('data-dsfq-done') === hash && el.querySelector(':scope > [data-dsfq-quote]')) continue
            const parts = splitQuoteRuns(text)
            const quoteCount = parts.filter((p) => p.quote).length
            if (quoteCount === 0) continue
            while (el.firstChild) el.removeChild(el.firstChild)
            let seq = 0
            for (const part of parts) {
              if (part.quote) {
                seq += 1
                const chip = document.createElement('span')
                chip.className = 'dsfq-sent-quote'
                chip.setAttribute('data-dsfq-quote', '')
                chip.setAttribute('data-dsfq-quote-text', part.quoteText)
                // 解析并缓存定位信息：点击 chip 可跳回文件/消息原文
                const loc = parseQuoteLocator(part.quoteText)
                if (loc.relPath) chip.setAttribute('data-dsfq-relpath', loc.relPath)
                if (loc.body) chip.setAttribute('data-dsfq-body', loc.body)
                if (loc.lineRange) chip.setAttribute('data-dsfq-range', loc.lineRange.join(','))
                // 引用来源集成在引用块内，用户侧不显示来源（悬停随全文可见）
                chip.textContent = '引用内容' + (quoteCount > 1 ? ' ' + seq : '') + ' · 悬停查看'
                el.appendChild(chip)
              } else {
                // 普通文本段原样保留
                el.appendChild(document.createTextNode(part.text))
              }
            }
            el.setAttribute('data-dsfq-done', hash)
          }
        } catch (e) {
          console.error('[file-quote] 发送引用收起失败', e)
        }
      }
    }

    // ============ 会话消息引用：解析某轮用户/助手文本 ============
    function textBlocksToText(blocks, kindField, typeValue) {
      const parts = []
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && b[kindField] === typeValue && typeof b.text === 'string' && b.text.trim() !== '') {
            parts.push(b.text.trim())
          }
        }
      }
      return parts.join('\n\n')
    }

    function extractTurnTexts(snapshot, turnLoc) {
      const turn = turnLoc.turn
      const endSeq = turnLoc.end ? turnLoc.end.seq : Number.POSITIVE_INFINITY
      let prevEnd = 0
      if (snapshot.turnEnds) {
        snapshot.turnEnds.forEach((seq, t) => {
          if (typeof t === 'number' && t < turn && seq > prevEnd) prevEnd = seq
        })
      }
      const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []
      const userParts = []
      let assistantText = ''
      let assistantSeq = -1
      for (const n of nodes) {
        if (!n || typeof n.seq !== 'number') continue
        if (n.seq <= prevEnd || n.seq > endSeq) continue
        if (n.kind === 'user' || n.kind === 'steering') {
          const text = textBlocksToText(n.content, 'type', 'text')
          if (text !== '') userParts.push(text)
        } else if (n.kind === 'assistant' && n.turn === turn && n.seq > assistantSeq) {
          assistantSeq = n.seq
          const text = textBlocksToText(n.blocks, 'kind', 'text')
          if (text !== '') assistantText = text
        }
      }
      return { userText: userParts.join('\n\n'), assistantText }
    }

    function anchorKeyFor(snapshot, turn, kind, closingSeq) {
      try {
        if (!snapshot || !snapshot.chat || !snapshot.chat.locations || !snapshot.chat.nodes) return null
        const keys = snapshot.chat.locations.getTurn(turn) || []
        const nodes = snapshot.chat.nodes
        let fallback = null
        for (const key of keys) {
          const node = nodes.get(key)
          if (!node || node.kind !== kind) continue
          fallback = key
          if (kind === 'user') return key
          if (kind === 'assistant' && typeof closingSeq === 'number' && node.anchorSeq === closingSeq) return key
        }
        return fallback
      } catch (e) {
        return null
      }
    }

    // 回合尾部链选择器：仅在已结束且无交付文件的回合挂载
    function selectTurnQuote(owner) {
      if (!owner || !owner.turn || !owner.turn.end) return null
      const delivered = owner.turn.data ? owner.turn.data.get('deliverables') : undefined
      if (delivered && Array.isArray(delivered.produced) && delivered.produced.length > 0) return null
      return { turn: owner.turn.turn }
    }

    function rectOf(e) {
      try {
        const r = e.currentTarget.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      } catch (err) {
        return null
      }
    }

    // ============ 引用解析（chip 点击/悬停共用；兼容 file-quote-ref 与 quote-ref 两种 source） ============
    function resolveOccurrence(occId) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return null
        const trySession = (sessionId) => {
          if (!sessionId) return null
          const binding = sessions.binding(sessionId)
          if (!binding) return null
          const input = conversation.input.for(binding.ctx)
          const occurrences = input.state.getSnapshot().occurrences || []
          return occurrences.find((o) => o.occurrenceId === occId) || null
        }
        let occ = trySession(currentSessionId)
        if (!occ) {
          for (const refKey of refTargets.keys()) {
            const info = refTargets.get(refKey)
            if (!info || !info.sessionId) continue
            occ = trySession(info.sessionId)
            if (occ) break
          }
        }
        if (!occ || (occ.source !== 'file-quote-ref' && occ.source !== 'quote-ref')) return null
        return { occ, info: refTargets.get(occ.ref) }
      } catch (e) {
        return null
      }
    }

    // 注册引用 source（只在服务可用时调用一次）。
    //   codec.serialize  → 提交时把 chip 展开为完整引用正文（AI 侧可见全文）
    //   openReference    → 点击输入框内的 chip 时由 harness 回调（官方 chip 激活钩子）
    function registerQuoteSource(inputTriggers) {
      if (quoteSourceRegistered || !inputTriggers || typeof inputTriggers.registerSource !== 'function') return null
      quoteSourceRegistered = true
      pipelineAvailable = true
      return inputTriggers.registerSource({
        trigger: '@',
        name: 'file-quote-ref',
        order: 101,
        candidates: async () => [],
        onPick: () => undefined,
        codec: {
          clipboardText: (ref) => (refCodecs.get(ref) ? refCodecs.get(ref).clipboardText : ''),
          serialize: (ref) => Promise.resolve(refCodecs.get(ref) ? refCodecs.get(ref).body : ''),
        },
        openReference: (session, reference) => {
          try {
            const info = reference ? refTargets.get(reference.ref) : null
            if (!info) return false
            locateQuoteTarget(info, lastPointerPos)
            return true
          } catch (e) {
            console.error('[file-quote] 点击输入框引用出错', e)
            return false
          }
        },
      })
    }

    // 统一的「点击 chip 定位原文」路由（输入框 chip / 已发送 chip 共用）
    function locateQuoteTarget(info, pos) {
      if (!info) {
        showToast('该引用没有定位信息', pos, false)
        return
      }
      if (info.relPath) {
        locateFile({ relPath: info.relPath, text: info.body || info.text || '', cwd: info.cwd || currentCwd(), lineRange: info.lineRange || null }, pos)
      } else if (info.anchorKey || info.body) {
        locateMessage(info, pos)
      } else {
        showToast('该引用没有定位信息', pos, false)
      }
    }

    // 从任意一种 chip DOM 解析出 { text, info }（悬停提示与点击定位共用）
    function quoteInfoFromChip(el) {
      if (!el) return null
      if (el.hasAttribute('data-dsfq-quote')) {
        const rangeAttr = el.getAttribute('data-dsfq-range') || ''
        return {
          text: el.getAttribute('data-dsfq-quote-text') || '',
          info: {
            relPath: el.getAttribute('data-dsfq-relpath') || null,
            body: el.getAttribute('data-dsfq-body') || null,
            anchorKey: el.getAttribute('data-dsfq-anchor') || null,
            lineRange: rangeAttr ? rangeAttr.split(',').map(Number) : null,
          },
        }
      }
      // 输入框 chip：ref 编号编码在 chip 文案「引用内容 #N」里
      const m = String(el.textContent || '').match(/#\s*(\d+)/)
      if (m && refTargets.has('f' + m[1])) {
        const info = refTargets.get('f' + m[1])
        return { text: info.text || '', info }
      }
      const occAttr = el.getAttribute('data-occurrence')
      if (occAttr !== null) {
        const found = resolveOccurrence(Number(occAttr))
        if (found && found.info) return { text: found.info.text || '', info: found.info }
      }
      return null
    }

    // 从选区 DOM 向上找 workbench 编辑器容器的 data-path（CodeEditor 挂载点）
    function relPathFromHost(node) {
      if (!node || !node.closest) return null
      const host = node.closest('[data-path]')
      return host ? host.getAttribute('data-path') : null
    }

    // 计算选区在文件中的行号区间 [起始行, 结束行]（1-based）。
    // 优先读 CM6 view.state.selection（与 DOM 选区同步），拿不到时用 posAtCoords 从选区矩形反推。
    function lineRangeOfSelection(host, range) {
      try {
        if (!host || !host.closest) return null
        const editor = host.closest('.cm-editor')
        if (!editor) return null
        const cm = host.closest('.cm-content') || editor.querySelector('.cm-content')
        const tile = (cm && cm.cmTile) || editor.cmTile || null
        const view = tile && tile.root ? tile.root.view : null
        if (!view || !view.state || !view.state.doc) return null
        const doc = view.state.doc
        let from = -1
        let to = -1
        const sel = view.state.selection ? view.state.selection.main : null
        if (sel && !sel.empty) {
          from = Math.min(sel.anchor, sel.head)
          to = Math.max(sel.anchor, sel.head)
        }
        if (from === -1 && range && typeof view.posAtCoords === 'function') {
          const r = range.getBoundingClientRect()
          if (r && r.width > 0 && r.height > 0) {
            const f = view.posAtCoords({ x: r.left + 1, y: r.top + Math.min(2, r.height / 2) })
            const t = view.posAtCoords({ x: r.right - 1, y: r.bottom - Math.min(2, r.height / 2) })
            if (typeof f === 'number' && typeof t === 'number') {
              from = f
              to = t
            }
          }
        }
        if (from === -1) return null
        const a = doc.lineAt(from).number
        const b = doc.lineAt(to).number
        return [Math.min(a, b), Math.max(a, b)]
      } catch (e) {
        return null
      }
    }

    // 从选区 DOM 向上找会话消息行的 anchor key
    function anchorKeyFromHost(node) {
      if (!node || !node.closest) return null
      const row = node.closest('[data-chat-anchor-key]')
      return row ? row.getAttribute('data-chat-anchor-key') : null
    }

    // 定位信息全无时打印选区的祖先链（用于识别尚未适配的界面）
    function describeSurface(node) {
      const out = []
      let el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
      for (let i = 0; el && i < 6; i++) {
        const cls = typeof el.className === 'string' && el.className !== '' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
        const attrs = []
        const list = el.attributes || []
        for (let j = 0; j < list.length; j++) {
          const name = list[j].name
          if (name.indexOf('data-') === 0) attrs.push(name)
        }
        out.push(String(el.tagName || '?').toLowerCase() + cls + (attrs.length > 0 ? '[' + attrs.join(',') + ']' : ''))
        el = el.parentElement
      }
      return out.join(' < ')
    }

    // ============ 编辑器内定位（直接操作 workbench 的 CodeMirror 实例） ============
    // CM6 通过 dom.cmTile 把 DOM 元素与 EditorView 关联（findFromDOM 内部即 tile.root.view），
    // 纯 DOM 属性即可拿到 view，无需 import workbench 内部类。
    function findEditorViewByPath(relPath) {
      if (!relPath) return null
      const hosts = document.querySelectorAll('[data-path]')
      for (const h of hosts) {
        if (h.getAttribute('data-path') !== relPath) continue
        const cm = h.querySelector('.cm-content')
        const tile = (cm && cm.cmTile) || h.cmTile || null
        const view = tile && tile.root ? tile.root.view : null
        if (view && view.dom && view.dom.isConnected) return view
      }
      // better-sidebar：按绝对路径/文件名在侧栏编辑窗口中匹配标准 CM6 视图
      const cwd = currentCwd()
      const abs = cwd ? joinAbs(cwd, relPath) : relPath
      const bsView = findBetterSidebarView(abs)
      if (bsView) return bsView
      // 兜底：全文档按路径输入框找（原生标签页宿主里没有 [data-dsh-better-sidebar]）
      const anyView = findViewByPathInput(abs)
      if (anyView) return anyView
      return null
    }

    // 在编辑器里选中引用文本并滚动到可视区（CM6 dispatch 原生支持 scrollIntoView）。
    // 有 lineRange 时直接按行号精确定位（doc.line(n)），不再依赖文本首次匹配；
    // 定位后对目标行加临时高亮 .dsfq-cm-flash（视口外的行在滚动渲染后再补一次）。
    function locateInEditor(view, text, lineRange) {
      try {
        if (!view || !view.dom || view.dom.offsetParent === null) return false
        const doc = view.state.doc
        let from = -1
        let to = -1
        if (Array.isArray(lineRange) && lineRange.length === 2 && lineRange[0] >= 1 && lineRange[1] >= lineRange[0] && lineRange[1] <= doc.lines) {
          from = doc.line(lineRange[0]).from
          to = doc.line(lineRange[1]).to
        } else {
          const probe = (text || '').trim()
          const firstLine = probe.split('\n')[0].trim()
          if (probe !== '') {
            const full = doc.toString()
            from = full.indexOf(probe)
            if (from === -1 && firstLine !== '') from = full.indexOf(firstLine)
          }
        }
        if (from === -1) return false
        if (to === -1) to = Math.min(from + (text || '').trim().length, doc.length)
        view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
        view.focus()
        if (Array.isArray(lineRange) && lineRange.length === 2) {
          flashCmLines(view, Math.max(1, lineRange[0]), Math.min(doc.lines, lineRange[1]))
        }
        return true
      } catch (e) {
        console.error('[file-quote] 编辑器定位失败', e)
        return false
      }
    }

    // 给 CM6 视图的指定行区间加临时高亮（滚动后视口外的行会重新渲染，延迟补扫两次）
    function flashCmLines(view, lineA, lineB) {
      try {
        const apply = () => {
          const doc = view.state.doc
          const els = new Set()
          for (let n = lineA; n <= lineB; n++) {
            if (n < 1 || n > doc.lines) continue
            const at = view.domAtPos ? view.domAtPos(doc.line(n).from) : null
            if (!at || !at.node) continue
            let el = at.node.nodeType === 1 ? at.node : (at.node.parentElement || null)
            while (el) {
              if (el.classList && el.classList.contains('cm-line')) {
                els.add(el)
                break
              }
              el = el.parentElement
            }
          }
          for (const el of els) {
            el.classList.add('dsfq-cm-flash')
            setTimeout(() => el.classList.remove('dsfq-cm-flash'), 1800)
          }
        }
        apply()
        setTimeout(apply, 300)
        setTimeout(apply, 800)
      } catch (e) { /* 高亮失败不影响定位 */ }
    }

    function basenameOf(path) {
      const parts = String(path || '').split(/[/\\]/)
      return parts[parts.length - 1] || ''
    }

    // ============ dsh-better-sidebar 兼容层（含 dsh-web-ui-all 内置 web-ui-better-sidebar） ============
    // better-sidebar 渲染标准 CodeMirror 6（.cm-editor / .cm-content / cmTile 均可用），
    // 但不提供 workbench 的 [data-path]：文件路径从编辑器窗口的路径输入框 title（绝对路径）读取，
    // 打开/激活文件走其公开服务 ctx.provide('betterSidebar', ...) 的 openFile。
    function isAbsPath(p) {
      return /^[a-zA-Z]:[\\/]/.test(String(p || '')) || String(p || '').startsWith('/')
    }
    function joinAbs(a, b) {
      if (isAbsPath(b)) return String(b || '')
      return String(a || '').replace(/[\\/]+$/, '') + '/' + String(b || '').replace(/^[\\/]+/, '')
    }
    function relPathOf(cwd, abs) {
      try {
        const c = String(cwd || '').split(/[\\/]/).filter(Boolean)
        const a = String(abs || '').split(/[\\/]/).filter(Boolean)
        if (!isAbsPath(abs) || c.length === 0 || a.length === 0 || c[0].toLowerCase() !== a[0].toLowerCase()) {
          return String(abs || '')
        }
        let i = 0
        while (i < c.length && i < a.length && c[i].toLowerCase() === a[i].toLowerCase()) i++
        const up = c.length - i
        const rest = a.slice(i).join('/')
        return (up > 0 ? new Array(up).fill('..').join('/') + (rest ? '/' : '') : '') + rest
      } catch (e) {
        return String(abs || '')
      }
    }
    // 从选区所在编辑器容器向上找「既含路径输入框又含编辑器/预览容器」的编辑器窗口，
    // 读取其路径输入框的绝对路径（首个命中即窗口本身，避免跨窗误配）
    function absPathForEditor(editor, sidebarHost) {
      if (!editor || !sidebarHost) return null
      let el = editor
      while (el && el !== sidebarHost) {
        if (el.querySelector) {
          const inp = el.querySelector('input[title]')
          if (inp && inp.title && el.querySelector('.cm-content, [class*="editorCm"], [class*="editorMd"]')) return inp.title
        }
        el = el.parentElement
      }
      // 兜底：类名/预览结构变化时，退化为「侧栏内最近一个带路径样 title 的输入框」，
      // 再退化为「侧栏里唯一的那个路径输入框」（共享头部布局下选区祖先链上没有输入框）
      el = editor.parentElement
      while (el && el !== sidebarHost) {
        if (el.querySelector) {
          const inputs = el.querySelectorAll('input[title]')
          for (const inp of inputs) {
            if (isPathLikeTitle(String(inp.title || ''))) return inp.title
          }
        }
        el = el.parentElement
      }
      return uniqueSidebarPath(sidebarHost)
    }
    function betterSidebarService() {
      try {
        const bs = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('betterSidebar') : null
        return bs && typeof bs === 'object' ? bs : null
      } catch (e) {
        return null
      }
    }
    // 选区在 better-sidebar 的代码编辑器 / markdown 预览内 → 返回工作区相对路径（供引用块来源行）
    function relPathFromBetterSidebar(node) {
      try {
        if (!node || !node.closest) return null
        const host = node.closest('[data-dsh-better-sidebar]')
        if (!host) return null
        const editor = node.closest('.cm-editor, [class*="editorCm"], [class*="editorMd"]')
        // 三路取路径：本窗口的路径输入框 → 祖先链上任意路径输入框 → 侧栏唯一路径输入框
        let abs = editor ? absPathForEditor(editor, host) : null
        if (!abs) abs = absPathFromSidebarAncestors(node, host)
        if (!abs) abs = uniqueSidebarPath(host)
        if (!abs) return null
        const cwd = currentCwd()
        return cwd ? relPathOf(cwd, abs) : abs
      } catch (e) {
        return null
      }
    }

    // 通用「带路径输入框的编辑器窗口」识别：不依赖 [data-dsh-better-sidebar]，
    // 覆盖 better-sidebar 的原生标签页宿主、以及其它把 CM6 编辑器搬进宿主面板的布局。
    // 从 CM6 编辑器容器逐层向上，取最近的一个「像文件路径」的 input[title]（限 12 层，避免误抓远处的输入框）。
    function relPathFromEditorWindow(node) {
      try {
        const start = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
        if (!start || !start.closest) return null
        const editor = start.closest('.cm-editor, [class*="editorCm"], [class*="editorMd"]')
        if (!editor) return null
        let el = editor
        for (let hops = 0; el && hops < 12; hops++) {
          if (el.querySelector) {
            const inputs = el.querySelectorAll('input[title]')
            for (const inp of inputs) {
              const t = String(inp.title || '')
              if (isPathLikeTitle(t)) return normalizePreviewPath(t)
            }
          }
          el = el.parentElement
        }
        return null
      } catch (e) {
        return null
      }
    }

    // 全文档范围按路径输入框 title 找已挂载的 CM6 视图（jump-back 用）
    function findViewByPathInput(absPath, root) {
      try {
        if (!absPath) return null
        const scope = root || document
        if (!scope || !scope.querySelectorAll) return null
        const target = String(absPath || '').replace(/[\\/]+$/, '')
        const base = basenameOf(target)
        const inputs = scope.querySelectorAll('input[title]')
        for (const inp of inputs) {
          const t = String(inp.title || '').replace(/[\\/]+$/, '')
          if (t === '') continue
          const same = t.toLowerCase() === target.toLowerCase() || (base !== '' && basenameOf(t).toLowerCase() === base.toLowerCase())
          if (!same) continue
          let el = inp.parentElement
          for (let hops = 0; el && hops < 10; hops++) {
            const cm = el.querySelector ? el.querySelector('.cm-content') : null
            if (cm) {
              const tile = cm.cmTile || el.cmTile || null
              const view = tile && tile.root ? tile.root.view : null
              if (view && view.dom && view.dom.isConnected) return view
            }
            el = el.parentElement
          }
        }
        return null
      } catch (e) {
        return null
      }
    }

    // 从选区向上在侧栏内找最近的路径输入框（不依赖编辑器容器的类名）
    function absPathFromSidebarAncestors(node, sidebarHost) {
      try {
        let el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
        while (el && el !== sidebarHost) {
          if (el.querySelector) {
            const inputs = el.querySelectorAll('input[title]')
            for (const inp of inputs) {
              const t = String(inp.title || '')
              if (isPathLikeTitle(t)) return t
            }
          }
          el = el.parentElement
        }
        return null
      } catch (e) {
        return null
      }
    }

    // 路径输入框的 title 是否像一个文件路径（含盘符/分隔符/扩展名）
    function isPathLikeTitle(t) {
      return t !== '' && (isAbsPath(t) || /[\\/]/.test(t) || /\.[a-zA-Z0-9]{1,6}$/.test(t))
    }

    // 侧栏里只挂了一个文件时（最常见的场景），那个路径输入框就是当前文件；
    // 有些布局把路径输入框放在共享的窗口头部，选区的祖先链上根本遇不到它。
    function uniqueSidebarPath(sidebarHost) {
      try {
        if (!sidebarHost || !sidebarHost.querySelectorAll) return null
        const found = []
        for (const inp of sidebarHost.querySelectorAll('input[title]')) {
          const t = String(inp.title || '')
          if (!isPathLikeTitle(t)) continue
          if (found.indexOf(t) === -1) found.push(t)
        }
        return found.length === 1 ? found[0] : null
      } catch (e) {
        return null
      }
    }
    // 在 better-sidebar 中找已挂载（激活 tab）的目标文件 CM6 视图：
    // 路径输入框 → 所在窗口 → .cm-content → cmTile.root.view
    function findBetterSidebarView(absPath) {
      try {
        if (!absPath) return null
        const host = document.querySelector('[data-dsh-better-sidebar]')
        if (!host) return null
        const target = String(absPath || '').replace(/[\\/]+$/, '')
        const base = basenameOf(target)
        const inputs = host.querySelectorAll('input[title]')
        for (const inp of inputs) {
          const t = (inp.title || '').replace(/[\\/]+$/, '')
          const same = t.toLowerCase() === target.toLowerCase() || (base !== '' && basenameOf(t).toLowerCase() === base.toLowerCase())
          if (!same) continue
          let el = inp.parentElement
          while (el && el !== host) {
            const cm = el.querySelector('.cm-content')
            if (cm) {
              const tile = cm.cmTile || el.cmTile || null
              const view = tile && tile.root ? tile.root.view : null
              if (view && view.dom && view.dom.isConnected) return view
              break
            }
            el = el.parentElement
          }
        }
        return null
      } catch (e) {
        return null
      }
    }
    // 通过 better-sidebar 公开服务打开/激活文件（per-path 去重 tab）
    function openInBetterSidebar(absPath) {
      try {
        const bs = betterSidebarService()
        if (!bs || typeof bs.openFile !== 'function' || !absPath) return false
        const sessionId = currentSessionId
        if (!sessionId) return false
        const cwd = currentCwd() || undefined
        bs.openFile({ sessionId, cwd }, absPath)
        return true
      } catch (e) {
        console.error('[file-quote] better-sidebar openFile 失败', e)
        return false
      }
    }

    // ============ DSH 右侧「文档预览」窗格兼容层（client-ui-sidebar-documentpreview） ============
    // 该窗格既没有 workbench 的 [data-path]，也不用 CodeMirror：
    //   窗格根：   [data-document-preview]（正文 [data-textpreview-body]）
    //   文件路径： [data-textpreview-path]（PathLabel，title = 绝对路径/展示路径）
    //   纯文本行： <div data-textpreview-line="N">，N 即 1-based 源码行号（懒加载页带绝对偏移）
    //   代码高亮： [data-code-preview] → [data-code-block-content] → pre > span.line（文档序 = 行号，首行 = 1）
    function previewRootOf(node) {
      const start = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
      if (!start || !start.closest) return null
      const root = start.closest('[data-document-preview]')
      if (root) return root
      const body = start.closest('[data-textpreview-body]')
      if (body) return body.parentElement || body
      const label = start.closest('[data-textpreview-path]')
      if (label && label.parentElement && label.parentElement.parentElement) return label.parentElement.parentElement
      return null
    }

    function normalizePreviewPath(raw) {
      const p = String(raw == null ? '' : raw).trim()
      if (p === '') return null
      const cwd = currentCwd()
      if (isAbsPath(p)) return cwd ? relPathOf(cwd, p) : p
      return p
    }

    // 选区在右侧文档预览窗格内 → 返回工作区相对路径（供引用块来源行）
    function relPathFromDocumentPreview(node) {
      try {
        const root = previewRootOf(node)
        if (!root || !root.querySelector) return null
        const label = root.querySelector('[data-textpreview-path]')
        if (!label) return null
        return normalizePreviewPath(label.getAttribute('title') || label.textContent || '')
      } catch (e) {
        return null
      }
    }

    // 预览窗格内某一节点所属的源码行号
    function previewLineNumberOf(node) {
      try {
        if (!node) return null
        const el = node.nodeType === 1 ? node : node.parentElement
        if (!el || !el.closest) return null
        const plain = el.closest('[data-textpreview-line]')
        if (plain) {
          const n = Number(plain.getAttribute('data-textpreview-line'))
          if (Number.isFinite(n) && n >= 1) return n
        }
        const line = el.closest('.line')
        if (line) {
          const scope = line.closest('[data-code-block-content]') || line.closest('pre') || line.parentElement
          if (scope && scope.querySelectorAll) {
            const all = scope.querySelectorAll('.line')
            const index = Array.prototype.indexOf.call(all, line)
            if (index >= 0) return index + 1
          }
        }
        return null
      } catch (e) {
        return null
      }
    }

    // 选区端点常常落在容器元素上（跨块选择）：就近取一个子节点的行号
    function previewLineNear(node, offset) {
      let n = previewLineNumberOf(node)
      if (n !== null) return n
      if (!node || node.nodeType !== 1 || !node.childNodes) return null
      const kids = node.childNodes
      const at = Math.min(typeof offset === 'number' ? offset : kids.length, kids.length)
      for (let i = at - 1; i >= 0; i--) {
        n = previewLineNumberOf(kids[i])
        if (n !== null) return n
      }
      for (let i = at; i < kids.length; i++) {
        n = previewLineNumberOf(kids[i])
        if (n !== null) return n
      }
      return null
    }

    function lineRangeFromDocumentPreview(range) {
      try {
        if (!range) return null
        // 只在文档预览窗格内按 DOM 行号换算：别处（聊天里的代码块/差异卡片）的 .line
        // 并不等于文件行号，按索引算会给出错误的行区间。
        const startNode = range.startContainer
        const startEl = startNode && startNode.nodeType === 1 ? startNode : (startNode ? startNode.parentElement : null)
        if (!startEl || !startEl.closest) return null
        if (!startEl.closest('[data-textpreview-body]') && !startEl.closest('[data-document-preview]')) return null
        const a = previewLineNear(range.startContainer, range.startOffset)
        const b = previewLineNear(range.endContainer, range.endOffset)
        if (a === null && b === null) return null
        const lo = a === null ? b : a
        const hi = b === null ? a : b
        return [Math.min(lo, hi), Math.max(lo, hi)]
      } catch (e) {
        return null
      }
    }

    function previewRowsFor(body) {
      try {
        const plain = body.querySelectorAll('[data-textpreview-line]')
        if (plain.length > 0) return plain
        return body.querySelectorAll('.line')
      } catch (e) {
        return []
      }
    }

    // 在预览正文里找引用的目标行：优先按已记录的行区间，其次按引用文本首行反查
    function previewRowFor(body, text, lineRange) {
      const rows = Array.prototype.slice.call(previewRowsFor(body))
      if (rows.length === 0) return null
      const numberAt = (row) => {
        const attr = row.getAttribute ? row.getAttribute('data-textpreview-line') : null
        return attr === null || attr === undefined ? null : Number(attr)
      }
      if (Array.isArray(lineRange) && lineRange.length === 2 && lineRange[0] >= 1) {
        let first = null
        let last = null
        for (const row of rows) {
          const n = numberAt(row)
          if (n === lineRange[0]) first = row
          if (n === lineRange[1]) last = row
        }
        if (!first && numberAt(rows[0]) === null) {
          // 代码高亮模式没有行号属性：已加载页从第 1 行开始，按文档序取
          const startIndex = lineRange[0] - 1
          const endIndex = Math.min(lineRange[1] - 1, rows.length - 1)
          if (startIndex >= 0 && startIndex < rows.length) first = rows[startIndex]
          if (endIndex >= 0) last = rows[endIndex]
        }
        if (first) return { first, last: last || first }
      }
      const probe = String(text || '').trim()
      if (probe === '') return null
      const head = (probe.split('\n')[0] || '').trim()
      const needles = head !== '' && head !== probe ? [probe, head] : [probe]
      const parts = probe.split('\n').map((l) => l.trim()).filter((l) => l !== '')
      const tail = parts.length > 0 ? parts[parts.length - 1] : head
      for (const needle of needles) {
        const hit = rows.findIndex((row) => (row.textContent || '').indexOf(needle) !== -1)
        if (hit === -1) continue
        let end = hit
        for (let i = hit; i < rows.length; i++) {
          if ((rows[i].textContent || '').indexOf(tail) !== -1) { end = i; break }
        }
        return { first: rows[hit], last: rows[end] }
      }
      return null
    }

    function flashPreviewRows(first, last) {
      try {
        const rows = []
        let el = first
        while (el) {
          rows.push(el)
          if (el === last) break
          el = el.nextElementSibling
        }
        for (const row of rows) if (row.classList) row.classList.add('dsfq-line-flash')
        setTimeout(() => { for (const row of rows) if (row.classList) row.classList.remove('dsfq-line-flash') }, 1800)
      } catch (e) { /* ignore */ }
    }

    // 用 DOM Range 选中预览里的原文（不修改 DOM，避免干扰 React 渲染），并抑制批注气泡
    function selectPreviewRowText(row, text) {
      try {
        const probe = String(text || '').trim()
        if (!row || probe === '') return
        const needle = (probe.split('\n')[0] || '').trim() || probe
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          const content = node.textContent || ''
          const at = content.indexOf(needle)
          if (at === -1) continue
          // 输入框持有光标时不搬动全局选区，改用临时背景高亮（见 composerHoldsSelection）。
          if (composerHoldsSelection()) {
            flashElementText(node.parentElement)
            selectionStore.hide()
            return
          }
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, Math.min(at + needle.length, content.length))
          const sel = window.getSelection()
          if (sel) {
            sel.removeAllRanges()
            sel.addRange(range)
          }
          toolbarSuppressUntil = Date.now() + 3000
          selectionStore.hide()
          return
        }
      } catch (e) { /* ignore */ }
    }

    // 在已打开的右侧文档预览窗格里定位（滚动到目标行 + 高亮）——该窗格没有 CM6 视图可用
    function locateInDocumentPreview(relPath, text, lineRange, pos) {
      try {
        if (!relPath) return false
        const wanted = String(relPath).replace(/^[.][\\/]+/, '').toLowerCase()
        const base = basenameOf(relPath).toLowerCase()
        const labels = Array.prototype.slice.call(document.querySelectorAll('[data-textpreview-path]'))
        // 先精确匹配相对路径，再退化到同名文件（同名只是兜底，绝不让它压过精确命中）
        const rankOf = (label) => {
          const panePath = normalizePreviewPath(label.getAttribute('title') || label.textContent || '')
          if (!panePath) return null
          const cand = String(panePath).replace(/^[.][\\/]+/, '').toLowerCase()
          if (cand === wanted) return { label, panePath, rank: 0 }
          if (base !== '' && basenameOf(panePath).toLowerCase() === base) return { label, panePath, rank: 1 }
          return null
        }
        const hits = labels.map(rankOf).filter(Boolean).sort((a, b) => a.rank - b.rank)
        if (hits.length === 0) return false
        const label = hits[0].label
        const root = label.closest('[data-document-preview]') || (label.parentElement && label.parentElement.parentElement) || label.parentElement
        if (!root) return false
        const body = root.querySelector('[data-textpreview-body]') || root
        const row = previewRowFor(body, text, lineRange)
        if (row) {
          if (row.first.scrollIntoView) row.first.scrollIntoView({ block: 'center', behavior: 'smooth' })
          flashPreviewRows(row.first, row.last)
          selectPreviewRowText(row.first, text)
          showToast('已在右侧文档预览中定位并高亮 ✓', pos || lastPointerPos, true)
          return true
        }
        if (body.scrollIntoView) body.scrollIntoView({ block: 'start' })
        showToast('已切到文档预览「' + relPath + '」（未精确定位到原文行）', pos || lastPointerPos, true)
        return true
      } catch (e) {
        console.error('[file-quote] 文档预览定位失败', e)
        return false
      }
    }

    // markdown 预览模式：找到目标文件的编辑器窗口及其渲染预览容器
    // （编辑模式下 .editorMd 不存在；预览模式下 .cm-editor 是隐藏的）
    function markdownPreviewWindow(absPath) {
      try {
        if (!absPath) return null
        const host = document.querySelector('[data-dsh-better-sidebar]')
        if (!host) return null
        const target = String(absPath || '').replace(/[\\/]+$/, '')
        const base = basenameOf(target)
        const inputs = host.querySelectorAll('input[title]')
        for (const inp of inputs) {
          const t = (inp.title || '').replace(/[\\/]+$/, '')
          const same = t.toLowerCase() === target.toLowerCase() || (base !== '' && basenameOf(t).toLowerCase() === base.toLowerCase())
          if (!same) continue
          let el = inp.parentElement
          while (el && el !== host) {
            const md = el.querySelector('[class*="editorMd"]')
            if (md) return { window: el, preview: md }
            el = el.parentElement
          }
        }
        return null
      } catch (e) {
        return null
      }
    }

    // 在渲染的 markdown 预览里滚动定位并选中引用文本（预览模式下编辑器隐藏，CM6 跳转不可用）。
    // 用 Range 选中高亮（不修改 DOM，避免干扰 React 渲染），并短暂抑制批注工具条弹出。
    function highlightInMarkdownPreview(absPath, text) {
      try {
        const found = markdownPreviewWindow(absPath)
        if (!found || !found.preview) return false
        const container = found.preview
        if (typeof container.offsetParent === 'undefined' || container.offsetParent === null) return false
        const probe = (text || '').trim()
        if (!probe) return false
        const firstLine = probe.split('\n')[0].trim()
        let targetNode = null
        let targetOffset = -1
        let matchLen = 0
        const search = (needle) => {
          const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
          while (w.nextNode()) {
            const node = w.currentNode
            const idx = node.textContent.indexOf(needle)
            if (idx !== -1) {
              targetNode = node
              targetOffset = idx
              matchLen = needle.length
              return true
            }
          }
          return false
        }
        if (!search(probe) && firstLine !== '' && !search(firstLine)) return false
        const range = document.createRange()
        range.setStart(targetNode, targetOffset)
        range.setEnd(targetNode, targetOffset + matchLen)
        const nodeEl = targetNode.parentElement
        if (nodeEl && nodeEl.scrollIntoView) nodeEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
        // 输入框持有光标时不搬动全局选区，改用临时背景高亮（见 composerHoldsSelection）。
        if (composerHoldsSelection()) {
          flashElementText(nodeEl)
          return true
        }
        const sel = window.getSelection()
        if (sel) {
          sel.removeAllRanges()
          sel.addRange(range)
          toolbarSuppressUntil = Date.now() + 3000
        }
        return true
      } catch (e) {
        return false
      }
    }

    // better-sidebar 的 CM6 自己接管鼠标选区（DOM selectionchange / window.getSelection
    // 不会可靠同步），因此 pointerup 时直接读 CM view.state.selection —— 与 better-sidebar
    // 自身的选区浮层同源。选中为空时收起工具条（DOM 事件路径收不到 CM 的选区变更）。
    function betterSidebarSelectionFromPointer(e) {
      try {
        const t = e && e.target
        if (!t || !t.closest) return
        const editor = t.closest('.cm-editor')
        if (!editor) return
        const host = editor.closest('[data-dsh-better-sidebar]')
        if (!host) return
        const cm = editor.querySelector('.cm-content')
        const tile = (cm && cm.cmTile) || editor.cmTile || null
        const view = tile && tile.root ? tile.root.view : null
        if (!view || !view.state || !view.state.selection) return
        const sel = view.state.selection.main
        if (!sel || sel.empty) {
          selectionStore.hide()
          return
        }
        const text = view.state.sliceDoc(sel.from, sel.to).trim()
        if (!text) {
          selectionStore.hide()
          return
        }
        const doc = view.state.doc
        const a = doc.lineAt(sel.from).number
        const b = doc.lineAt(sel.to).number
        const abs = absPathForEditor(editor, host) || absPathFromSidebarAncestors(editor, host) || uniqueSidebarPath(host)
        if (!abs) return
        const cwd = currentCwd()
        const relPath = cwd ? relPathOf(cwd, abs) : abs
        const coords = view.coordsAtPos ? view.coordsAtPos(sel.head) : null
        if (!coords) return
        const rect = { left: coords.left, top: coords.top, right: coords.right, bottom: coords.bottom }
        const vh = typeof window !== 'undefined' ? window.innerHeight : 768
        if (rect.bottom < -8 || rect.top > vh + 8) return
        selectionStore.show({
          text: clipText(text, MAX_SELECTION),
          rect,
          relPath,
          anchorKey: null,
          lineRange: [Math.min(a, b), Math.max(a, b)],
        })
      } catch (err) {
        console.error('[file-quote] better-sidebar pointer 选区处理失败', err)
      }
    }

    // 尝试点击 workbench tab 栏中的同名文件 tab（激活后编辑器才会挂载）
    function clickTabByBase(base) {
      const tabs = document.querySelectorAll('[role="tab"]')
      for (const t of tabs) {
        const nameEl = t.querySelector('span')
        if (nameEl && nameEl.textContent === base) {
          t.click()
          return true
        }
      }
      return false
    }

    // 尝试在 workbench 文件树中点击同名文件行（懒加载树：仅能命中已渲染的行）
    function clickTreeFileByBase(base) {
      const spans = document.querySelectorAll('span')
      for (const s of spans) {
        if (s.textContent !== base) continue
        const btn = s.closest('button')
        if (!btn || btn.getAttribute('role') === 'tab') continue
        const rowWrap = btn.parentElement
        if (!rowWrap) continue
        // 目录行的首个子 span 是 ▸/▾ 箭头，文件行是空串：仅点文件行
        const first = rowWrap.querySelector('span')
        const chevron = first && first !== s ? (first.textContent || '').trim() : ''
        if (chevron !== '' && chevron !== '▸' && chevron !== '▾') continue
        if (chevron === '') {
          btn.click()
          return true
        }
      }
      return false
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    // ============ 行区间兜底：界面本身给不出行号时（渲染型预览）用源码文本反查 ============
    // 与 better-sidebar 的 linesOfSelection 同一策略：仅「唯一命中」才认行号，命中多处直接放弃。
    function lineRangeFromSource(source, text) {
      try {
        const src = String(source || '')
        let probe = String(text || '')
        if (probe === '') return null
        if (probe.endsWith('\n')) probe = probe.slice(0, -1)
        if (probe === '') return null
        const at = src.indexOf(probe)
        if (at === -1) return null
        if (src.indexOf(probe, at + 1) !== -1) return null
        const lineAt = (index) => {
          let line = 1
          const end = Math.min(index, src.length)
          for (let i = 0; i < end; i++) if (src[i] === '\n') line++
          return line
        }
        return [lineAt(at), lineAt(at + Math.max(probe.length - 1, 0))]
      } catch (e) {
        return null
      }
    }

    // 取文件源码：优先已挂载的 CM6 视图（better-sidebar 预览模式下编辑器只是隐藏），
    // 否则走插件自身的读文件路由（host 侧读盘）。
    async function sourceTextOf(relPath, cwd) {
      try {
        const view = findEditorViewByPath(relPath)
        if (view && view.state && view.state.doc) return view.state.doc.toString()
      } catch (e) { /* ignore */ }
      if (!cwd) return null
      try {
        const url = '/dsh-file-quote/read?cwd=' + encodeURIComponent(cwd) + '&path=' + encodeURIComponent(relPath)
        const res = await fetch(url)
        const data = await res.json().catch(() => null)
        if (data && data.ok && typeof data.text === 'string') return data.text
      } catch (e) { /* ignore */ }
      return null
    }

    async function backfillLineRange(item) {
      if (!item || !item.relPath) return null
      if (Array.isArray(item.lineRange) && item.lineRange.length === 2) return item.lineRange
      const source = await sourceTextOf(item.relPath, item.cwd || currentCwd())
      if (!source) return null
      return lineRangeFromSource(source, item.text)
    }

    // 用 harness 官方资源通路在右侧文档预览里打开文件并跳转到指定行。
    // 地址文法：dsh-resource://file/session/<sessionId>/<path>，行号经 navigation.params.line 传递
    // （ui-sidebar-documentpreview 的 scrollToLine 消费它）。
    function openInRightPreview(sessionId, relPath, line) {
      try {
        const sidebarRight = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('sidebarRight') : null
        if (!sidebarRight || typeof sidebarRight.openResource !== 'function') return false
        const sid = sessionId || currentSessionId
        if (!sid || !relPath) return false
        const normalized = String(relPath).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
        const encoded = normalized.split('/').map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/')
        const address = 'dsh-resource://file/session/' + encodeURIComponent(sid) + '/' + encoded
        const params = typeof line === 'number' && line >= 1 ? { line } : undefined
        sidebarRight.openResource(address, params ? { params } : {})
        return true
      } catch (e) {
        console.warn('[file-quote] 无法在右侧文档预览中打开文件：', relPath, e && e.message ? e.message : e)
        return false
      }
    }

    // ============ 文件引用定位：优先编辑器内跳转，失败则浮层展示 ============
    async function locateFile(info, pos) {
      if (!info || !info.relPath) {
        showToast('定位失败：缺少文件路径信息', pos, false)
        return
      }
      // 1. 当前激活 tab 的编辑器内直接定位
      let view = findEditorViewByPath(info.relPath)
      if (view && locateInEditor(view, info.text, info.lineRange)) {
        showToast('已在编辑器中定位并高亮 ✓', pos, true)
        return
      }
      // 1.5 markdown 预览模式：编辑器隐藏，直接在渲染预览里滚动 + 选中高亮
      const bsAbs = info.cwd ? joinAbs(info.cwd, info.relPath) : info.relPath
      if (highlightInMarkdownPreview(bsAbs, info.text)) {
        showToast('已在侧边栏预览中定位并高亮 ✓', pos, true)
        return
      }
      // 1.6 右侧「文档预览」窗格（ui-sidebar-documentpreview）：不是 CM6，
      //      没有 [data-path]，靠窗格头部 PathLabel 认路径、靠 data-textpreview-line / pre .line 认行
      if (locateInDocumentPreview(info.relPath, info.text, info.lineRange, pos)) return
      // 2. 文件已打开但未激活：点击 tab 激活后等待编辑器挂载再定位
      const base = basenameOf(info.relPath)
      if (base !== '' && clickTabByBase(base)) {
        await sleep(400)
        view = findEditorViewByPath(info.relPath)
        if (view && locateInEditor(view, info.text, info.lineRange)) {
          showToast('已激活文件并在编辑器中定位 ✓', pos, true)
          return
        }
      }
      // 3. 文件未打开：尝试从文件树点击打开后定位
      if (base !== '' && clickTreeFileByBase(base)) {
        await sleep(600)
        view = findEditorViewByPath(info.relPath)
        if (view && locateInEditor(view, info.text, info.lineRange)) {
          showToast('已打开文件并在编辑器中定位 ✓', pos, true)
          return
        }
      }
      // 3.5 better-sidebar（含 web-ui-all 内置）：通过其公开 service 打开/激活文件后定位
      if (openInBetterSidebar(bsAbs)) {
        await sleep(600)
        let bsView = findBetterSidebarView(bsAbs)
        if (bsView && locateInEditor(bsView, info.text, info.lineRange)) {
          showToast('已在侧边栏打开文件并定位 ✓', pos, true)
          return
        }
        await sleep(400)
        bsView = findBetterSidebarView(bsAbs)
        if (bsView && locateInEditor(bsView, info.text, info.lineRange)) {
          showToast('已在侧边栏打开文件并定位 ✓', pos, true)
          return
        }
      }
      // 3.6 右侧文档预览窗格没打开这个文件：走官方资源通路（dsh-resource://file/…）
      //      打开并带上行号，窗格自己会滚到目标行，随后我们补一次高亮
      const targetLine = Array.isArray(info.lineRange) && info.lineRange.length === 2 ? info.lineRange[0] : null
      if (openInRightPreview(info.sessionId, info.relPath, targetLine)) {
        await sleep(500)
        if (locateInDocumentPreview(info.relPath, info.text, info.lineRange, pos)) return
        await sleep(500)
        if (locateInDocumentPreview(info.relPath, info.text, info.lineRange, pos)) return
      }
      // 4. 兜底：浮层展示文件原文（host 读文件）
      if (!info.cwd) {
        showToast('无法定位：文件未在编辑器中打开', pos, false)
        return
      }
      locatorStore.open({
        path: info.relPath,
        text: info.text,
        loading: true,
        error: null,
        lines: null,
        hitLine: null,
      })
      try {
        const url = '/dsh-file-quote/read?cwd=' + encodeURIComponent(info.cwd) + '&path=' + encodeURIComponent(info.relPath)
        const res = await fetch(url)
        const data = await res.json().catch(() => null)
        if (!data || !data.ok) {
          const hint = data && data.hint ? data.hint : ''
          locatorStore.open({
            path: info.relPath,
            text: info.text,
            loading: false,
            error: (data && data.error ? data.error : '读取失败') + (hint ? '：' + hint : ''),
            lines: null,
            hitLine: null,
          })
          return
        }
        const lines = data.text.split('\n')
        const probe = (info.text || '').trim()
        const firstLine = probe.split('\n')[0].trim()
        let hitLine = -1
        if (probe !== '') {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf(probe.slice(0, 80)) !== -1) { hitLine = i; break }
          }
        }
        if (hitLine === -1 && firstLine !== '') {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf(firstLine.slice(0, 80)) !== -1) { hitLine = i; break }
          }
        }
        locatorStore.open({
          path: info.relPath,
          text: info.text,
          loading: false,
          error: null,
          lines,
          hitLine,
        })
      } catch (e) {
        locatorStore.open({
          path: info.relPath,
          text: info.text,
          loading: false,
          error: '定位失败：' + (e && e.message ? e.message : String(e)),
          lines: null,
          hitLine: null,
        })
      }
    }

    // ============ 消息引用定位：滚动到原文消息行并高亮 ============
    function locateMessage(info, pos) {
      let anchorKey = info.anchorKey
      if (!anchorKey && info.body) {
        const probe = (info.body || '').replace(/^> /, '').slice(0, 24)
        const rows = document.querySelectorAll('[data-chat-anchor-key]')
        for (const r of rows) {
          if (probe && r.textContent && r.textContent.indexOf(probe) !== -1) {
            anchorKey = r.getAttribute('data-chat-anchor-key')
            break
          }
        }
      }
      if (!anchorKey) {
        showToast('定位失败：没有定位键（选中时未识别到消息行）', pos, false)
        return
      }
      const rows = document.querySelectorAll('[data-chat-anchor-key]')
      let row = null
      for (const r of rows) {
        if (r.getAttribute('data-chat-anchor-key') === anchorKey) {
          row = r
          break
        }
      }
      if (!row) {
        showToast('定位失败：原文行不在当前页面', pos, false)
        return
      }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.classList.add('dsfq-flash')
      setTimeout(() => row.classList.remove('dsfq-flash'), 1600)
      showToast('已定位到原文 ✓', pos, true)
    }

    // ============ 组件一：回合尾部引用按钮 ============
    const TurnQuoteActions = (props) => {
      const snapshot = props.useSession((s) => s)
      const texts = React.useMemo(() => extractTurnTexts(snapshot, props.turn), [snapshot, props.turn])
      const open = (e, role, label, text) => {
        const anchorKey = anchorKeyFor(snapshot, props.turn.turn, role, props.seq)
        editorStore.open({ sessionId: props.sessionId, label, text, anchorKey }, rectOf(e))
      }
      const buttons = []
      if (texts.userText) {
        buttons.push(React.createElement('button', {
          key: 'user',
          type: 'button',
          className: 'dsfq-btn',
          onClick: (e) => open(e, 'user', '引用提问 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.userText, MAX_QUOTE)),
        }, '引用提问'))
      }
      if (texts.assistantText) {
        buttons.push(React.createElement('button', {
          key: 'assistant',
          type: 'button',
          className: 'dsfq-btn',
          onClick: (e) => open(e, 'assistant', '引用回答 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.assistantText, MAX_QUOTE)),
        }, '引用回答'))
      }
      if (buttons.length === 0) return null
      return React.createElement('div', { className: 'dsfq-tail' }, buttons)
    }

    // ============ 组件二：选区浮动气泡（选中文字后出现，自动分流） ============
    const SelectionToolbar = (props) => {
      const sel = useSelection()
      // 当前会话 id：走 slot 的 standard prop `useSessions`（harness 官方
      // 取法见 pickCurrentSessionId），props 不可用时退回 sessions 服务快照。
      const hooked = typeof props.useSessions === 'function' ? props.useSessions(pickCurrentSessionId) : undefined
      const current = hooked === undefined || hooked === null ? currentSessionFallback() : hooked
      if (current !== undefined && current !== null) currentSessionId = current
      if (!sel.visible || !sel.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const est = Math.min(384, Math.max(120, sel.text.length * 13 + 76))
      const center = sel.rect.left + (sel.rect.right - sel.rect.left) / 2
      const left = Math.max(12, Math.min(center - est / 2, vw - est - 12))
      const top = sel.rect.top - 42 >= 8 ? sel.rect.top - 42 : sel.rect.bottom + 8
      const finish = () => {
        try {
          // 输入框（Lexical contenteditable）持有选区时绝不清空全局选区：
          // 那会把用户的光标一并清掉，之后第一个字符会落到草稿开头（见 composerHoldsSelection）。
          if (!composerHoldsSelection()) {
            const s = window.getSelection()
            if (s && s.removeAllRanges) s.removeAllRanges()
          }
        } catch (e) { /* ignore */ }
        selectionStore.hide()
      }
      const stage = () => {
        if (current) {
          editorStore.open({
            sessionId: current,
            label: '选中片段',
            text: clipText(sel.text, MAX_SELECTION),
            relPath: sel.relPath,
            anchorKey: sel.anchorKey,
            lineRange: sel.lineRange,
            diag: sel.diag || '',
          }, sel.rect)
          if (!sel.relPath && !sel.anchorKey && sel.diag) {
            console.warn('[file-quote] 未识别到选区来源（该界面暂不支持引用定位）：', sel.diag)
          }
        } else {
          showToast('没有活动会话，无法插入引用', { left: sel.rect.left, top: sel.rect.bottom + 12 }, false)
        }
        finish()
      }
      return mountPortal(React.createElement('div', { className: 'dsfq-toolbar', style: { left, top } },
        React.createElement('span', { className: 'dsfq-toolbar-preview' }, sel.text),
        React.createElement('button', {
          type: 'button',
          className: 'dsfq-btn dsfq-primary dsfq-bubble-cta',
          onMouseDown: (e) => e.preventDefault(),
          onClick: stage,
        }, '批注'),
        React.createElement('button', {
          type: 'button',
          className: 'dsfq-btn dsfq-close',
          onMouseDown: (e) => e.preventDefault(),
          onClick: finish,
        }, '✕'),
      ))
    }

    // ============ 组件三：悬浮批注编辑框（引用预览 + 评论输入框） ============
    const AnnotationEditor = () => {
      const state = useEditor()
      const inputRef = React.useRef(null)
      const [comment, setComment] = React.useState('')
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        setComment('')
        setStatus(null)
        if (state.item && inputRef.current) {
          inputRef.current.focus()
        }
      }, [state.item])
      const open = !!(state.item && state.item.text)
      if (!state.item) return null
      const quoteW = Math.min(260, Math.max(180, state.item.text.length * 12 + 16))
      const inputW = Math.min(320, Math.max(160, comment.length * 13 + 44))
      const w = Math.max(180, Math.min(380, Math.max(quoteW, inputW)))
      let left = 0
      let top = 0
      if (state.rect) {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
        const vh = typeof window !== 'undefined' ? window.innerHeight : 768
        left = Math.max(12, Math.min(state.rect.left, vw - w - 12))
        top = state.rect.top - 12 >= 8 ? state.rect.top - 12 : state.rect.bottom + 12
        if (top + 200 > vh) top = Math.max(8, vh - 220)
      }
      const rangeText = formatLineRange(state.item ? state.item.lineRange : null)
      const insert = async () => {
        const item = state.item
        if (!item) return
        try {
          const c = (comment || '').trim()
          // 渲染型预览（markdown/HTML）给不出 DOM 行号时，用源码文本反查补全行区间，
          // 保证「> 📄 引用来源：路径（第 X-Y 行）」始终带精确行区间。
          let lineRange = Array.isArray(item.lineRange) && item.lineRange.length === 2 ? item.lineRange : null
          if (!lineRange && item.relPath) {
            const found = await backfillLineRange(item)
            // 等待期间用户关掉了批注框就不再插入
            if (editorStore.item !== item) return
            if (found) {
              lineRange = found
              editorStore.update({ lineRange })
            }
          }
          // 引用来源完全集成在引用块内（末行）：AI 可见路径与行区间，
          // 用户侧折叠后不显示来源（仅悬停时随引用块全文可见）
          let quoteBody = quoteBodyOf(item.text)
          if (item.relPath) {
            const range = formatLineRange(lineRange)
            quoteBody = quoteBody + '\n> 📄 引用来源：' + item.relPath + (range !== '' ? '（' + range + '）' : '')
          } else if (DIAGNOSE_IN_QUOTE && item.diag) {
            // 认不出界面时，把祖先链随引用一起发出去（便于定位是哪一层 DOM）；默认关闭
            quoteBody = quoteBody + '\n> ⚠️ 引用来源未识别（file-quote 诊断）：' + item.diag
          }
          // 引用块必须独占行（markdown `>` 行）：序列化文本自带首尾换行，
          // 与前后普通文本/其他引用分离，多个引用连续插入互不粘连。
          // 幂等：draft 中占位符前后已有换行时也只是多出空行，无副作用。
          const quoteBodyClean = quoteBody
          quoteBody = '\n' + quoteBody + '\n'
          const conversation = rootCtx ? rootCtx.get('conversation') : undefined
          const sessions = rootCtx ? rootCtx.get('sessions') : undefined
          if (!conversation || !conversation.input || !sessions) {
            setStatus({ ok: false, text: '写入输入框失败：conversation/sessions 服务不可用' })
            return
          }
          const binding = sessions.binding(item.sessionId)
          if (!binding) {
            setStatus({ ok: false, text: '写入输入框失败：会话不可用' })
            return
          }
          const input = conversation.input.for(binding.ctx)
          const st = input.state.getSnapshot()
          const base = (st.draft || '').replace(/[\s\u00A0]+$/, '')
          const commentTail = c === '' ? '' : '\n\n' + c
          if (pipelineAvailable && typeof input.insertReference === 'function') {
            const ref = 'f' + (++refSeq)
            const label = '引用内容 #' + refSeq
            const cwd = (sessions.list && sessions.list.getSnapshot && sessions.list.getSnapshot().byId && sessions.list.getSnapshot().byId[item.sessionId] && sessions.list.getSnapshot().byId[item.sessionId].cwd) || null
            refTargets.set(ref, {
              sessionId: item.sessionId,
              cwd,
              relPath: item.relPath || null,
              anchorKey: item.anchorKey || null,
              text: item.text,
              body: quoteBodyClean,
              label,
              lineRange: lineRange || null,
            })
            // 评论并入 chip 的序列化正文：提交时 chip 展开为「引用块 + 评论」，
            // 不再在插入后调用 setDraft（那会用纯文本重写整份草稿，把 chip 抹掉）。
            refCodecs.set(ref, { body: quoteBody + commentTail, clipboardText: quoteBodyClean + commentTail })
            if (refCodecs.size > 200) {
              const oldest = refCodecs.keys().next().value
              refCodecs.delete(oldest)
              refTargets.delete(oldest)
            }
            // 插入位置取当前光标/选区（harness 的 caretSpan）。
            // 输入框此刻不持有光标时（用户在批注框里），caretSpan 读到的是上一次的残留选区：
            // 非折叠的残留选区会把整段草稿替换掉，所以只在光标真的在输入框里时才按选区替换，
            // 否则把它收成插入点。拿不到时退回草稿末尾——「任意位置插入、数量不限」由此生效。
            let span = { start: st.draft.length, end: st.draft.length, draftRev: st.draftRev }
            if (typeof input.caretSpan === 'function') {
              const cs = input.caretSpan() || {}
              const a = typeof cs.start === 'number' ? cs.start : st.draft.length
              const b = typeof cs.end === 'number' ? cs.end : a
              const lo = Math.min(a, b)
              const hi = Math.max(a, b)
              span = { start: lo, end: composerHoldsSelection() ? hi : lo, draftRev: st.draftRev }
            }
            const refInfo = { source: 'file-quote-ref', ref, label, clipboardText: quoteBodyClean + commentTail }
            let applied = typeof input.insertReference === 'function' ? input.insertReference(refInfo, span) === true : false
            // 兜底：走 input-trigger 官方的事件通道（它自己就是这么插 chip 的），
            // shell 没有该方法、或方法因 phase/rev 拒绝时再试一次。
            if (!applied && binding.ctx && typeof binding.ctx.bail === 'function') {
              try {
                applied = binding.ctx.bail(binding.ctx, 'slash/input-insert-reference', { reference: refInfo, span }) === true
              } catch (e) {
                console.warn('[file-quote] 事件通道插入引用失败', e)
              }
            }
            if (applied) {
              setStatus({ ok: true, text: '已插入引用 #' + refSeq + ' ✓' })
              editorStore.close()
              returnComposerCaret(input)
              return
            }
            refTargets.delete(ref)
            refCodecs.delete(ref)
            input.setDraft(base === '' ? quoteBody + commentTail : base + '\n\n' + quoteBody + commentTail)
            setStatus({ ok: false, text: '锚点插入未生效，已回退为纯文本引用' })
          } else {
            input.setDraft(base === '' ? quoteBody + commentTail : base + '\n\n' + quoteBody + commentTail)
            setStatus({ ok: false, text: '引用管线不可用，已插入纯文本引用' })
          }
          editorStore.close()
          returnComposerCaret(input)
        } catch (e) {
          setStatus({ ok: false, text: '插入失败：' + (e && e.message ? e.message : String(e)) })
          console.error('[file-quote] 插入失败', e)
        }
      }
      return mountPortal(React.createElement('div', {
        className: 'dsfq-editor',
        style: { left, top, width: w },
      },
        React.createElement('div', { className: 'dsfq-editor-label' }, state.item.label),
        React.createElement('div', { className: 'dsfq-editor-quote' }, state.item.text),
        React.createElement('div', { className: 'dsfq-editor-path' }, state.item.relPath
          ? '文件：' + state.item.relPath + (rangeText !== '' ? '（' + rangeText + '）' : '')
          : (state.item.anchorKey
            ? '会话消息引用'
            : (DIAGNOSE_IN_QUOTE && state.item.diag
              ? '未识别来源（诊断）：' + state.item.diag
              : '未识别到定位信息（该界面暂不支持引用定位）'))),
        React.createElement('input', {
          ref: inputRef,
          className: 'dsfq-editor-input',
          value: comment,
          placeholder: '输入评论…',
          onChange: (e) => setComment(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') insert()
            if (e.key === 'Escape') editorStore.close()
          },
        }),
        status && open ? React.createElement('div', { className: status.ok ? 'dsfq-editor-status dsfq-ok' : 'dsfq-editor-status dsfq-err' }, status.text) : null,
        React.createElement('div', { className: 'dsfq-editor-actions' },
          React.createElement('button', { type: 'button', className: 'dsfq-btn dsfq-primary', onClick: insert }, '插入输入框'),
          React.createElement('button', { type: 'button', className: 'dsfq-btn', onClick: () => editorStore.close() }, '✕'),
        ),
      ))
    }

    // ============ 组件四：文件定位浮层（点击文件引用 chip 后展示原文并高亮） ============
    const LocatorPanel = () => {
      const loc = useLocator()
      if (!loc.item) return null
      const item = loc.item
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const w = Math.min(680, Math.max(420, vw - 80))
      const h = Math.min(520, Math.max(280, vh - 160))
      const left = (vw - w) / 2
      const top = Math.max(16, (vh - h) / 2)
      const mask = React.createElement('div', {
        className: 'dsfq-locator-mask',
        style: { position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,.35)' },
        onClick: () => locatorStore.close(),
      })
      let body = null
      if (item.loading) {
        body = React.createElement('div', { className: 'dsfq-locator-status' }, '正在读取文件…')
      } else if (item.error) {
        body = React.createElement('div', { className: 'dsfq-locator-status dsfq-err' }, item.error)
      } else if (item.lines) {
        const start = Math.max(0, item.hitLine - 6)
        const end = Math.min(item.lines.length, item.hitLine + 8)
        const rows = []
        for (let i = start; i < end; i++) {
          const isHit = i === item.hitLine
          const lineText = item.lines[i]
          let content = lineText
          if (isHit) {
            const probe = (item.text || '').trim().split('\n')[0]
            const idx = lineText.indexOf(probe)
            if (idx !== -1) {
              content = React.createElement('span', null,
                lineText.slice(0, idx),
                React.createElement('mark', { className: 'dsfq-locator-mark' }, lineText.slice(idx, idx + probe.length)),
                lineText.slice(idx + probe.length),
              )
            }
          }
          rows.push(React.createElement('div', {
            key: i,
            className: isHit ? 'dsfq-locator-line dsfq-locator-hit' : 'dsfq-locator-line',
          },
            React.createElement('span', { className: 'dsfq-locator-lineno' }, String(i + 1).padStart(4, ' ')),
            React.createElement('code', { className: 'dsfq-locator-code' }, content),
          ))
        }
        body = React.createElement('div', { className: 'dsfq-locator-lines' }, rows)
      }
      return mountPortal(React.createElement(React.Fragment, null,
        mask,
        React.createElement('div', { className: 'dsfq-locator', style: { left, top, width: w, height: h } },
          React.createElement('div', { className: 'dsfq-locator-header' },
            React.createElement('span', { className: 'dsfq-locator-title' }, item.path),
            React.createElement('span', { className: 'dsfq-locator-hint' }, item.hitLine !== null && item.hitLine >= 0 ? '第 ' + (item.hitLine + 1) + ' 行' : ''),
            React.createElement('button', { type: 'button', className: 'dsfq-btn dsfq-close', onClick: () => locatorStore.close() }, '✕'),
          ),
          body,
        ),
      ))
    }

    // ============ 组件五：引用悬停提示 ============
    const QuoteTooltip = () => {
      const [, force] = React.useState(0)
      const tip = React.useRef({ visible: false, text: '', rect: null })
      React.useEffect(() => {
        const onOver = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest(CHIP_SELECTOR) : null
            if (!el) {
              tip.current.visible = false
              force((v) => v + 1)
              return
            }
            // 三种 chip 形态统一解析（含新版输入框 chip data-composer-chip）
            const found = quoteInfoFromChip(el)
            const text = found ? found.text : ''
            if (!text) {
              tip.current.visible = false
              force((v) => v + 1)
              return
            }
            const r = el.getBoundingClientRect()
            tip.current = { visible: true, text, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
            force((v) => v + 1)
          } catch (err) { /* ignore */ }
        }
        const onOut = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest(CHIP_SELECTOR) : null
            if (!el) return
            const next = e.relatedTarget
            if (next && next.closest && next.closest(CHIP_SELECTOR)) return
            tip.current.visible = false
            force((v) => v + 1)
          } catch (err) { /* ignore */ }
        }
        document.addEventListener('pointerover', onOver, true)
        document.addEventListener('pointerout', onOut, true)
        return () => {
          document.removeEventListener('pointerover', onOver, true)
          document.removeEventListener('pointerout', onOut, true)
        }
      }, [])
      if (!tip.current.visible || !tip.current.rect) return null
      const t = tip.current
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const w = Math.min(360, Math.max(180, Math.min(t.text.length, 60) * 11 + 48))
      // 估算提示框完整高度（标签 20px + 每行约 15px + 内边距），让提示框整体悬浮在引用块上方，绝不遮挡
      const estLines = Math.ceil(Math.min(t.text.length, 400) / 22)
      const estH = Math.min(200, 56 + estLines * 15)
      const center = t.rect.left + (t.rect.right - t.rect.left) / 2
      const left = Math.max(8, Math.min(center - w / 2, vw - w - 8))
      let top = t.rect.top - estH - 8
      if (top < 8) top = Math.min(vh - estH - 8, t.rect.bottom + 8)
      return mountPortal(React.createElement('div', { className: 'dsfq-tip', style: { left, top, width: w } },
        React.createElement('div', { className: 'dsfq-tip-label' }, '引用内容'),
        React.createElement('div', { className: 'dsfq-tip-quote' }, t.text),
      ))
    }

    // ============ 组件六：反馈 toast ============
    const FeedbackToast = () => {
      const t = useToast()
      if (!t.text || !t.pos) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const left = Math.max(12, Math.min(t.pos.left - 80, vw - 200))
      return mountPortal(React.createElement('div', {
        className: t.ok ? 'dsfq-toast dsfq-toast-ok' : 'dsfq-toast dsfq-toast-err',
        style: { left, top: t.pos.top + 18 },
      }, t.text))
    }

    // ============ 样式（主题令牌自适应明暗） ============
    const css = `
.dsfq-tail{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:2px}
.dsfq-toolbar{position:fixed;display:flex;align-items:center;gap:4px;min-width:10em;max-width:min(32em,calc(100vw - 24px));font-size:12px;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 14px rgba(0,0,0,.14);pointer-events:auto;box-sizing:border-box;z-index:2147483001}
.dsfq-toolbar-preview{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsfq-btn{appearance:none;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.4;padding:2px 8px;border-radius:6px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dsfq-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsfq-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.dsfq-primary:hover{background:var(--dsw-alias-brand-primary);color:#fff;opacity:.9}
.dsfq-bubble-cta{flex:none;padding:1px 8px;border-radius:999px}
.dsfq-close{flex:none;padding:1px 5px;opacity:.7}
.dsfq-editor{position:fixed;display:flex;flex-direction:column;gap:5px;box-sizing:border-box;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:auto;font-size:12px;z-index:2147483001}
.dsfq-editor-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsfq-editor-path{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}
.dsfq-editor-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}
.dsfq-editor-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 8px}
.dsfq-editor-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsfq-editor-status{font-size:11px;line-height:1.5}
.dsfq-editor-status.dsfq-ok{color:var(--dsw-alias-state-success-primary)}
.dsfq-editor-status.dsfq-err{color:var(--dsw-alias-state-error-primary)}
.dsfq-editor-actions{display:flex;justify-content:flex-end;gap:6px}
.dsfq-tip{position:fixed;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:none;z-index:2147483002;font-size:12px}
.dsfq-tip-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsfq-tip-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;font-size:11px}
.dsfq-toast{position:fixed;max-width:260px;padding:5px 9px;border-radius:8px;font-size:11px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none;z-index:2147483003}
.dsfq-toast-ok{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.dsfq-toast-err{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsfq-locator{position:fixed;display:flex;flex-direction:column;box-sizing:border-box;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 12px 40px rgba(0,0,0,.28);z-index:2147483001;font-size:12px;overflow:hidden}
.dsfq-locator-mask{position:fixed;inset:0;z-index:2147483000}
.dsfq-locator-header{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsfq-locator-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsfq-locator-hint{flex:none;font-size:11px;color:var(--dsw-alias-brand-primary)}
.dsfq-locator-status{padding:20px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsfq-locator-status.dsfq-err{color:var(--dsw-alias-state-error-primary)}
.dsfq-locator-lines{margin:0;padding:8px 0;overflow:auto;flex:1;font-family:var(--dsw-font-mono, ui-monospace, "SF Mono", Consolas, monospace);font-size:12px;line-height:1.6}
.dsfq-locator-line{display:flex;gap:10px;padding:0 12px;white-space:pre;min-width:max-content}
.dsfq-locator-hit{background:var(--dsw-alias-bg-layer-2)}
.dsfq-locator-lineno{flex:none;width:3.5em;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none}
.dsfq-locator-code{flex:1;color:var(--dsw-alias-label-primary)}
.dsfq-locator-mark{background:var(--dsw-alias-brand-primary);color:#fff;border-radius:3px;padding:0 2px}
.dsfq-flash{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:8px}
.dsfq-line-flash{background:var(--dsw-alias-interactive-bg-hover,rgba(99,160,255,.16))}
.dsfq-cm-flash{background:var(--dsw-alias-brand-primary);color:#fff!important;border-radius:2px}
.dsfq-text-flash{background:var(--dsw-alias-interactive-bg-hover,rgba(99,160,255,.28));border-radius:3px}
[data-occurrence],[data-composer-chip]{pointer-events:auto;cursor:pointer;position:relative;z-index:1}
.dsfq-sent-quote{display:inline-block;box-sizing:border-box;max-width:100%;vertical-align:baseline;margin:1px 0;padding:2px 10px 2px 8px;border-left:3px solid var(--dsw-alias-brand-primary);border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.dsfq-sent-quote::before{content:"❝ "}
`

    // ============ 插件主体 ============
    function apply(ctx) {
      rootCtx = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ctx.effect(() => insertStyleSheet(css), 'dsh-file-quote: styles')

      // 注册引用 source（提交时把占位符序列化为引用正文）。
      // inputTriggers 由另一个插件提供，激活顺序不保证：本插件在 slots
      // 就绪时就激活，此刻 inputTriggers 常常还没 ACTIVE，ctx.get 拿到 undefined，
      // 于是兜底成纯文本、输入框侧永远不会出现 chip。改为：先即时试一次，
      // 拿不到就交给 ctx.inject 等该服务就绪后再注册（cordis 的迟到依赖用法）。
      const inputTriggers = ctx.get('inputTriggers')
      if (inputTriggers !== undefined) {
        const disposeSource = registerQuoteSource(inputTriggers)
        if (disposeSource !== null) ctx.effect(() => disposeSource, 'dsh-file-quote: file-quote-ref source')
      } else {
        let piped = false
        ctx.inject(['inputTriggers'], (child) => {
          if (piped) return
          const svc = child.get('inputTriggers')
          const disposeSource = registerQuoteSource(svc)
          if (disposeSource === null) return
          piped = true
          child.effect(() => disposeSource, 'dsh-file-quote: file-quote-ref source')
        })
      }

      // 全局选区监听：编辑区（contenteditable）→ 文件引用；非编辑区 → 消息引用
      ctx.effect(() => {
        let raf = 0
        let hideTimer = null
        const cancelHide = () => {
          if (hideTimer) {
            clearTimeout(hideTimer)
            hideTimer = null
          }
        }
        const scheduleHide = () => {
          if (hideTimer) return
          hideTimer = setTimeout(() => {
            hideTimer = null
            selectionStore.hide()
          }, 150)
        }
        const compute = () => {
          raf = 0
          try {
            const sel = window.getSelection()
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
              scheduleHide()
              return
            }
            const text = (sel.toString() || '').trim()
            if (!text) {
              scheduleHide()
              return
            }
            const range = sel.getRangeAt(0)
            const node = range.commonAncestorContainer
            const host = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
            if (!host) {
              scheduleHide()
              return
            }
            // 聊天输入框自身（textarea/input/普通 contenteditable）：不响应；
            // 但 CodeMirror 编辑器的 contenteditable 是我们处理的（.cm-editor / .cm-content）
            if (host.closest('textarea, input')) {
              scheduleHide()
              return
            }
            if (host.closest('[contenteditable="true"]') && !host.closest('.cm-editor, .cm-content')) {
              scheduleHide()
              return
            }
            const rect = range.getBoundingClientRect()
            if (!rect || (rect.width === 0 && rect.height === 0)) {
              scheduleHide()
              return
            }
            const vh = typeof window !== 'undefined' ? window.innerHeight : 768
            if (rect.bottom < -8 || rect.top > vh + 8) {
              scheduleHide()
              return
            }
            cancelHide()
            if (Date.now() < toolbarSuppressUntil) {
              scheduleHide()
              return
            }
            // 定位信息三路识别：workbench [data-path] / better-sidebar /
            // 右侧文档预览窗格（最后一路是本版 harness 默认的「文件预览」界面）
            const anchorKey = anchorKeyFromHost(host)
            let relPath = relPathFromHost(host) || relPathFromBetterSidebar(host) || relPathFromDocumentPreview(host) || relPathFromEditorWindow(host)
            let lineRange = lineRangeOfSelection(host, range) || lineRangeFromDocumentPreview(range)
            let diag = ''
            if (!relPath && !anchorKey) {
              // better-sidebar 的 CM6 会自己接管选区（pointerup 已写入定位信息），而随后的
              // DOM selectionchange 可能既认不出界面也读不到 CM 选区 —— 同一段文本时保留旧结果，
              // 否则会把刚拿到的 relPath 覆盖成 null。
              const prevText = clipText(text, MAX_SELECTION)
              if (selectionStore.visible && selectionStore.text === prevText && (selectionStore.relPath || selectionStore.anchorKey)) {
                relPath = selectionStore.relPath
                lineRange = lineRange || selectionStore.lineRange
              } else {
                diag = describeSurface(host)
                if (diag !== lastUnrecognizedSurface) {
                  lastUnrecognizedSurface = diag
                  console.warn('[file-quote] 未识别到选区定位信息（该界面暂不支持文件/消息引用定位；如需适配请把这条日志发到插件仓库 issue）：', diag)
                }
              }
            }
            selectionStore.show({
              text: clipText(text, MAX_SELECTION),
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              relPath,
              anchorKey,
              lineRange,
              diag,
            })
          } catch (e) {
            scheduleHide()
          }
        }
        const schedule = () => {
          if (!raf) raf = requestAnimationFrame(compute)
        }
        const onScroll = () => {
          schedule()
        }
        const onKey = (e) => {
          if (e.key === 'Escape') {
            selectionStore.hide()
            editorStore.close()
            toastStore.hide()
          }
        }
        const onChipPress = (e) => {
          try {
            lastPointerPos = { left: e.clientX, top: e.clientY }
            const el = e.target && e.target.closest ? e.target.closest(CHIP_SELECTOR) : null
            if (!el) return
            const pos = lastPointerPos
            // 输入框内的 chip 由 harness 的官方 chip 激活回调（source.openReference）
            // 处理，这里让路，避免同一次点击被定位两次；回调不可用时才走 DOM 兜底。
            if (el.hasAttribute('data-composer-chip') && quoteSourceRegistered) return
            // 三种 chip 形态统一解析 + 统一定位路由
            // （输入框 chip 由 data-composer-chip 承载，旧版 data-occurrence 仍兼容）
            const found = quoteInfoFromChip(el)
            if (!found) {
              showToast('该引用没有定位信息', pos, false)
              return
            }
            locateQuoteTarget(found.info, pos)
          } catch (err) {
            showToast('定位出错：' + (err && err.message ? err.message : String(err)), { left: e.clientX, top: e.clientY }, false)
            console.error('[file-quote] 点击定位出错', err)
          }
        }
        document.addEventListener('selectionchange', schedule)
        document.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onChipPress, true)
        document.addEventListener('pointerup', betterSidebarSelectionFromPointer, true)
        return () => {
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onChipPress, true)
          document.removeEventListener('pointerup', betterSidebarSelectionFromPointer, true)
          if (raf) cancelAnimationFrame(raf)
          if (hideTimer) clearTimeout(hideTimer)
          if (toastTimer) clearTimeout(toastTimer)
        }
      }, 'dsh-file-quote: global listeners')

      // 已发送消息的引用收起：监听 DOM 变化（新消息挂载 / React 重渲染）后重新扫描
      ctx.effect(() => {
        let raf = 0
        const scan = () => {
          raf = 0
          collapseSentQuotes()
        }
        const schedule = () => {
          if (!raf) raf = requestAnimationFrame(scan)
        }
        const mo = new MutationObserver(schedule)
        mo.observe(document.body, { childList: true, subtree: true })
        schedule()
        return () => {
          if (raf) cancelAnimationFrame(raf)
          mo.disconnect()
        }
      }, 'dsh-file-quote: sent-quote collapse')

      // 回合尾部「引用提问 / 引用回答」
      slots.inject('conversation.chat.turnTail', () => slots.register(
        { name: 'conversation.chat.turnTail', select: selectTurnQuote, priority: 10 },
        TurnQuoteActions,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'file-quote-selection-toolbar', order: 200 },
        SelectionToolbar,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'file-quote-annotation-editor', order: 201 },
        AnnotationEditor,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'file-quote-locator', order: 202 },
        LocatorPanel,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'file-quote-tooltip', order: 203 },
        QuoteTooltip,
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'file-quote-toast', order: 204 },
        FeedbackToast,
      ))
    }

    exports.apply = apply
    // 声明 slots 依赖：cordis 会等 ui-renderer 的 SlotRegistry 服务 ACTIVE 之后再执行 apply。
    // 缺这一行时 apply 会在服务就绪前跑完并静默返回 —— 插件看起来「装上了但完全没反应」，
    // 这正是 v0.1.0 的实际故障。
    exports.inject = ['slots']
    return module.exports
  },
})
