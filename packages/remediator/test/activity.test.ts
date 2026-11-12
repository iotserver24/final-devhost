import { expect, test } from 'bun:test';
import { createAgentActivityParser, MAX_ACTIVITY_TEXT } from '../src/activity.ts';

test('streams messages and redacted tool inputs/results, excluding private reasoning', () => {
  const events: Array<{ kind: string; message: string }> = [];
  const parser = createAgentActivityParser((kind, message) => events.push({ kind, message }),
    text => text.replaceAll('dedicated-secret', '[REDACTED]'));
  parser.push('{"type":"thought","data":"private reasoning"}\n{"type":"text","data":"I found the ded');
  parser.push('icated-secret"}\n{"type":"tool_call","toolCallId":"1","toolName":"read_file","rawInput":{"path":"route.ts","secret":"do-not-show"}}\n');
  parser.push('{"type":"tool_call_update","toolCallId":"1","status":"completed","rawOutput":{"content":"export const handler = true","password":"hidden","reasoning":"private reasoning"}}\n');
  parser.push('{"type":"end"}\n');
  expect(events.map(event => event.kind)).toEqual(['message', 'tool', 'tool_input', 'tool_output', 'tool', 'status']);
  expect(events[0]?.message).toBe('I found the [REDACTED]');
  expect(events[2]?.message).toContain('route.ts');
  expect(events[3]?.message).toContain('export const handler = true');
  const output = events.map(event => event.message).join(' ');
  for (const secret of ['private reasoning', 'do-not-show', 'hidden', 'dedicated-secret']) expect(output).not.toContain(secret);
});

test('emits complete progress paragraphs live and preserves messages longer than 1000 characters', () => {
  const messages: string[] = [];
  const parser = createAgentActivityParser((kind, text) => { if (kind === 'message') messages.push(text); }, text => text);
  parser.push(`${JSON.stringify({ type: 'text', data: 'Inspecting the failing route.\n\n' })}\n`);
  expect(messages).toEqual(['Inspecting the failing route.']);
  parser.push(`${JSON.stringify({ type: 'text', data: 'x'.repeat(6000) + 'message-end' })}\n`);
  parser.finish();
  expect(messages[1]).toEndWith('message-end');
});

test('bounds large output explicitly and continues after an oversized line in a shared chunk', () => {
  const messages: string[] = [];
  const parser = createAgentActivityParser((_, text) => messages.push(text), text => text);
  parser.push('x'.repeat(512_001));
  parser.push(`more oversized data\nnot json\n${JSON.stringify({ type: 'text', data: 'Recovered' })}\n`);
  parser.finish();
  expect(messages).toEqual(['Skipped an oversized agent event (over 512,000 characters)', 'Recovered']);
  const output: string[] = [];
  const second = createAgentActivityParser((_, text) => output.push(text), text => text);
  second.push(`${JSON.stringify({ type: 'text', data: 'x'.repeat(40_000) })}\n`);
  second.finish();
  expect(output[0]!.length).toBeLessThanOrEqual(MAX_ACTIVITY_TEXT);
  expect(output[0]).toContain('[Output truncated');
});

test('redacts nested credentials and omits reasoning-shaped content blocks', () => {
  const messages: string[] = [];
  const parser = createAgentActivityParser((_, text) => messages.push(text), text => text);
  const events = [
    { type: 'tool_call', toolCallId: 'call', toolName: 'shell', rawInput: { command: 'bun test', env: { apiKey: 'hidden-value' } } },
    { type: 'tool_call_update', toolCallId: 'call', content: [{ type: 'thinking', text: 'private thought' }, { type: 'text', text: 'Tests passed' }] },
  ];
  parser.push(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  parser.finish();
  expect(messages.join('')).toContain('Tests passed');
  expect(messages.join('')).not.toContain('private thought');
  expect(messages.join('')).not.toContain('hidden-value');
});
