// Разбор стенограммы сессии: файл `session.v3.jsonl.zstd` — это конкатенация
// кадров zstd, а не один поток, поэтому распаковывать его надо покадрово.
//
// Приём один на все инструменты отдела: иначе правку разбора (например, «сообщать
// о битом кадре») приходится делать в нескольких местах, и одно из них забудут.
//
// Сбои разбора не проглатываются молча: `readTranscript` считает оба вида —
// кадр, который не распаковался, и строку, которая не разобралась как JSON
// (оборванный последний кадр даёт именно недописанную строку: zstd отдаёт из
// него частичный текст и не падает). Что с этими числами делать, решает
// вызывающий: `tools/session-tail.mjs` печатает их человеку, `tools/issue-tokens.mjs`
// пишет замечание в отчёт, чтобы недосчёт не выглядел как полные цифры.
import fs from 'node:fs'
import zlib from 'node:zlib'

// Магическое число кадра zstd (little-endian 0xFD2FB528).
const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const isFrameStart = (bytes, index) =>
  bytes[index] === FRAME_MAGIC[0] && bytes[index + 1] === FRAME_MAGIC[1] &&
  bytes[index + 2] === FRAME_MAGIC[2] && bytes[index + 3] === FRAME_MAGIC[3]

// Все кадры подряд → один текст. { text, brokenFrames }.
export function unzstdFrames(bytes) {
  const parts = []
  let brokenFrames = 0
  let start = -1
  const flush = (end) => {
    try {
      parts.push(zlib.zstdDecompressSync(bytes.subarray(start, end)).toString('utf8'))
    } catch (error) {
      brokenFrames += 1
    }
  }
  for (let i = 0; i + 4 <= bytes.length; i += 1) {
    if (!isFrameStart(bytes, i)) continue
    if (start >= 0) flush(i)
    start = i
  }
  if (start >= 0) flush(bytes.length)
  return { text: parts.join('\n'), brokenFrames }
}

// Стенограмма целиком: события сессии и счётчики сбоев разбора.
export function readTranscript(file) {
  const { text, brokenFrames } = unzstdFrames(fs.readFileSync(file))
  const rows = []
  let droppedLines = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      droppedLines += 1
    }
  }
  return { rows, brokenFrames, droppedLines }
}
