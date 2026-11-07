import { createHmac } from 'node:crypto';

/** A fetch that answers from a script and records every call, so adapters are tested against fixtures. */
export function scripted(
  answers: { match: (url: string, init: RequestInit) => boolean; status?: number; json: unknown }[],
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url, init });
    const a = answers.find((x) => x.match(url, init));
    if (!a) return new Response('{"error":{"message":"unexpected call"}}', { status: 500 });
    return new Response(JSON.stringify(a.json), {
      status: a.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, calls };
}

export const metaSignature = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export function svixHeaders(secret: string, id: string, ts: number, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}
