// Шаг 28: номер доработки виден в самом тикете, а не только в памяти отдела.
//
//   node 28-rework-round-comments.mjs --dry-run   # только проверка якорей
//   node 28-rework-round-comments.mjs
//
// Что лечится: счётчик доработок (maxRework) живёт в памяти диспетчера, и по
// комментариям в issue нельзя понять, который это возврат из ревью или теста.
// После правки:
//   1) диспетчер пишет в issue короткий комментарий «доработка №2 из 3» в момент
//      выдачи возврата (источник — метка test-failed/ready-for-dev);
//   2) исполнитель в промте видит номер круга и лимит;
//   3) ревьюер и тестировщик в промте видят счётчик и номер, которым станет их
//      возврат, — и обязаны указать его в своём комментарии; на последнем круге
//      им прямо сказано, что возврат снимет тикет с конвейера;
//   4) комментарий автоснятия по лимиту называет номер возврата и лимит, а не
//      безликое «возвращался 3 раз(а)».

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// DD_FILE — прогон на копии: правка пишется в указанный файл, бэкап в ~/.dsh не
// делается. Так результат можно проверить node --check до живой установки.
const TEST_TARGET = process.env.DD_FILE || null
const FILE = TEST_TARGET || path.join(HOME, 'profiles', 'desktop', 'plugins', 'dev-department.mjs')
const DRY = process.argv.includes('--dry-run')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)

let edits = 0

function replaceOnce(text, from, to, label) {
  const parts = text.split(from)
  if (parts.length !== 2) {
    throw new Error('«' + label + '»: ожидался ровно 1 фрагмент, найдено ' + (parts.length - 1))
  }
  edits += 1
  console.log('  ok: ' + label)
  return parts[0] + to + parts[1]
}

let text = fs.readFileSync(FILE, 'utf8')
if (text.includes('доработка №')) {
  console.log('[skip] ' + FILE + ': уже правился')
  process.exit(0)
}

// ── 1. Комментарий о номере доработки при выдаче возврата ────────────────────
text = replaceOnce(text,
  "        if (kind === 'rework') st.rework[issue.number] = rounds + 1",
  [
    "        if (kind === 'rework') st.rework[issue.number] = rounds + 1",
    '        // Счётчик доработок живёт в памяти диспетчера и в тикете нигде не',
    '        // виден. Пишем номер круга в issue: по комментариям должно быть',
    '        // понятно, который это возврат из ревью или теста.',
    "        if (kind === 'rework') {",
    '          try {',
    "            await github('POST', '/repos/' + project.repo + '/issues/' + issue.number + '/comments', {",
    "              body: 'Отдел разработки: доработка №' + (rounds + 1) + ' из ' + project.department.maxRework +",
    "                ' (возврат ' + (has(issue, L.failed) ? 'из теста' : 'из код-ревью') + ').',",
    '            })',
    '          } catch (error) {',
    "            state.lastError = 'комментарий о номере доработки: ' + (error && error.message ? error.message : String(error))",
    '          }',
    '        }',
  ].join('\n'),
  'комментарий о номере доработки')

// ── 2. Текст автоснятия по лимиту: номер возврата и лимит ────────────────────
text = replaceOnce(text,
  "            body: 'Отдел разработки: тикет возвращался из код-ревью или теста ' + rounds + ' раз(а) и снят с конвейера — нужен человек.',",
  [
    "            body: 'Отдел разработки: лимит доработок исчерпан — этот возврат был бы №' + (rounds + 1) +",
    "              ' при лимите ' + project.department.maxRework + '. Тикет снят с конвейера, нужен человек:' +",
    "              ' поставь ' + L.dev + ', и счётчики вместе с диалогами обнулятся.',",
  ].join('\n'),
  'текст автоснятия по лимиту доработок')

// ── 3. Исполнитель видит номер своего круга ──────────────────────────────────
text = replaceOnce(text,
  "      if (kind === 'rework') lines.splice(2, 0, 'Начни с комментариев в issue и в PR этого тикета: там причина отказа, замечания и воспроизводящая команда.')",
  [
    "      if (kind === 'rework') lines.splice(2, 0, 'Начни с комментариев в issue и в PR этого тикета: там причина отказа, замечания и воспроизводящая команда.')",
    "      if (kind === 'rework') lines.splice(2, 0, 'Это доработка №' + (projectState(project.id).rework[issue.number] || 0) + ' из ' + project.department.maxRework + ': её номер записан комментарием диспетчера в issue.')",
  ].join('\n'),
  'номер доработки в промте исполнителя')

