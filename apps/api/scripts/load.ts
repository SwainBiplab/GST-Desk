/**
 * A small load generator for the latency budget (p95 under 150 ms for CRUD at 100 requests per second):
 *   pnpm --filter api exec tsx scripts/load.ts --url http://localhost:8787 --rps 100 --seconds 30
 * Signs in through the mock code sender, makes an organisation and a business, then mixes reads and a
 * few writes at the asked rate and prints p50, p95, p99 and the error count. Node's fetch only.
 */
const args = new Map<string, string>();
process.argv
  .slice(2)
  .forEach((a, i, all) => a.startsWith('--') && args.set(a.slice(2), all[i + 1] ?? ''));
const url = (args.get('url') || 'http://localhost:8787').replace(/\/$/, '');
const rps = Number(args.get('rps') || 100);
const seconds = Number(args.get('seconds') || 30);

const headers = { 'content-type': 'application/json', origin: 'http://localhost:1420' };
const email = `load-${Date.now()}@example.com`;
let r = await fetch(`${url}/v1/auth/email-otp/send-verification-otp`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email, type: 'sign-in' }),
});
if (!r.ok) throw new Error(`send otp ${r.status}`);
const { code } = (await (
  await fetch(`${url}/v1/dev/otp?to=${encodeURIComponent(email)}`)
).json()) as { code: string };
r = await fetch(`${url}/v1/auth/sign-in/email-otp`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email, otp: code, name: 'Load' }),
});
if (!r.ok) throw new Error(`sign in ${r.status}`);
const token = r.headers.get('set-auth-token')!;
const auth = { ...headers, authorization: `Bearer ${token}` };
const org = (await (
  await fetch(`${url}/v1/orgs`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'Load Org' }),
  })
).json()) as { id: string };
const biz = (await (
  await fetch(`${url}/v1/orgs/${org.id}/businesses`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ legalName: 'Load Biz', stateCode: '27' }),
  })
).json()) as { id: string; version: number };

const reads = [
  `/v1/me`,
  `/v1/orgs`,
  `/v1/orgs/${org.id}`,
  `/v1/orgs/${org.id}/businesses`,
  `/v1/orgs/${org.id}/businesses/${biz.id}`,
];
const samples: number[] = [];
let errors = 0;
let version = biz.version;
let n = 0;
const started = performance.now();
const end = started + seconds * 1000;
const interval = 1000 / rps;
const inflight: Promise<void>[] = [];
const one = async (i: number) => {
  const t0 = performance.now();
  try {
    let res: Response;
    if (i % 10 === 9) {
      res = await fetch(`${url}/v1/orgs/${org.id}/businesses/${biz.id}`, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ tradeName: `T${i}`, version }),
      });
      if (res.ok) version = ((await res.json()) as { version: number }).version;
    } else {
      res = await fetch(`${url}${reads[i % reads.length]}`, { headers: auth });
      await res.arrayBuffer();
    }
    if (!res.ok) errors++;
  } catch {
    errors++;
  }
  samples.push(performance.now() - t0);
};
while (performance.now() < end) {
  const due = started + n * interval;
  const wait = due - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  inflight.push(one(n++));
}
await Promise.all(inflight);
samples.sort((a, b) => a - b);
const q = (p: number) =>
  samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]!.toFixed(1);
const elapsed = (performance.now() - started) / 1000;
console.log(
  `${samples.length} requests in ${elapsed.toFixed(1)} s (${(samples.length / elapsed).toFixed(0)} rps): p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, p99 ${q(0.99)} ms, max ${samples[samples.length - 1]!.toFixed(1)} ms, errors ${errors}`,
);

export {};
