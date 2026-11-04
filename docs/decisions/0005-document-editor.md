# 0005 — The document editor

Status: accepted. Context: prompt 14, PRD FR-030 to FR-040, UX-04.

## Decision

- **One editor for all ten document types.** `DraftDocument` (BigInt money) goes through `buildDocument`, which calls the engine's `computeDocument` and returns the supply, totals, per-line results and the trace. The grid, the footer, the preview and the trace panel all read that one `BuiltDocument`; nothing in the UI recomputes a number. A property test checks that the rows saved add up to the totals for any draft.
- **Glide Data Grid for the lines.** It draws on a canvas, so 200 lines cost the same as 20. Three things the library does not do well here, and what we did instead:
  - The _item_ column is pick-only. Enter (or a letter) opens our own picker (`item-picker.tsx`); Glide's own overlay editor raced with Enter and with focus. The picker is opened by a capture-phase window key handler because Glide may take canvas focus after Enter.
  - _Quantity_ is typed in the picker (Tab from the search box). Glide starts a text edit on the first typed character asynchronously, so a fast "5, Enter" lost the digit. Quantity stays editable in the grid afterwards.
  - Cells activate on double click, and Ctrl+S / Ctrl+Enter are captured on the window, because the canvas swallows them.
- **Keystroke handling stays under 16 ms with 200 lines** because pricing runs once per change on money-only fields (`built` is memoised on those), the grid and the preview sheet are `memo`'d with data-only comparators, and handlers are read through a ref. Before that, median 12 ms, p95 25 ms.
- **The repository's validation hook never rejects an editor save.** `consistencyValidator` checks integrity (rows add up, no negative money, tax matches the stored rate within basis-point rounding) instead of re-deriving the engine's answer. Drafts may be incomplete; only issuing runs `validateForIssue`.
- **Numbering is per document type and financial year, and skips numbers already in use.** A back-dated invoice joins its own year's series, and a number that history already used is never handed out twice. Full numbering rules (prefix, reset, gaps, cancellation) are prompt 15.
- **Reverse-charge purchases create a separate `rcm_self_invoice` document** on issue, as the law requires, posted to the ledger with the tax payable and the input credit. Composition-scheme businesses get a bill of supply and no tax columns.
- **The trace lives in the shell's right panel** in Books (UX-04 asks for it beside the grid) and in a sheet in Shop. Shop uses a simplified editor with no payment field until prompt 16.
- **Drafts autosave every 2 s**, serialised so two saves never overlap, and save by diff. An unchanged draft is detected order-independently (Postgres reorders JSON keys). Recovery offers the last draft on opening the editor.
- **Preview follows the form 150 ms after the last change** (`useDebounced`), as A4 or thermal, zoomable; it is plain until the template designer (prompt 17). Rich text (notes, terms) is contentEditable and passes through one allowlist sanitiser, `sanitiseRichText`, on the way in and on the way out.
- **Attachments** are checked by magic bytes, not by file name (`files.ts`).

## Consequences

- The tax rate is held in whole basis points, so a 0.25% rate (rough diamonds) cannot be typed in the grid yet (backlog B-014).
- Quantity entry has a two-step feel on first use (Tab to the quantity); a mouse user can still type in the grid cell.
- A new document type means a row in `CONVERSIONS`, `stockEffect` and `POSTS_TO_LEDGER` and a `docs.types.*` string; the editor itself does not change.
- New columns on `document_lines` (`gst_rate_bp`, `price_includes_tax`, `taxability`, `note`) and a new `per_unit` discount mode: v1 migrations were regenerated, so local databases made before this change need clearing.
