/**
 * Uploading a backup to the person's own Google Drive or OneDrive. Nothing here ships with credentials:
 * the client id, client secret and refresh token are the ones the person made in their own Google or
 * Microsoft developer account and typed into Settings (see `docs/runbooks/cloud-backup.md`). They are
 * kept as secret settings, which no backup or export carries, and are never written to a log or an
 * error message. Desktop only, and only when switched on.
 */

export type CloudProvider = 'google' | 'onedrive';

export interface CloudCredentials {
  provider: CloudProvider;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

export interface CloudUpload {
  provider: CloudProvider;
  id: string;
  name: string;
}

export class CloudError extends Error {
  override name = 'CloudError';
  constructor(
    readonly kind: 'auth' | 'server' | 'network' | 'setup',
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export const FOLDER_NAME = 'GST Desk Backups';
/** OneDrive takes a file this small in one request, and bigger ones in 320 KiB-multiple pieces. */
export const ONEDRIVE_SIMPLE_MAX = 4 * 1024 * 1024;
export const ONEDRIVE_CHUNK = 10 * 320 * 1024;

const form = (fields: Record<string, string | undefined>): URLSearchParams => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v) p.set(k, v);
  return p;
};

async function checked(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  // the body can describe the problem; it is never echoed back as-is, as it might carry a token
  if (res.status === 401 || res.status === 403)
    throw new CloudError(
      'auth',
      `${what}: the drive did not accept the saved sign-in (${res.status}). Check the credentials in Settings.`,
    );
  throw new CloudError('server', `${what}: the drive answered ${res.status}.`);
}

async function call(f: Fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch {
    throw new CloudError(
      'network',
      `${what}: could not reach the drive. Check the internet connection.`,
    );
  }
  return checked(res, what);
}

/** Trade the refresh token for a short-lived access token. */
export async function accessToken(c: CloudCredentials, f: Fetch = fetch): Promise<string> {
  if (!c.clientId || !c.refreshToken)
    throw new CloudError('setup', 'Enter the client id and the refresh token first.');
  const [url, scope] =
    c.provider === 'google'
      ? ['https://oauth2.googleapis.com/token', undefined]
      : [
          'https://login.microsoftonline.com/common/oauth2/v2.0/token',
          'Files.ReadWrite offline_access',
        ];
  const res = await call(
    f,
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        scope,
      }),
    },
    'Signing in',
  );
  const json = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!json.access_token)
    throw new CloudError('auth', 'Signing in: the drive sent no access token.');
  return json.access_token;
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  ...extra,
});

/* ------------------------------------------------------------------ Google Drive */

async function googleFolder(token: string, f: Fetch): Promise<string> {
  const q = encodeURIComponent(
    `name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const found = await call(
    f,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`,
    { headers: bearer(token) },
    'Finding the backup folder',
  );
  const id = ((await found.json()) as { files?: { id: string }[] }).files?.[0]?.id;
  if (id) return id;
  const made = await call(
    f,
    'https://www.googleapis.com/drive/v3/files?fields=id',
    {
      method: 'POST',
      headers: bearer(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    },
    'Creating the backup folder',
  );
  return ((await made.json()) as { id: string }).id;
}

async function uploadGoogle(
  token: string,
  name: string,
  bytes: Uint8Array,
  f: Fetch,
): Promise<CloudUpload> {
  const parent = await googleFolder(token, f);
  // a resumable upload: the same two requests for a small file and a large one
  const start = await call(
    f,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name',
    {
      method: 'POST',
      headers: bearer(token, {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/zip',
        'X-Upload-Content-Length': String(bytes.length),
      }),
      body: JSON.stringify({ name, parents: [parent] }),
    },
    'Starting the upload',
  );
  const session = start.headers.get('Location');
  if (!session)
    throw new CloudError(
      'server',
      'Starting the upload: the drive gave no place to send the file.',
    );
  const done = await call(
    f,
    session,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length) },
      body: bytes as unknown as BodyInit,
    },
    'Uploading the backup',
  );
  const json = (await done.json()) as { id: string; name: string };
  return { provider: 'google', id: json.id, name: json.name };
}

/* ------------------------------------------------------------------ OneDrive */

const oneDrivePath = (name: string) =>
  `${encodeURIComponent(FOLDER_NAME)}/${encodeURIComponent(name)}`;

async function uploadOneDrive(
  token: string,
  name: string,
  bytes: Uint8Array,
  f: Fetch,
): Promise<CloudUpload> {
  const base = `https://graph.microsoft.com/v1.0/me/drive/root:/${oneDrivePath(name)}`;
  if (bytes.length <= ONEDRIVE_SIMPLE_MAX) {
    const res = await call(
      f,
      `${base}:/content`,
      {
        method: 'PUT',
        headers: bearer(token, { 'Content-Type': 'application/zip' }),
        body: bytes as unknown as BodyInit,
      },
      'Uploading the backup',
    );
    const json = (await res.json()) as { id: string; name: string };
    return { provider: 'onedrive', id: json.id, name: json.name };
  }
  const session = await call(
    f,
    `${base}:/createUploadSession`,
    {
      method: 'POST',
      headers: bearer(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    },
    'Starting the upload',
  );
  const url = ((await session.json()) as { uploadUrl?: string }).uploadUrl;
  if (!url)
    throw new CloudError(
      'server',
      'Starting the upload: the drive gave no place to send the file.',
    );
  let last: Response | null = null;
  for (let from = 0; from < bytes.length; from += ONEDRIVE_CHUNK) {
    const to = Math.min(bytes.length, from + ONEDRIVE_CHUNK);
    // the upload address carries its own authorisation: the token is not sent to it
    last = await call(
      f,
      url,
      {
        method: 'PUT',
        headers: {
          'Content-Length': String(to - from),
          'Content-Range': `bytes ${from}-${to - 1}/${bytes.length}`,
        },
        body: bytes.subarray(from, to) as unknown as BodyInit,
      },
      'Uploading the backup',
    );
  }
  const json = (await last!.json()) as { id: string; name: string };
  return { provider: 'onedrive', id: json.id, name: json.name };
}

/** Put a backup file in the person's drive, in a folder called "GST Desk Backups". */
export async function uploadBackup(
  c: CloudCredentials,
  name: string,
  bytes: Uint8Array,
  f: Fetch = fetch,
): Promise<CloudUpload> {
  const token = await accessToken(c, f);
  return c.provider === 'google'
    ? uploadGoogle(token, name, bytes, f)
    : uploadOneDrive(token, name, bytes, f);
}
