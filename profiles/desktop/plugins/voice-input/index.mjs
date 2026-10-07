// Host-половина dsh-voice-input.
// Клиентская половина (client.js) пишет голос с микрофона и шлёт сюда webm;
// здесь он конвертируется ffmpeg → whisper и текст уходит обратно.
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const TOOLS = 'D:/Development/VideCoding/Brain/.voice-tools'
const FFMPEG = TOOLS + '/ffmpeg/ffmpeg.exe'
const WHISPER = TOOLS + '/whisper/Release/whisper-cli.exe'
const WHISPER_MODEL = TOOLS + '/models/ggml-small.bin'
const TMP = TOOLS + '/tmp'
const ROUTE = '/dsh-voice/transcribe'
const MAX_BYTES = 30 * 1024 * 1024

function toolsPresent() {
  return fs.existsSync(FFMPEG) && fs.existsSync(WHISPER) && fs.existsSync(WHISPER_MODEL)
}

// Внешние процессы — асинхронно, чтобы не морозить процесс DSH.
function runTool(exe, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { reject(e); return }
    const out = []
    const err = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch (e) { /* ignore */ }
      reject(new Error('превышено время (' + Math.round(timeoutMs / 1000) + ' с)'))
    }, timeoutMs)
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => { if (err.length < 60) err.push(c) })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stderr = Buffer.concat(err).toString('utf8')
      if (code !== 0) {
        reject(new Error('код ' + code + (stderr.trim() ? ': ' + stderr.trim().slice(-200) : '')))
        return
      }
      resolve(Buffer.concat(out).toString('utf8'))
    })
  })
}

// На тишине whisper дописывает «субтитры» и [BLANK_AUDIO] — выкидываем.
const HALLUCINATIONS = [
  'продолжение следует', 'субтитры', 'редактор субтитров', 'подписывайтесь',
  'спасибо за просмотр', 'ставьте лайк', 'thank you for watching', 'thanks for watching',
  'subscribe', 'subtitles', 'amara.org', 'dimatorzok',
]

function cleanTranscript(raw) {
  const keep = []
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (!t) continue
    if (/^[\s.,!?…\-–—]+$/.test(t)) continue
    const low = t.toLowerCase()
    if (HALLUCINATIONS.some((h) => low.indexOf(h) >= 0)) continue
    keep.push(t)
  }
  return keep.join(' ').trim()
}

async function transcribeFile(src, lang) {
  const dot = src.lastIndexOf('.')
  const wav = (dot > src.lastIndexOf('/') ? src.slice(0, dot) : src) + '.wav'
  try {
    await runTool(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], 120000)
    const out = await runTool(WHISPER, ['-m', WHISPER_MODEL, '-f', wav, '-l', lang || 'auto',
      '-nt', '-np'], 300000)
    return cleanTranscript(out)
  } finally {
    try { fs.unlinkSync(wav) } catch (e) { /* ignore */ }
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > limit) {
        done = true
        reject(new Error('слишком большой запрос'))
        try { req.destroy() } catch (e) { /* ignore */ }
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', (e) => { if (!done) { done = true; reject(e) } })
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch (e) { /* клиент мог отвалиться */ }
}

async function onRequest(req, res) {
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'только POST' }); return }
  let payload
  try {
    if (req.body && typeof req.body === 'object') payload = req.body
    else {
      const raw = await readBody(req, MAX_BYTES)
      payload = JSON.parse(raw.toString('utf8'))
    }
  } catch (e) {
    sendJson(res, 400, { ok: false, error: 'плохой запрос: ' + String((e && e.message) || e) })
    return
  }
  const b64 = String((payload && payload.audio) || '')
  if (!b64) { sendJson(res, 400, { ok: false, error: 'нет поля audio' }); return }
  if (!toolsPresent()) {
    sendJson(res, 500, { ok: false, error: 'ffmpeg/whisper/модель не найдены по ожидаемым путям' })
    return
  }
  let buf
  try { buf = Buffer.from(b64, 'base64') } catch (e) { buf = Buffer.alloc(0) }
  if (!buf || buf.length < 200) { sendJson(res, 400, { ok: false, error: 'пустое или слишком короткое аудио' }); return }
  const src = TMP + '/gui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.webm'
  try {
    fs.mkdirSync(TMP, { recursive: true })
    fs.writeFileSync(src, buf)
    const text = await transcribeFile(src, payload && payload.lang)
    if (!text) { sendJson(res, 200, { ok: false, error: 'речь не распознана (тишина или шум)' }); return }
    sendJson(res, 200, { ok: true, text })
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  } finally {
    try { fs.unlinkSync(src) } catch (e) { /* ignore */ }
  }
}

export default {
  inject: ['webServer'],
  apply(ctx) {
    const webServer = ctx.get('webServer')
    if (!webServer) {
      console.error('[voice-input] сервис webServer недоступен — микрофон в GUI выключен')
      return
    }
    ctx.effect(() => webServer.register({ kind: 'exact', path: ROUTE, handler: onRequest }))
    console.log('[voice-input] ручка распознавания готова: POST ' + ROUTE)
  },
}
