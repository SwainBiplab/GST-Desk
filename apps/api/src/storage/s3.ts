/**
 * Object storage through the S3 API (MinIO in development, any S3-compatible service in production).
 * Every key sits under the organisation's prefix, uploads and downloads go through signed URLs that
 * expire in minutes, objects are encrypted server-side, and a lifecycle rule expires what the app marks
 * as temporary. The API itself never proxies file bytes.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Config } from '../config';

export const SIGNED_URL_SECONDS = 10 * 60;
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
export const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/zip',
  'application/x-gstdesk-backup',
]);

export interface Storage {
  ready(): Promise<boolean>;
  /** Make the bucket and its lifecycle rules (temporary objects expire in 7 days). Idempotent. */
  ensureBucket(): Promise<void>;
  /** Where an object for an organisation lives. Keys are made here, never taken from a client. */
  key(orgId: string, kind: 'attachments' | 'pdf' | 'backups' | 'tmp', name: string): string;
  signUpload(
    key: string,
    mime: string,
    sizeBytes: number,
  ): Promise<{ url: string; headers: Record<string, string>; expiresAt: number }>;
  signDownload(key: string, fileName?: string): Promise<{ url: string; expiresAt: number }>;
  exists(key: string): Promise<{ sizeBytes: number; mime: string } | null>;
  remove(key: string): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    readonly code: 'mime' | 'size' | 'key',
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function makeStorage(config: Config): Storage | null {
  const s3cfg = config.s3;
  if (!s3cfg) return null;
  const client = new S3Client({
    endpoint: s3cfg.endpoint,
    region: s3cfg.region,
    forcePathStyle: s3cfg.pathStyle,
    credentials: { accessKeyId: s3cfg.accessKey, secretAccessKey: s3cfg.secretKey },
  });
  const Bucket = s3cfg.bucket;
  return {
    async ready() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        return true;
      } catch {
        return false;
      }
    },
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
      try {
        await client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket,
            LifecycleConfiguration: {
              Rules: [
                {
                  ID: 'tmp-7-days',
                  Status: 'Enabled',
                  Filter: { Tag: { Key: 'tmp', Value: '1' } },
                  Expiration: { Days: 7 },
                },
                {
                  ID: 'backups-30-days',
                  Status: 'Enabled',
                  Filter: { Tag: { Key: 'kind', Value: 'backup' } },
                  Expiration: { Days: 30 },
                },
              ],
            },
          }),
        );
      } catch {
        // some S3-compatible services refuse lifecycle rules; the backup script enforces retention itself
      }
    },
    key(orgId, kind, name) {
      if (!/^[0-9a-f-]{36}$/.test(orgId)) throw new StorageError('key', 'bad organisation id');
      if (!SAFE_NAME.test(name)) throw new StorageError('key', 'bad object name');
      return `orgs/${orgId}/${kind}/${name}`;
    },
    async signUpload(key, mime, sizeBytes) {
      if (!ALLOWED_MIME.has(mime))
        throw new StorageError('mime', `${mime} is not an accepted file type`);
      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_OBJECT_BYTES)
        throw new StorageError(
          'size',
          `files must be between 1 byte and ${MAX_OBJECT_BYTES} bytes`,
        );
      const cmd = new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: mime,
        ContentLength: sizeBytes,
        ...(s3cfg.sse ? { ServerSideEncryption: s3cfg.sse } : {}),
        Tagging: key.includes('/tmp/')
          ? 'tmp=1'
          : key.includes('/backups/')
            ? 'kind=backup'
            : undefined,
      });
      const url = await getSignedUrl(client, cmd, { expiresIn: SIGNED_URL_SECONDS });
      return {
        url,
        headers: {
          'content-type': mime,
          ...(s3cfg.sse ? { 'x-amz-server-side-encryption': s3cfg.sse } : {}),
          ...(key.includes('/tmp/')
            ? { 'x-amz-tagging': 'tmp=1' }
            : key.includes('/backups/')
              ? { 'x-amz-tagging': 'kind=backup' }
              : {}),
        },
        expiresAt: Date.now() + SIGNED_URL_SECONDS * 1000,
      };
    },
    async signDownload(key, fileName) {
      const cmd = new GetObjectCommand({
        Bucket,
        Key: key,
        ...(fileName && SAFE_NAME.test(fileName)
          ? { ResponseContentDisposition: `attachment; filename="${fileName}"` }
          : {}),
      });
      return {
        url: await getSignedUrl(client, cmd, { expiresIn: SIGNED_URL_SECONDS }),
        expiresAt: Date.now() + SIGNED_URL_SECONDS * 1000,
      };
    },
    async exists(key) {
      try {
        const h = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          sizeBytes: Number(h.ContentLength ?? 0),
          mime: h.ContentType ?? 'application/octet-stream',
        };
      } catch {
        return null;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
