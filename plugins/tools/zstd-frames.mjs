// Разбор стенограммы сессии: файл `session.v3.jsonl.zstd` — это конкатенация
// кадров zstd, а не один поток, поэтому распаковывать его надо покадрово.
//
// Приём один на все инструменты отдела: иначе правку разбора (например, «сообщать
// о битом кадре») приходится делать в нескольких местах, и одно из них забудут.
//
// Сбои разбора не проглатываются молча: `readTranscript` считает оба вида —
// кадр, который разобрался не целиком, и строку, которая не разобралась как JSON.
//
// Про оборванный последний кадр: `zlib.zstdDecompressSync` на неполном кадре не
// бросает, а отдаёт пустую строку или обрывок записи (проверено на кадре,
// обрезанном в трёх точках). Поэтому кадр считается сбоем, если его текст пуст
// или не кончается переводом строки: каждый полный кадр стенограммы DSH — это
// целое число строк JSONL, то есть текст, кончающийся `\n` (на живой стенограмме
// из 229 кадров это выполняется для всех). Текст обрывка всё равно идёт в разбор:
// целые строки из него посчитаются, а недописанная — попадёт в `droppedLines`.
// Что с этими числами делать, решает вызывающий: `tools/session-tail.mjs` и
// `tools/session-errors.mjs` печатают их человеку, `tools/issue-tokens.mjs` пишет
// замечание в отчёт, чтобы недосчёт не выглядел как полные цифры.
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
    let text
    try {
      text = zlib.zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
    } catch (error) {
      brokenFrames += 1
      return
    }
    // Пустой разбор или обрывок записи — признак недописанного кадра: zstd на нём
    // не падает, поэтому без этой проверки хвост стенограммы теряется молча.
    if (text === '' || !text.endsWith('\n')) brokenFrames += 1
    parts.push(text)
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
