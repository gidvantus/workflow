/**
 * Клиент машинного контракта пресетов: манифест и документ роли.
 *
 * Эти ручки закрыты общим токеном надстройки (`X-Registry-Token`), а не браузерной
 * сессией: `GET /api/presets` читает harness перед раскладкой, `GET /api/presets/{code}` —
 * документ роли, из которого он рендерит `SKILL.md` и `preset.yml`. Запись документа
 * (`PUT /api/presets/{code}`) браузеру недоступна намеренно: заливка пакета в веб — это
 * `plugins/tools/presets-import.mjs`, а не экран, поэтому клиента на `PUT` здесь нет.
 *
 * Токен берётся из окружения сборки (`VITE_REGISTRY_TOKEN`) и **по умолчанию пуст**: в
 * браузерной сборке его быть не должно, иначе любой, кто открыл страницу, мог бы
 * переписать пресеты. Пустой токен — это не ошибка клиента, а штатное состояние экрана:
 * запрос не отправляется, `registryToken()` возвращает `null`, и страница говорит, что
 * ревизию раскладки показывает статус отдела, а не веб. Если токен всё же задан стендом,
 * `401` показывается дословно, как и любой другой отказ.
 */

import { ApiError, UNREACHABLE_TEXT, isRecord, readDetail, readJson, send } from './http';
import type { SkillSection } from './roles';

const PRESETS_URL = '/api/presets';

/** Заголовок машинного доступа: то же имя, что у ручек `app/api/presets.py`. */
export const REGISTRY_TOKEN_HEADER = 'X-Registry-Token';

/** Строка манифеста: код и название роли, ревизия её документа и число живых скиллов. */
export type PresetRoleRef = {
  code: string;
  title: string;
  /** Первые 12 hex SHA-256 документа роли; правка любого скилла двигает ревизию. */
  revision: string;
  skill_count: number;
};

/** `GET /api/presets`: ревизия всего набора и строки живых ролей. */
export type PresetManifest = {
  revision: string;
  roles: PresetRoleRef[];
};

/** Скилл внутри документа роли: ровно то, из чего рендерится `SKILL.md`. */
export type PresetSkill = {
  code: string;
  title: string;
  description: string;
  sections: SkillSection[];
};

/** `GET /api/presets/{code}`: документ роли вместе с его ревизией. */
export type PresetDocument = {
  code: string;
  title: string;
  description: string;
  revision: string;
  skills: PresetSkill[];
};

/**
 * Токен надстройки из окружения сборки; `null` — токена нет.
 *
 * Пустая строка и отсутствующая переменная — одно и то же: у браузерной сборки токена нет,
 * и «пустой заголовок» сервер отверг бы тем же `401`, что и отсутствующий.
 */
export function registryToken(): string | null {
  const token: unknown = import.meta.env.VITE_REGISTRY_TOKEN;
  if (typeof token !== 'string' || token.trim() === '') {
    return null;
  }
  return token;
}

/** Манифест из ответа; `null` — ответ не по контракту. */
function readManifest(payload: unknown): PresetManifest | null {
  if (!isRecord(payload) || typeof payload.revision !== 'string') {
    return null;
  }
  const { roles } = payload;
  if (!Array.isArray(roles)) {
    return null;
  }
  const parsed: PresetRoleRef[] = [];
  for (const item of roles) {
    if (!isRecord(item)) {
      return null;
    }
    const { code, title, revision, skill_count: skillCount } = item;
    if (
      typeof code !== 'string' ||
      typeof title !== 'string' ||
      typeof revision !== 'string' ||
      typeof skillCount !== 'number'
    ) {
      return null;
    }
    parsed.push({ code, title, revision, skill_count: skillCount });
  }
  return { revision: payload.revision, roles: parsed };
}

/**
 * `GET /api/presets` — манифест набора. Без токена запрос не отправляется: `401` на этом
 * стенде был бы ожидаемым и ничего не сказал бы пользователю.
 */
export async function readPresetManifest(): Promise<PresetManifest> {
  const token = registryToken();
  if (token === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  const response = await send(PRESETS_URL, { method: 'GET' }, { [REGISTRY_TOKEN_HEADER]: token });
  if (!response.ok) {
    throw new ApiError(await readDetail(response));
  }
  const manifest = readManifest(await readJson(response));
  if (manifest === null) {
    throw new ApiError(UNREACHABLE_TEXT);
  }
  return manifest;
}
