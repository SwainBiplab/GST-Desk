---
'web': patch
---

Typing in the invoice editor with 200 lines is faster. The line grid no longer redraws on every keystroke in another field, the place-of-supply list and the preview no longer redo their work each time, and the median key-to-frame time went from 10 to 12 ms to 9 ms (95th percentile 10 to 12 ms on the development laptop). Still to confirm on the CI runner and the reference laptop (ADR 0015, B-092).
