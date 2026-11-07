/**
 * Files for an organisation: the API signs uploads and downloads; bytes go straight between the client
 * and the object store. Keys are made on the server from the organisation, a kind and a name.
 */
import { createRoute, z } from '@hono/zod-openapi';

import { subApp, type App } from '../app';
import { ApiError, errorSchema, notFound } from '../errors';
import { requireOrg, requireWriter, type OrgVars } from '../middleware/session';
import { ALLOWED_MIME, MAX_OBJECT_BYTES, StorageError } from '../storage/s3';

import type { RouteDeps } from './index';

const kinds = ['attachments', 'pdf', 'backups', 'tmp'] as const;
const orgParam = z.object({
  orgId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'orgId', in: 'path' } }),
});
const security = [{ bearer: [] }, { cookie: [] }];
const errors = {
  401: { description: 'Not signed in', content: { 'application/json': { schema: errorSchema } } },
  403: {
    description: 'Not allowed for this role',
    content: { 'application/json': { schema: errorSchema } },
  },
  404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
};

export function fileRoutes(app: App, deps: RouteDeps): void {
  const org = subApp();
  org.use('*', requireOrg as never);
  const storage = () => {
    if (!deps.storage)
      throw new ApiError(503, 'no_storage', 'File storage is not configured on this server.');
    return deps.storage;
  };

  org.openapi(
    createRoute({
      method: 'post',
      path: '/sign-upload',
      tags: ['files'],
      summary: 'A signed URL to upload one file (PUT the bytes there within ten minutes)',
      security,
      middleware: [requireWriter] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  kind: z.enum(kinds),
                  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/),
                  mime: z.string().refine((m) => ALLOWED_MIME.has(m), 'file type not accepted'),
                  sizeBytes: z.number().int().positive().max(MAX_OBJECT_BYTES),
                })
                .openapi('SignUploadInput'),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Where to PUT the bytes',
          content: {
            'application/json': {
              schema: z
                .object({
                  key: z.string(),
                  url: z.string(),
                  headers: z.record(z.string(), z.string()),
                  expiresAt: z.number(),
                })
                .openapi('SignedUpload'),
            },
          },
        },
        ...errors,
        422: { description: 'Refused', content: { 'application/json': { schema: errorSchema } } },
        503: {
          description: 'No storage',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      const o = c.get('org' as never) as OrgVars['org'];
      const b = c.req.valid('json');
      try {
        const s = storage();
        const key = s.key(o.id, b.kind, b.name);
        const signed = await s.signUpload(key, b.mime, b.sizeBytes);
        return c.json({ key, ...signed }, 200);
      } catch (e) {
        if (e instanceof StorageError) throw new ApiError(422, `file_${e.code}`, e.message);
        throw e;
      }
    },
  );

  org.openapi(
    createRoute({
      method: 'get',
      path: '/sign-download',
      tags: ['files'],
      summary: 'A signed URL to download one of the organisation’s files',
      security,
      request: {
        params: orgParam,
        query: z.object({
          key: z.string().min(1).max(400),
          fileName: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/)
            .optional(),
        }),
      },
      responses: {
        200: {
          description: 'Where to GET the bytes',
          content: {
            'application/json': {
              schema: z
                .object({
                  url: z.string(),
                  expiresAt: z.number(),
                  sizeBytes: z.number(),
                  mime: z.string(),
                })
                .openapi('SignedDownload'),
            },
          },
        },
        ...errors,
        503: {
          description: 'No storage',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async (c) => {
      const o = c.get('org' as never) as OrgVars['org'];
      const { key, fileName } = c.req.valid('query');
      // a key is only ever one of ours, under this organisation
      if (!key.startsWith(`orgs/${o.id}/`) || key.includes('..')) throw notFound('That file');
      const s = storage();
      const head = await s.exists(key);
      if (!head) throw notFound('That file');
      const signed = await s.signDownload(key, fileName);
      return c.json({ ...signed, ...head }, 200);
    },
  );

  app.route('/v1/orgs/:orgId/files', org as never);
}
