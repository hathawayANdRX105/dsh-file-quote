// dsh-file-quote — 构建脚本：把 src/ 的源码复制到 lib/（发布产物目录）。
// 零依赖：纯 Node.js 标准库，无需安装任何构建工具。
// `lib/` 已被 .gitignore 忽略，npm 安装 / 打包（prepare / prepack）时自动生成。
//
// MIT License — Copyright (c) 2026 Sunday2Mo
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

if (!exists(srcDir)) {
  console.error(`[dsh-file-quote] build: 未找到源码目录 ${srcDir}`)
  process.exit(1)
}

rmSync(libDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })

let copied = 0
for (const entry of readdirSync(srcDir)) {
  const source = join(srcDir, entry)
  if (!statSync(source).isFile() || !entry.endsWith('.js')) continue
  cpSync(source, join(libDir, entry))
  copied++
}

if (copied === 0) {
  console.error('[dsh-file-quote] build: src/ 中没有 .js 文件，构建中止')
  process.exit(1)
}

console.log(`[dsh-file-quote] build: 已从 src/ 复制 ${copied} 个文件到 lib/`)

function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
