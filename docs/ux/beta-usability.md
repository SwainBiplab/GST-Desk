# Beta usability test: first invoice in ten minutes (G8)

G8 says a new user, with no training, makes and issues their first invoice within ten minutes of opening the app.

## Status

**The five test runs have not been done.** They need five people who have never used the app, and nobody has been recruited yet. This page holds the script, the recording sheet and the way to decide what to fix, so the runs can happen as soon as the beta build is in someone's hands. Until then **G8 is unverified**, and the "top three friction points" below are candidates from reading the flow, not findings from observation.

## Who to ask

Five people who run a small shop or keep a small business's books, who have not seen GST Desk, with at least one who prefers Hindi or another language, and at least one who has only ever used paper or a phone app. Not developers. Not the people who built it.

## Setup

- A clean install of the beta build (or the web app in a fresh browser profile): nothing loaded.
- A sheet with one fake customer ("Sharma Traders", Mumbai, GSTIN `27AAPFU0939F1ZV`, phone 98200 12345) and two items (a name, HSN `7318`, 18%, price 120.00; a name, HSN `0902`, 5%, price 500.00) and the instruction to sell 3 of the first and 1 of the second.
- A screen recording and a stopwatch. Do not help. Do not explain. If they are stuck for a full minute, say "what would you try?"; after three minutes, give one hint and write down that you did.

## The task, as the person is told it

"You have just opened this app for the first time. Your business is called Test Traders and your GSTIN is `27AABCD1234E1Z5`. Make a bill for Sharma Traders for these items, and finish it so it has a number. Then record that Sharma paid in cash."

Start the clock when the app first appears. Stop it when the invoice shows its number (the issue step); note separately when the payment is recorded.

## Record, for each run

| Run | Who (age, role, language) | Time to first issued invoice | Time to payment recorded | Hints given | Where they stopped or hesitated (screen, what they said) | Mistakes the app let through |
| --- | ------------------------- | ---------------------------- | ------------------------ | ----------- | -------------------------------------------------------- | ---------------------------- |
| 1   |                           |                              |                          |             |                                                          |                              |
| 2   |                           |                              |                          |             |                                                          |                              |
| 3   |                           |                              |                          |             |                                                          |                              |
| 4   |                           |                              |                          |             |                                                          |                              |
| 5   |                           |                              |                          |             |                                                          |                              |

Median time to first issued invoice: _(fill in)_. G8 is met if the median is under 10 minutes and no run needed more than one hint.

## What to do with the results

1. List every hesitation of 15 seconds or more, and every wrong turn, by screen.
2. Count how many of the five hit each one. Fix the three that most people hit, smallest change first (a clearer label, a default, a hint at the right moment), never a new feature.
3. Run two more people on the fixed build and record the new median beside the old.

## Candidate friction points (from reading the flow, to be confirmed or dropped by the runs)

1. **Setup wizard asks for the GSTIN before the person has said whether they have one.** Someone without a GSTIN must find "I am not registered for GST yet"; a first-time shop owner may not know their GSTIN by heart. Watch whether they stall on that step.
2. **Adding the first party and item mid-invoice.** The invoice screen lets you type a new party or item name and create it in place, but the first time there is nothing to pick from. Watch whether people find "Create item" or leave the invoice to go to Items.
3. **Issue versus Save.** The invoice is a draft saved as you type; the number only comes at Issue. Someone expecting a "Save" button to finish the bill may stop at the draft. Watch for "is it done?".
