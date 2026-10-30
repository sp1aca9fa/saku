# Languages

An install runs in any two languages, neither has to be English (requirements
`docs/requirements/08-ux-language.md`). Every user-facing text lives in `packages/content/messages/`,
never in code, including in plug-ins.

- `en.json` is the base and holds every text. Other files (`ja.json` today) may be partial: a
  missing text falls back to English.
- Languages are found from the files in that folder, so installed languages are the files there.
- Texts use ICU placeholders (`{name}`), so the files work unchanged with the web app's i18n
  (next-intl) when it arrives.
- Set the default for users who chose none: `pnpm settings set primary_language <code>`.
  Alerts and `pnpm health --lang <code>` use the language given or the user's.

## Add a language

1. Copy `packages/content/messages/en.json` to `packages/content/messages/<code>.json` (a
   language code such as `pt`). Keep the keys; translate the values and keep the placeholders.
   You may leave texts out and add them later.
2. Use natural financial terms of the language, not word-for-word translations. Regime-specific
   terms belong to the tax regime plug-in's own files.
3. Run `pnpm test` (the content tests load every file).
4. Set it with `pnpm settings set primary_language <code>`.

## Coverage

From the web app (stage D1), CI fails when a language the owner's install uses (English and
Japanese) lacks a text, and `pnpm languages` lists what each language lacks. Neither exists yet.
Other installs run the same check for their own languages. A feature is done only when its texts
exist in `en.json` and the install's languages.
