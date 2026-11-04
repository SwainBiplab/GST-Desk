# Setup wizard: usability test

Goal (prompt 11): a new user with a GSTIN reaches the dashboard in under two minutes.

## What has been measured

An automated run (Playwright, Chromium, 1366x768, fresh storage) drives the shortest honest path with a valid GSTIN:

| Step | Screen                            | Actions                       |
| ---- | --------------------------------- | ----------------------------- |
| 1    | Language and mode                 | Next                          |
| 2    | Start from (blank is preselected) | Next                          |
| 3    | GSTIN                             | type the GSTIN, Next          |
| 4    | Business details                  | type name, type address, Next |
| 5    | Business type                     | choose a preset, Next         |
| 6    | Payment account                   | Skip                          |
| 7    | All set                           | Go to dashboard               |

**11 UI actions (preset chosen) and about 1 to 2 seconds of machine time**, against the limits of 20 actions and 2 minutes. The test is `e2e/wizard.spec.ts` ("a GSTIN gets from the first screen to a dashboard in under 20 UI actions") and prints the figures. A second test completes the wizard with the keyboard only (Tab, arrow keys and Enter, no pointer).

This proves the flow is short and fast. **It does not prove a person can do it in under two minutes.** Reading, finding the GSTIN and typing take time the script does not have.

## Human run (still to do)

Not yet performed. Protocol, so the acceptance criterion can be signed off:

1. Recruit 5 people who run a small business and have not seen the app: ideally a mix of shop owners and accountants.
2. Give each a card with a business name, address and a valid GSTIN (use test GSTINs, never real customers' numbers). Say only: "Set this business up so you can start billing."
3. Start a stopwatch when the first screen appears. Stop when the dashboard is shown. Do not help; note every hesitation, error message read, back-step and question.
4. Record: time, number of errors, step where they hesitated longest, and one sentence of feedback.
5. Pass: median under 2 minutes and nobody needs help. Anything slower or any step with two or more hesitations becomes a fix.

Results table (fill in):

| Person | Role | Time | Errors | Slowest step | Notes |
| ------ | ---- | ---- | ------ | ------------ | ----- |
|        |      |      |        |              |       |

## What the wizard already does to help

- Every step validates inline with a plain sentence ("The last character does not match. Check for a typing mistake.") and focuses the first problem.
- Back keeps everything typed; state is held in one place for the whole wizard.
- The GSTIN field shows the state, PAN and taxpayer type it read from the number as soon as it is valid, so a wrong number is noticed before moving on.
- The first field of each step is focused, Enter moves forward in text fields, and the buttons that create data wait for the local database instead of doing nothing.
- "Not registered yet" skips the GSTIN and asks for a state instead; composition is only offered with a GSTIN.
- A sample business skips all questions and loads 50 parties, 200 items and 500 documents.
