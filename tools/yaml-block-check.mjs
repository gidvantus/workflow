// Грубая проверка YAML-файлов надстройки: блоки `|‑` (персона, варианты) не должны
// разрываться строкой с меньшим отступом. Полного парсера в системе нет
// (ни js-yaml, ни PyYAML), поэтому проверяем именно то, что можно сломать правкой.
//
//   node tools/yaml-block-check.mjs              что лежит в этом репозитории
//   node tools/yaml-block-check.mjs <файлы…>     ровно эти файлы (в том числе из
//                                                установки: ~/.dsh/profiles/…)
//
// Без аргументов проверяются: патч бандла (`cordis.patch.yml` из корня, а если
// его там нет — из установленного пакета), патчи профилей
// (`profiles/<имя>/cordis.patch.yml`) и композиции пресетов
// (`agent-presets/<роль>/*.yml`). Это и есть файлы, которые ломаются правкой;
// README и прочие каталоги в проверку не входят.
//
// Пустой список без аргументов — отказ (exit 1), а не успех: иначе «проверка
// чиста» означала бы «ничего не проверено», и сторож отключался бы молча, стоило
// раскладке переехать или проверке запуститься из урезанного дерева.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { bundlePatchFile } from './plugin-paths.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function subdirs(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function yamlFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort()
}

function defaultFiles() {
  const files = []
  const bundlePatch = bundlePatchFile({ repoRoot: repo })
  if (bundlePatch !== null) files.push(bundlePatch)
  for (const name of subdirs(path.join(repo, 'profiles'))) {
    files.push(...yamlFiles(path.join(repo, 'profiles', name)))
  }
  for (const role of subdirs(path.join(repo, 'agent-presets'))) {
    files.push(...yamlFiles(path.join(repo, 'agent-presets', role)))
  }
  return files
}

const shown = (file) => {
  const relative = path.relative(repo, file)
  return relative.startsWith('..') ? file : relative.split(path.sep).join('/')
}

const explicit = process.argv.slice(2)
const files = explicit.length > 0 ? explicit : defaultFiles()
if (files.length === 0) {
  // Пустой список бывает только в режиме без аргументов: переданные файлы уже
  // здесь. Проверять нечего — это провал проверки, а не её успех.
  console.log('нечего проверять: ни одного YAML-файла не нашлось — это отказ, а не успех')
  process.exit(1)
}
console.log('файлов на проверку: ' + files.length)

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
  if (problems.length === 0) console.log('ok    ' + shown(file))
  else {
    bad += 1
    console.log('ФЕЙЛ  ' + shown(file))
    for (const p of problems.slice(0, 5)) console.log('        ' + p)
  }
}
console.log(bad === 0 ? '\nразметка блоков в порядке' : '\nпроблемных файлов: ' + bad)
process.exit(bad === 0 ? 0 : 1)
