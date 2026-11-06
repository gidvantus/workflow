---
name: ponytail-help
description: >-
  Quick reference for ponytail levels, skills and commands. One-shot display.
  Use for "ponytail help", "how do I use ponytail", the `ponytail-help` skill.
---

# Ponytail Help

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

## Уровни

| Level | Trigger | What change |
|-------|---------|-------------|
| **Lite** | the human says "lite" | Build what was asked, name the smaller option in one line. |
| **Full** | "ponytail" | The smallest complete change, a check where the logic needs one, and a reply that names what was skipped and any risk. Default. |
| **Ultra** | "ultra" | Also questions the request and pushes back before building. |

Level sticks until changed or session end.

## Скиллы

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | "ponytail" | Lazy mode itself: least new code, clear replies that name skipped work and risks. |
| **ponytail-review** | "review this" | Quality review of a diff: bugs, security, load, missing tests, speed, what to cut. Each finding says what goes wrong and how to fix it. |
| **ponytail-audit** | "audit the repo" | The same quality review for the whole repo, ranked. |
| **ponytail-debt** | "ponytail debt" | Harvest `shortcut:` comments into a tracked ledger. |
| **ponytail-gain** | "ponytail gain" | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | "ponytail help" | This card. |

In this harness every skill is invoked through the `skill` tool by its exact
name, listed above. Upstream slash forms are just those names read as «load the skill `ponytail-review`».

## Как включить и выключить

Say "stop ponytail" or "normal mode". Resume anytime by saying "ponytail".

Default mode = `full`. In this harness the level is not read from the upstream
config file or environment variable: the human asks for a level in the
conversation and the agent applies it.

Full docs + examples: https://github.com/DietrichGebert/ponytail
