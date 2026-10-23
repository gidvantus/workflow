// Шаг 7: многоботовый мост + токен в проекте + сводки боту проекта.
//
//   node 15-deploy-multibot.mjs --dry-run
//   node 15-deploy-multibot.mjs
//
//   1) ставит переработанный tg-bridge (по одному боту на проект);
//   2) переносит текущего бота в проект vahta (projects.json → telegram);
//      ~/.dsh/telegram.json остаётся общим ботом для остальных проектов;
//   3) учит диспетчер отдела слать сводку боту СВОЕГО проекта.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PLUGINS = path.join(HOME, 'profiles', 'desktop', 'plugins')
const MIGRATION = path.join('D:', 'Development', 'VideCoding', 'Brain', '.dsh-migration')
const DRY = process.argv.includes('--dry-run')
const BACKUP_SUFFIX = '.bak-multibot'

function backup(file) {
  const target = file + BACKUP_SUFFIX
  if (!DRY && fs.existsSync(file) && !fs.existsSync(target)) fs.copyFileSync(file, target)
}

function replaceOnce(text, from, to, label) {
  const parts = text.split(from)
  if (parts.length !== 2) throw new Error('для «' + label + '» ожидался ровно 1 фрагмент, найдено ' + (parts.length - 1))
  console.log('  ' + label)
  return parts.join(to)
}

// ── 1. Мост ────────────────────────────────────────────────────────────────

{
  const source = fs.readFileSync(path.join(MIGRATION, '13-tg-bridge-multibot.mjs.out'), 'utf8')
  if (!source.includes('function buildBridge(ctx, bot)')) throw new Error('исходник не похож на многоботовый мост')
  if (/8890938415|TELEGRAM_FALLBACK/.test(source)) throw new Error('в исходнике остался зашитый секрет')
  const target = path.join(PLUGINS, 'tg-bridge.mjs')
  backup(target)
  if (!DRY) fs.writeFileSync(target, source, 'utf8')
  console.log('[ok]  мост → ' + target)
}

// ── 2. Токен проекта vahta ─────────────────────────────────────────────────

{
  const projectsFile = path.join(HOME, 'projects.json')
  const registry = JSON.parse(fs.readFileSync(projectsFile, 'utf8'))
  const vahta = registry.projects && registry.projects.vahta
  if (!vahta) throw new Error('в реестре нет проекта vahta')

  let shared
  try {
    shared = JSON.parse(fs.readFileSync(path.join(HOME, 'telegram.json'), 'utf8'))
  } catch (error) {
    shared = undefined
  }

  if (vahta.telegram) {
    console.log('[skip] у vahta уже задан свой бот')
  } else if (shared && shared.token && shared.chatId) {
    vahta.telegram = { token: String(shared.token), chatId: shared.chatId }
    if (shared.voiceLang) vahta.telegram.voiceLang = String(shared.voiceLang)
    backup(projectsFile)
    if (!DRY) fs.writeFileSync(projectsFile, JSON.stringify(registry, null, 2) + '\n', 'utf8')
    console.log('[ok]  бот перенесён в проект vahta (chatId ' + shared.chatId + ')')
  } else {
    console.log('[warn] telegram.json не читается — проект vahta останется на общем боте')
  }
}

// ── 3. Диспетчер: сводка боту проекта ──────────────────────────────────────

for (const file of [path.join(PLUGINS, 'dev-department.mjs'), path.join(MIGRATION, '08-dev-department-v2.mjs')]) {
  if (!fs.existsSync(file)) continue
  let text = fs.readFileSync(file, 'utf8')

  if (text.includes('telegram: raw.telegram')) {
    console.log('[skip] ' + path.basename(file) + ': уже правился')
    continue
  }

  // 3a. У проекта появляется его бот.
  text = replaceOnce(text,
    '    labels: Object.assign({}, PIPELINE_LABELS, raw.labels || {}),',
    [
      '    telegram: raw.telegram && typeof raw.telegram === \'object\' && raw.telegram.token && raw.telegram.chatId',
      '      ? { token: String(raw.telegram.token), chatId: raw.telegram.chatId }',
      '      : undefined,',
      '    labels: Object.assign({}, PIPELINE_LABELS, raw.labels || {}),',
    ].join('\n'),
    'поле telegram в projectRow')

  // 3b. Отправка принимает бота.
  text = replaceOnce(text,
    'async function sendTelegram(text) {',
    'async function sendTelegram(bot, text) {',
    'sendTelegram(bot, text)')
  text = replaceOnce(text,
    '  const { token, chatId } = readTelegramConfig()',
    '  const { token, chatId } = bot',
    'токен из переданного бота')

  // 3c. Сводка уходит боту своего проекта.
  text = replaceOnce(text,
    '        await sendTelegram(summaryText)',
    [
      '        // Сводка проекта уходит боту ЭТОГО проекта; общий — запасной путь.',
      '        const bot = project.telegram || readTelegramConfig()',
      '        await sendTelegram(bot, summaryText)',
    ].join('\n'),
    'сводка боту проекта')

  backup(file)
  if (!DRY) fs.writeFileSync(file, text, 'utf8')
  console.log('[ok]  ' + file)
}

console.log(DRY ? '=== DRY RUN ===' : '=== ГОТОВО ===')
