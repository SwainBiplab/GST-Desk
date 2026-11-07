# Runbook: online payments

1. Set `SECRETS_KEY` on the API (`openssl rand -base64 32`) and restart. Without it the Online payments tab says
   so and nothing can be connected. Do not change it later without telling businesses to reconnect.
2. A business owner (`payments.approve`) opens Settings, Online payments, and pastes the Razorpay key id, key secret
   and a webhook secret they choose. The tab then shows the webhook address; in Razorpay, add it with that secret
   for payment link, QR code, refund and settlement events.
3. Test keys (`rzp_test_`) show "Test mode": no real money moves. Switch to live keys once Razorpay has activated the
   account; a refused activation shows as the gateway's last error on the tab.
4. A webhook that answers 401 has the wrong secret; a 404 is an unknown or disconnected gateway. Nothing is stored
   either way, and Razorpay retries.
5. Inbox items "Payment to check": money matching no invoice (find the customer, record it by hand if right),
   part and over payments (informational), refunds the gateway refused.
6. Stuck payment: a payment row left `processing` is retaken by the gateway's next delivery after a minute; Razorpay's
   dashboard can resend an event.
7. Never paste a key, secret or customer detail into a ticket; use the provider payment id.
