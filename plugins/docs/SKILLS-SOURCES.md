# Источники скиллов набора

Атрибуция и ссылки на upstream. Нужен, чтобы удаление врезок `> **Источник и адаптация.**` из
`SKILL.md` было переносом, а не потерей: лицензия и происхождение текста остаются в репозитории.

## Ponytail — MIT

Шесть скиллов набора взяты из репозитория **Ponytail**: <https://github.com/DietrichGebert/ponytail>,
лицензия MIT (см. `LICENSE` в upstream). Copyright принадлежит автору upstream; текст адаптирован под
этот harness, сама лицензия не менялась.

| Скилл в наборе | Upstream |
|---|---|
| `code-review/skills/ponytail` | <https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail> |
| `code-review/skills/ponytail-review` | <https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail-review> |
| `code-review/skills/ponytail-audit` | <https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail-audit> |
| `code-review/skills/ponytail-debt` | <https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail-debt> |
| `code-review/skills/ponytail-gain` | <https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail-gain> |
| `code-review/skills/ponytail-help` | <https://github.com/DietrichGebert/ponytail/tree/main/skills/ponytail-help> |

## Что изменено при адаптации

- **Загрузка.** В этом harness скилл грузится инструментом `skill` по имени скилла, а не слэш-командой
  и не плагином. Слэш-форм, `/plugin`, `/reload-plugins` и поля `argument-hint` в наборе нет.
- **Уровень.** Уровень (`lite` / `full` / `ultra`) задаётся словами человека в разговоре и не читается
  из конфига или переменной окружения upstream.
- **Имена разделов.** Разделы приведены к общей спине набора, русскими именами
  (`plugins/docs/SKILLS-CANON.md`); тело предметных разделов осталось на языке оригинала.
- **Атрибуция.** Врезка `> **Источник и адаптация.**` из шести файлов убрана, её содержание — эта
  страница.

## Остальные скиллы набора

Скиллы ролей (`analyst`, `code-review`, `design`, `dev-backend`, `dev-frontend`, `dev-fullstack`,
`devops-delivery`, `jev`, `security-review`, `tester`) — собственные тексты этого репозитория, не
заимствованные.

Текст `## Доказательства` собран из двух источников набора: `code-review` («Evidence rules») и
`ponytail-review` (§ «Check before you report»). Оба источника живут в этом же репозитории, поэтому
внешней атрибуции не требуют.
