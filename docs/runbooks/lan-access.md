# Runbook: tablets and phones (LAN access)

For someone supporting a shop that uses a tablet at the counter.

## Turn it on

Settings, Tablets and phones, switch on. The page shows the addresses (`https://192.168.x.x:8443`) and the certificate fingerprint. If it says "this build does not include tablet access", the installed app was built without the `lan` feature.

## Add a tablet

1. On the computer: choose what the tablet may do, press Show pairing code.
2. On the tablet (same Wi-Fi): scan the QR, or open the address and type the code.
3. The tablet warns about the certificate once. Compare the fingerprint it shows with the one on the computer, then continue.
4. The code lasts 5 minutes and works once. Five wrong tries cancel it and make that tablet wait a minute.

## When it does not work

| Symptom                                        | Likely cause                                           | Do this                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| The tablet cannot reach the address            | Firewall, guest Wi-Fi, or the tablet is on mobile data | Allow GST Desk on private networks; join the shop Wi-Fi; turn off "client isolation" on the router |
| `gstdesk.local` does not open, the number does | mDNS blocked or not supported                          | Use the address with numbers                                                                       |
| Certificate warning every time                 | The tablet does not remember the exception             | Normal for some browsers; install the app on the tablet when it exists                             |
| "Removed from the computer" on the tablet      | The device was removed in Settings                     | Pair again                                                                                         |
| "Too many attempts"                            | Five wrong codes                                       | Wait a minute, show a new code                                                                     |
| Port in use                                    | Another program has 8443                               | Switch off, choose another port, switch on                                                         |
| The address changed                            | The router gave the computer a new address             | The certificate is made again on the next start; pair again only if the fingerprint changed        |

## Remove a device or stop everything

Remove a single device in the list (it stops working at once). Switch the whole feature off to close the port. Both are recorded in the audit trail.

## Before relying on it

The desktop glue (`apps/desktop/src-tauri/src/lan.rs`) was written without being compiled. Build with `cargo tauri build --features lan`, then: pair a phone, bill from it, remove it and see it refused, restart the app and see the server come back.
