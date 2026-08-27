// dsh-file-quote — Host 半区
// 提供安全的文件读取端点：/dsh-file-quote/read?cwd=<workspace>&path=<workspace-relative>，
// 用于点击「引用#N」chip 时定位文件原文。路径被 jail 到会话工作区根，防目录穿越。
//
// MIT License — Copyright (c) 2026 Sunday2Mo
// See LICENSE and NOTICE for third-party attribution (dsh-quote-annotate).
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep, normalize } from 'node:path'

export const name = 'dsh-file-quote'

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2MB 上限
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.pdf', '.zip', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib'])

function queryOf(url) {
	const out = {}
	for (const [k, v] of url.searchParams) out[k] = v
	return out
}

function looksBinary(buffer, path) {
	if (BINARY_EXT.has(extname(path).toLowerCase())) return true
	return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)
}

/** Jail a user path to the workspace root. Empty / `.` means the root itself. */
function assertSafeWorkspacePath(root, filePath) {
	const trimmed = String(filePath ?? '').trim()
	if (trimmed.startsWith('-')) throw new Error('INVALID_PATH')
	const resolved = resolve(root, trimmed === '' || trimmed === '.' ? '' : trimmed)
	const rel = relative(root, resolved)
	if (rel.startsWith('..') || normalize(rel).split(sep).includes('..')) throw new Error('INVALID_PATH')
	return rel.split('\\').join('/')
}

async function resolveInside(root, rel) {
	const full = rel === '' ? root : join(root, rel)
	let real
	try {
		real = await realpath(full)
	} catch (error) {
		throw new Error('FS_NOT_FOUND')
	}
	if (relative(root, real).startsWith('..')) throw new Error('INVALID_PATH')
	return real
}

function send(res, status, payload) {
	res.statusCode = status
	res.setHeader('Content-Type', 'application/json; charset=utf-8')
	res.end(JSON.stringify(payload))
}

export function apply(ctx) {
	const server = ctx.webServer
	if (server === undefined) return

	const dispose = server.register({
		kind: 'prefix',
		path: '/dsh-file-quote',
		handler: async (req, res) => {
			const host = req.headers.host ?? '127.0.0.1'
			const url = new URL(req.url ?? '/', `http://${host}`)
			const method = (req.method ?? 'GET').toUpperCase()
			if (method === 'OPTIONS') {
				res.statusCode = 204
				res.end()
				return
			}
			try {
				if (method === 'GET' && url.pathname.replace(/\/+$/, '') === '/dsh-file-quote/read') {
					// 从会话工作区（cwd）解析：path 为相对路径
					const cwd = queryOf(url).cwd
					const filePath = queryOf(url).path
					if (!cwd || !filePath) {
						send(res, 400, { ok: false, error: 'BAD_REQUEST', hint: '需要 cwd 与 path 参数' })
						return
					}
					const root = isAbsolute(cwd) ? resolve(cwd) : null
					if (!root) {
						send(res, 400, { ok: false, error: 'INVALID_CWD', hint: 'cwd 必须是绝对路径' })
						return
					}
					const rel = assertSafeWorkspacePath(root, filePath)
					const abs = await resolveInside(root, rel)
					const info = await stat(abs).catch(() => null)
					if (!info || !info.isFile()) {
						send(res, 404, { ok: false, error: 'FS_NOT_FOUND' })
						return
					}
					if (info.size > MAX_READ_BYTES) {
						send(res, 413, { ok: false, error: 'TOO_LARGE', hint: `文件超过 ${MAX_READ_BYTES} 字节，仅支持小文件定位` })
						return
					}
					const buffer = await readFile(abs)
					if (looksBinary(buffer, abs)) {
						send(res, 415, { ok: false, error: 'BINARY', hint: '二进制文件不支持文本定位' })
						return
					}
					const text = buffer.toString('utf8')
					send(res, 200, { ok: true, path: abs, rel, text })
					return
				}
				send(res, 404, { ok: false, error: 'NOT_FOUND' })
			} catch (error) {
				const code = error && error.message ? error.message : 'INTERNAL'
				send(res, code === 'INVALID_PATH' || code === 'FS_NOT_FOUND' ? 400 : 500, { ok: false, error: code })
			}
		},
	})
	ctx.effect(() => dispose, 'dsh-file-quote: http route')
}

export const inject = ['webServer']
