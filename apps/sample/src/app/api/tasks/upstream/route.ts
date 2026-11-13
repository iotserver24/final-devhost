export async function GET() {
  const base = process.env.UPSTREAM_URL?.trim();
  if (!base) throw new Error('Task service failed because the upstream dependency is not configured.');
  let status = 0;
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/health`, { cache: 'no-store' });
    status = response.status;
    if (response.ok) return Response.json({ ok: true });
  } catch {
    status = 0;
  }
  throw new Error(`Task service failed because the upstream dependency returned ${status || 'no response'}.`);
}
