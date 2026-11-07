# 0028 — Collecting payment online: links, dynamic UPI QR, automatic reconciliation

Status: accepted. Context: prompt 45, PRD FR-054, UX-05, cloud tier.

## Decision

- **The business's own gateway account.** Each business connects its own Razorpay keys; customers pay Razorpay and
  the money goes to the business's bank. The platform never holds funds. Keys and the webhook secret are sealed
  (AES-256-GCM, key `SECRETS_KEY` in the environment, bound to the organisation) and are never returned.
- **One webhook address per gateway row** (`/v1/webhooks/razorpay/<gateway id>`), because each account has its own
  webhook secret and the event does not name our organisation. The signature is checked over the raw body first.
- **A request per invoice and kind.** A link (optionally accepting part payments, expiring in days) or a
  single-use fixed-amount UPI QR, both for exactly what is owed at that moment; the same ask returns the same
  request. We do not let the gateway notify the customer: the link travels with our own message, PDF and share text.
  The QR is drawn by the app from the UPI payload the gateway returns, so it is sharp and needs no image fetch.
- **A payment is a row keyed by the provider's payment id.** A delivery claims it with one atomic update and a
  one-minute lease; later or simultaneous deliveries find it taken. A payment already recorded under that reference
  (a delivery that died half way) is adopted. `payment_link.paid` / `qr_code.credited` are the events that carry a
  payment; `payment.captured` is ignored so a payment is never two events.
- **Allocation uses the domain's own rules.** The server records a received payment through `PaymentFlowRepo.record`
  against the invoice (up to what is owed). More than owed stays as party credit; less leaves the invoice part-paid;
  both, and money that matches no invoice, raise one `payment_attention` inbox item.
- **The gateway's fee is an expense out of the bank** (`postGatewayFee`: debit "Payment gateway fees", credit bank),
  so the bank account equals what the gateway pays out. The GST on the fee stays inside the expense for now (B-194).
- **Payouts**: fetched from the gateway and stored; a payout "adds up" when the payments tagged to it, less their
  fees, equal it. Tagging is by hand for now (B-196); the unmatched list is what the bank import (prompt 53) will use.
- **Refunds out of credit notes** (`allocations.kind = 'refund'`, `recordRefund`): a person with `payments.create`
  asks, a different person with `payments.approve` approves, the gateway pays with the refund's id as its idempotency
  key, and the books record a payment made (receivables debited, bank credited) that uses up the credit note, so
  Party 360, ageing and the ledger agree. Capped by what was paid and by the note's balance.
- **Cloud only, synced books only**, like messaging: the server must hold the invoice (a synced book, or demo mode).

## Not done

No real Razorpay account was available, so nothing here has met the real API (`docs/qa/payments-sandbox.md`, B-199);
the fixtures are written from the documentation. Card terminals, EMI and international gateways are out of scope.
See B-194 to B-200.