// ── 4. Общий текст счётчика для ревьюера и тестировщика ──────────────────────
text = replaceOnce(text,
  '    // Код-ревьюер: читает PR и код вокруг него, замечания пишет в PR, а решение',
  [
    '    // Номер следующего возврата. Счётчик доработок растёт на шаге выдачи, поэтому',
    '    // ревьюер и тестировщик видят его до возврата — и пишут номер в свой',
    '    // комментарий. Иначе по истории тикета не понять, который это круг.',
    '    function reworkCounterLine(project, issue) {',
    '      const rounds = projectState(project.id).rework[issue.number] || 0',
    '      const limit = project.department.maxRework',
    '      const next = rounds + 1',
    "      return 'Счётчик доработок по тикету: ' + rounds + ' из ' + limit + '. ' +",
    '        (next > limit',
    "          ? 'Если вернёшь — это будет возврат №' + next + ' при лимите ' + limit + ': диспетчер снимет тикет с конвейера и позовёт человека, поэтому в комментарии перечисли все правки сразу.'",
    "          : 'Если вернёшь — это будет возврат №' + next + ': укажи номер в комментарии в issue и что именно вернул.')",
    '    }',
    '',
    '    // Код-ревьюер: читает PR и код вокруг него, замечания пишет в PR, а решение',
  ].join('\n'),
  'функция reworkCounterLine')

// ── 5. Ревьюер видит счётчик ─────────────────────────────────────────────────
text = replaceOnce(text,
  "      if (repeat) lines.splice(2, 0, 'Это тот же диалог, где ты уже ревьюил этот тикет: твои прошлые замечания и правки разработчика в его истории — проверь в первую очередь то, что тогда вернул.')",
  [
    "      if (repeat) lines.splice(2, 0, 'Это тот же диалог, где ты уже ревьюил этот тикет: твои прошлые замечания и правки разработчика в его истории — проверь в первую очередь то, что тогда вернул.')",
    '      lines.push(reworkCounterLine(project, issue))',
  ].join('\n'),
  'счётчик в промте код-ревьюера')

// ── 6. Тестировщик видит счётчик ─────────────────────────────────────────────
text = replaceOnce(text,
  [
    '      if (repeat) {',
    "        lines.splice(2, 0, 'Это тот же диалог, где ты уже проверял этот тикет: тикет возвращался в доработку. Сверься со своим прошлым вердиктом в комментариях и проверь в первую очередь то, что тогда сломалось.')",
    "        lines.push('Если прошлый дефект исправлен и новых нет — метка ' + L.ok + '.')",
    '      }',
  ].join('\n'),
  [
    '      if (repeat) {',
    "        lines.splice(2, 0, 'Это тот же диалог, где ты уже проверял этот тикет: тикет возвращался в доработку. Сверься со своим прошлым вердиктом в комментариях и проверь в первую очередь то, что тогда сломалось.')",
    "        lines.push('Если прошлый дефект исправлен и новых нет — метка ' + L.ok + '.')",
    '      }',
    '      lines.push(reworkCounterLine(project, issue))',
  ].join('\n'),
  'счётчик в промте тестировщика')

// ── запись ───────────────────────────────────────────────────────────────────
if (DRY) {
  console.log('[dry-run] правок: ' + edits + ', файл не изменён: ' + FILE)
  process.exit(0)
}

const bakDir = path.join(HOME, 'bak', 'role-backups', STAMP, 'plugins')
if (TEST_TARGET) {
  fs.writeFileSync(FILE, text, 'utf8')
  console.log('[test] правок: ' + edits + '; записано в ' + FILE + ' (без бэкапа)')
  process.exit(0)
}
fs.mkdirSync(bakDir, { recursive: true })
for (const target of [path.join(bakDir, 'dev-department.mjs'), FILE + '.bak-rework-rounds']) {
  if (!fs.existsSync(target)) fs.copyFileSync(FILE, target)
}
fs.writeFileSync(FILE, text, 'utf8')
console.log('[ok] правок: ' + edits + '; бэкап: ' + bakDir)
