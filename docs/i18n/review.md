# Translation review

Status of every language, and what a native speaker and the CA reviewer still have to sign off. Nothing here has been reviewed by a person yet: every non-English string was drafted, and the app does not claim otherwise.

How to read the table: **screens** is the share of the English catalogue (`ui`, `errors`, `help`) that has a translation in the language file; the rest shows in English and has a draft waiting in `packages/i18n/locales-todo/<lang>.json`. **Print** is the printed-document catalogue (`packages/i18n/src/print.ts`), complete in all six. Run `pnpm i18n:check` for the live numbers.

| Language     | Screens translated | Print labels    | Reminder text | Glossary | Native-speaker review | CA review |
| ------------ | ------------------ | --------------- | ------------- | -------- | --------------------- | --------- |
| हिन्दी (hi)  | 100% (draft)       | complete, draft | draft         | draft    | pending               | pending   |
| मराठी (mr)   | about 6%           | complete, draft | draft         | draft    | pending               | pending   |
| தமிழ் (ta)   | about 6%           | complete, draft | draft         | draft    | pending               | pending   |
| বাংলা (bn)   | about 6%           | complete, draft | draft         | draft    | pending               | pending   |
| ગુજરાતી (gu) | about 6%           | complete, draft | draft         | draft    | pending               | pending   |

## Checklist for each language

A reviewer works through this and records the date and name in the table above.

1. **Glossary** (`packages/i18n/src/glossary.ts`): every term reads right to an accountant, in particular invoice, taxable value, CGST, SGST, IGST, cess, place of supply, reverse charge, HSN, e-way bill, credit note, debit note, outstanding, overdue, input tax credit. The CA reviewer signs the GST terms; the native speaker signs the rest.
2. **Printed document**: print a tax invoice, a bill of supply and a receipt with the language set on the template. Every label fits its box, reads naturally and uses the glossary's words (Settings, Print).
3. **Screens**: open Dashboard, Sell, Parties, Items, Documents, Payments, Reports, Inbox and Settings in the language. Anything still in English is listed in `locales-todo` and needs a translation.
4. **Reminder message**: read the drafted payment reminder aloud (`packages/i18n/src/reminder.ts`). It must be polite and clear to a customer.
5. **Layout**: at 1366 by 768 in compact density nothing is cut off or overlaps. Tamil and Bengali are the longest.
6. **Typing**: type five names you know through the transliteration field; the first suggestion should be the likeliest spelling, and the right one should be among the first four.

## Doing the translation

1. `pnpm i18n:check` lists what is missing; `pnpm i18n:draft` writes a draft for every missing string to `packages/i18n/locales-todo/<lang>.json` (English with the glossary's terms already swapped in).
2. A translator adds the real string to `packages/i18n/src/locales/<lang>.ts` in the same place as in `en.ts`. Keep every `{{placeholder}}` and the plural forms (`_one`, `_other`).
3. `pnpm i18n:draft` again drops it from the todo list; `pnpm i18n:check` must pass.
