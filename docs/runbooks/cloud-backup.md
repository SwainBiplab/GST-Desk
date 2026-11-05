# Copying backups to your own Google Drive or OneDrive

GST Desk can copy each backup to a folder called **GST Desk Backups** in your own Google Drive or OneDrive. It uses an app **you** create in your own Google or Microsoft account, so only you hold the keys, we never see or use your drive, and nothing is shared with anyone. This is available in the desktop app only, and is off until you switch it on.

You will end up with three things to type into **Settings → Backup → Cloud drive**: a **client id**, a **client secret** (Google; optional for OneDrive) and a **refresh token**. They are kept on this device only. They are never in a backup or an export.

## Google Drive

1. Open the Google Cloud Console (console.cloud.google.com) and create a project, for example "GST Desk backups".
2. **APIs and services → Library**: find **Google Drive API** and **Enable** it.
3. **APIs and services → OAuth consent screen**: choose **External**, give it a name, add your own address as a test user, and add the scope `https://www.googleapis.com/auth/drive.file` (the app can then only see files it made itself).
4. **Credentials → Create credentials → OAuth client ID**: type **Desktop app**. Copy the **client id** and **client secret**.
5. Get a refresh token once, with the OAuth Playground (developers.google.com/oauthplayground): open the settings (gear), tick **Use your own OAuth credentials**, paste your client id and secret, choose the Drive scope above, authorise with your Google account, and press **Exchange authorization code for tokens**. Copy the **refresh token**.
6. In GST Desk, choose **Google Drive**, paste the three values, tick **Copy every backup to this drive**, choose **Save**, then **Upload the latest backup now** to check it works.

## OneDrive

1. Open the Microsoft Entra admin centre (entra.microsoft.com) → **App registrations → New registration**. Choose **Personal Microsoft accounts only** (or your own organisation) and set the redirect URI type to **Public client/native** with `http://localhost`.
2. **API permissions → Add → Microsoft Graph → Delegated**: `Files.ReadWrite` and `offline_access`.
3. Copy the **Application (client) id**. A client secret is not needed for a public client.
4. Get a refresh token once: open the authorisation address for your app in a browser (`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=<id>&response_type=code&redirect_uri=http://localhost&scope=Files.ReadWrite%20offline_access`), sign in, copy the `code` from the address you are sent to, and exchange it with a POST to `https://login.microsoftonline.com/common/oauth2/v2.0/token` (`grant_type=authorization_code`, the code, the client id and the same redirect address). Copy the **refresh_token** from the answer.
5. In GST Desk, choose **OneDrive**, paste the client id and the refresh token, tick **Copy every backup to this drive**, choose **Save**, then **Upload the latest backup now**.

## Good to know

- A refresh token can be revoked at any time from your Google or Microsoft account page. If it stops working, GST Desk says so on the Backup tab and the bell.
- Only backups made after you switch it on are copied. Old copies in your drive are never deleted by GST Desk; clear them yourself when you like.
- Files up to 4 MB go to OneDrive in one request; larger ones are sent in pieces. Google uses a resumable upload for all sizes.
- A later version of the desktop app will do the sign-in for you, so the refresh token steps go away.
