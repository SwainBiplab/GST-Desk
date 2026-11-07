# @gst/payments

Payment gateway adapters (prompt 45). Pure TypeScript with no database: `apps/api` owns persistence, webhooks and
the accounting.

- `PaymentGatewayAdapter`: `createLink`, `createUpiQr`, `getPayment`, `refund`, `listSettlements`, `cancel`,
  `verifyWebhook`, `parseWebhook`. Amounts are paise.
- `RazorpayAdapter`: written from Razorpay's public API documentation (payment links, single-use UPI QR with
  its `image_content` UPI payload, refunds with an idempotency header, settlements, signed webhooks).
  `payment_link.paid` and `qr_code.credited` carry the payment; `payment.captured` is ignored so one payment is
  never two events.
- `MockGateway`: in memory, signs the webhooks it produces; for tests and demos.
- `sealSecret` / `openSecret`: AES-256-GCM under `SECRETS_KEY`, bound to the organisation.

The fixtures are hand-written from the documentation, not recordings (B-199). Run `pnpm --filter @gst/payments test`.
