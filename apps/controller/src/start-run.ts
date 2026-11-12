/**
 * Local trigger for an agent run. Kept out of the browser so the run token never
 * leaves the operator's shell environment.
 */
export {};

const incidentId = process.argv.find(arg => arg.startsWith('--incident='))?.slice('--incident='.length);
const mode = process.argv.includes('--rehearsal') ? 'rehearsal' : 'ai';
const token = process.env.NEXATHON_RUN_TOKEN;
if (!incidentId || !token) {
  throw new Error('Usage: NEXATHON_RUN_TOKEN=<local secret> bun run --cwd apps/controller start:run -- --incident=<id> [--rehearsal]');
}

const origin = process.env.CONTROLLER_API_URL ?? 'http://127.0.0.1:8787';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('The controller must be a localhost HTTP origin.');

const response = await fetch(`${origin}/api/internal/agent-runs`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ incidentId, mode }),
});
if (!response.ok) throw new Error(`Run could not start (HTTP ${response.status}): ${await response.text()}`);
const run = await response.json() as { id: string; source: string };
console.log(`Started ${run.source} run ${run.id}. Open the dashboard to watch it live.`);
