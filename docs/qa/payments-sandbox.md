# Payments sandbox acceptance (Razorpay test mode)

**Status: NOT RUN.** This needs a Razorpay account in test mode (key id `rzp_test_...`, key secret, a webhook
secret) and the API reachable over https for the webhook. None was available when prompt 45 was built. Nothing
below is a result. The automated tests use a scripted `fetch`, a mock gateway and hand-written fixtures (B-199).

Acceptance (prompt 45): a Razorpay test-mode payment marks a seeded invoice paid and posts the ledger entries.

## Needs

`SECRETS_KEY` on the API; a test business with a synced invoice; Razorpay test keys and webhook secret; the webhook
address from Settings, Online payments (`/v1/webhooks/razorpay/<id>`), subscribed to payment link, QR code, refund
and settlement events.

## Steps

| #   | Step                                                                                                                                                                    | Result  | Run by / date |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------- |
| 1   | Settings, Online payments: connect with the test keys; status shows Test mode                                                                                           | not run |               |
| 2   | Issue an invoice; More, Collect online; make the link; open it; pay with Razorpay's test UPI id `success@razorpay`                                                      | not run |               |
| 3   | The webhook arrives; the invoice shows Paid; Payments shows the receipt; the log has Bank, Receivable and the fee line                                                  | not run |               |
| 4   | Show payment QR; scan with the test UPI flow; the screen turns to Paid by itself                                                                                        | not run |               |
| 5   | Pay a part-payment link in two parts; the invoice shows Part paid, then Paid; one inbox item for the first part                                                         | not run |               |
| 6   | Resend the same webhook from Razorpay's dashboard; nothing changes                                                                                                      | not run |               |
| 7   | Fetch payouts after the test settlement; the payout is listed with its UTR                                                                                              | not run |               |
| 8   | Make a credit note, ask for a refund, approve it as a second user; the refund is "Paid back" and the credit note is used up                                             | not run |               |
| 9   | Check against the live API what the fixtures guess: the `fee` and `tax` fields on the payment, the QR `image_content`, `close_by` limits, the refund idempotency header | not run |               |
