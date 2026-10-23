// Грубая проверка YAML-файлов пресетов: блоки `|‑` (персона, варианты) не должны
// разрываться строкой с меньшим отступом. Полного парсера в системе нет
// (ни js-yaml, ни PyYAML), поэтому проверяем именно то, что можно сломать правкой.
import fs from 'node:fs'

const files = process.argv.slice(2)
let bad = 0
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const indentOf = (line) => line.length - line.trimStart().length
  const problems = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const block = /^(\s*)[\w.]+:\s*[|>][-+]?\s*$/.exec(line)
    if (!block) continue
    const base = block[1].length
    let contentIndent = null
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j]
      if (inner.trim() === '') continue
      const ind = indentOf(inner)
      if (ind <= base) break            // блок закончился
      if (contentIndent === null) contentIndent = ind
      if (ind < contentIndent) {
        problems.push('строка ' + (j + 1) + ': отступ ' + ind + ' меньше ' + contentIndent)
      }
    }
  }
  const tabs = lines.some((l) => l.includes('\t'))
  if (tabs) problems.push('в файле есть табуляция')
  const name = file.split('\\').slice(-2).join('/')
  if (problems.length === 0) console.log('ok    ' + name)
  else {
    bad += 1
    console.log('ФЕЙЛ  ' + name)
    for (const p of problems.slice(0, 5)) console.log('        ' + p)
  }
}
console.log(bad === 0 ? '\nразметка блоков в порядке' : '\nпроблемных файлов: ' + bad)
process.exit(bad === 0 ? 0 : 1)
