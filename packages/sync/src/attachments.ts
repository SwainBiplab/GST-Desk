/**
 * Files of a synced book (prompt 41). The `attachments` rows sync like any other row; the bytes move on
 * their own, through ten-minute signed URLs from the API, so they never pass through PowerSync or the API.
 * A file is named by its SHA-256 on the server (`orgs/<org>/attachments/<sha256>`), so the same file is
 * stored once and a download can be checked.
 *
 * Upload queue: rows whose bytes this device has and the server does not yet. Download queue: rows this
 * device has no bytes for. Both retry with a growing wait and say why when they give up for now.
 */

export interface BlobStore {
  has(sha256: string): Promise<boolean>;
  get(sha256: string): Promise<Uint8Array | null>;
  /** Store bytes under their hash; returns where they are kept locally (`storage_path`). */
  put(bytes: Uint8Array, mime: string): Promise<{ sha256: string; storagePath: string }>;
}

export interface FileApi {
  signUpload(body: {
    kind: 'attachments';
    name: string;
    mime: string;
    sizeBytes: number;
  }): Promise<{ key: string; url: string; headers: Record<string, string> }>;
  signDownload(key: string): Promise<{ url: string } | null>;
  /** PUT or GET at a signed URL. */
  transfer(
    url: string,
    init: { method: 'PUT' | 'GET'; headers?: Record<string, string>; body?: Uint8Array },
  ): Promise<{ ok: boolean; status: number; bytes?: Uint8Array }>;
}

export interface AttachmentRowLite {
  id: string;
  sha256: string;
  mime: string;
  size_bytes: number;
}

export interface QueueState {
  /** sha256 -> what happened last */
  uploaded: Set<string>;
  failures: Map<string, { tries: number; nextAt: number; message: string }>;
}

export interface QueueResult {
  uploaded: string[];
  downloaded: string[];
  failed: { sha256: string; message: string }[];
}

export const MAX_BACKOFF_MS = 30 * 60_000;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class AttachmentQueue {
  readonly state: QueueState = { uploaded: new Set(), failures: new Map() };

  constructor(
    private readonly orgId: string,
    private readonly blobs: BlobStore,
    private readonly api: FileApi,
    private readonly clock: () => number = Date.now,
  ) {}

  private due(sha: string): boolean {
    const f = this.state.failures.get(sha);
    return !f || f.nextAt <= this.clock();
  }

  private fail(sha: string, message: string, out: QueueResult) {
    const prev = this.state.failures.get(sha);
    const tries = (prev?.tries ?? 0) + 1;
    this.state.failures.set(sha, {
      tries,
      nextAt: this.clock() + Math.min(MAX_BACKOFF_MS, 2 ** tries * 1000),
      message,
    });
    out.failed.push({ sha256: sha, message });
  }

  /**
   * One pass: upload what this device made, download what it lacks. `serverHas` says which hashes the
   * server already holds (from a previous pass or the row being created elsewhere).
   */
  async run(
    rows: readonly AttachmentRowLite[],
    serverHas: (sha: string) => Promise<boolean>,
  ): Promise<QueueResult> {
    const out: QueueResult = { uploaded: [], downloaded: [], failed: [] };
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sha256)) continue;
      seen.add(r.sha256);
      if (!this.due(r.sha256)) continue;
      const local = await this.blobs.has(r.sha256);
      try {
        if (local && !this.state.uploaded.has(r.sha256)) {
          if (!(await serverHas(r.sha256))) {
            const bytes = await this.blobs.get(r.sha256);
            if (!bytes) throw new Error('the file is missing on this device');
            const signed = await this.api.signUpload({
              kind: 'attachments',
              name: r.sha256,
              mime: r.mime,
              sizeBytes: bytes.length,
            });
            const put = await this.api.transfer(signed.url, {
              method: 'PUT',
              headers: signed.headers,
              body: bytes,
            });
            if (!put.ok) throw new Error(`upload answered ${put.status}`);
            out.uploaded.push(r.sha256);
          }
          this.state.uploaded.add(r.sha256);
          this.state.failures.delete(r.sha256);
        } else if (!local) {
          const signed = await this.api.signDownload(`orgs/${this.orgId}/attachments/${r.sha256}`);
          if (!signed) throw new Error('not on the server yet');
          const got = await this.api.transfer(signed.url, { method: 'GET' });
          if (!got.ok || !got.bytes) throw new Error(`download answered ${got.status}`);
          // a file is only kept if it is the file the row names
          if ((await sha256Hex(got.bytes)) !== r.sha256)
            throw new Error('the downloaded file does not match its hash');
          await this.blobs.put(got.bytes, r.mime);
          this.state.uploaded.add(r.sha256);
          this.state.failures.delete(r.sha256);
          out.downloaded.push(r.sha256);
        }
      } catch (e) {
        this.fail(r.sha256, e instanceof Error ? e.message : String(e), out);
      }
    }
    return out;
  }
}
