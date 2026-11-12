/** Redacted progress and transcript events for the incident dashboard. */
export interface RemediationActivity {
  at: string;
  phase: 'sandbox' | 'checkout' | 'setup' | 'reproduction' | 'agent' | 'verification' | 'patch';
  kind: 'stage' | 'tool' | 'tool_input' | 'tool_output' | 'message' | 'summary' | 'usage' | 'status';
  message: string;
}

export const MAX_ACTIVITY_TEXT = 32_000;
const MAX_LINE = 512_000;
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/;
const PRIVATE_FIELD = /^(thoughts?|thinking|reasoning|chain[_-]?of[_-]?thought|signature|_meta)$/i;
const SECRET_FIELD = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential/i;

export function boundActivityText(text: string): string {
  return text.length > MAX_ACTIVITY_TEXT ? `${text.slice(0, MAX_ACTIVITY_TEXT - 40)}\n[Output truncated at 32,000 characters]` : text;
}

function publicData(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[Nested data omitted]';
  if (Array.isArray(value)) return value.map(item => publicData(item, depth + 1));
  if (value && typeof value === 'object') {
    const type = (value as Record<string, unknown>).type;
    if (typeof type === 'string' && PRIVATE_FIELD.test(type)) return '[Private reasoning omitted]';
    return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELD.test(key))
      .map(([key, entry]) => [key, SECRET_FIELD.test(key) ? '[REDACTED]' : publicData(entry, depth + 1)]));
  }
  return value;
}

/** Parses public messages and redacted tool actions; private reasoning events are ignored. */
export function createAgentActivityParser(
  emit: (kind: RemediationActivity['kind'], message: string) => void,
  sanitize: (text: string) => string,
) {
  let pending = '';
  let dropping = false;
  let text = '';
  const tools = new Map<string, { name: string; output?: string }>();
  let toolCalls = 0;
  const send = (kind: RemediationActivity['kind'], message: string) => emit(kind, boundActivityText(sanitize(message)));
  const detail = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(publicData(value), null, 2);

  function flushText() {
    if (text.trim()) send('message', text.trim());
    text = '';
  }

  function line(raw: string) {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch { return; }
    switch (event.type) {
      case 'text':
        if (typeof event.data === 'string') {
          text += event.data;
          const boundary = text.lastIndexOf('\n\n');
          if (boundary >= 0) {
            const complete = text.slice(0, boundary).trim();
            if (complete) send('message', complete);
            text = text.slice(boundary + 2);
          }
        }
        break;
      case 'tool_call': {
        flushText();
        const name = typeof event.toolName === 'string' && TOOL_NAME.test(event.toolName) ? event.toolName : 'tool';
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : String(toolCalls + 1);
        tools.set(id, { name });
        toolCalls++;
        send('tool', `Running ${name} · ${id}`);
        if (event.rawInput != null) send('tool_input', `${name} · ${id}\n${detail(event.rawInput)}`);
        break;
      }
      case 'tool_call_update': {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : '';
        const tool = tools.get(id);
        if (!tool) break;
        const output = event.rawOutput ?? event.content;
        if (output != null && (!Array.isArray(output) || output.length > 0)) {
          const data = detail(output);
          if (data !== tool.output) { send('tool_output', `${tool.name} · ${id}\n${data}`); tool.output = data; }
        }
        if (event.status === 'completed' || event.status === 'failed') {
          send('tool', `${tool.name} ${event.status} · ${id}`);
          tools.delete(id);
        }
        break;
      }
      case 'usage': {
        flushText();
        const usage = event.usage && typeof event.usage === 'object' ? event.usage as Record<string, unknown> : null;
        if (Number.isSafeInteger(usage?.input_tokens) && Number.isSafeInteger(usage?.output_tokens)) {
          send('usage', `${usage!.input_tokens} input / ${usage!.output_tokens} output tokens`);
        }
        break;
      }
      case 'end':
        flushText();
        send('status', `Agent finished after ${toolCalls} tool calls`);
        break;
      case 'error':
        flushText();
        send('status', 'Agent reported an error; see the incident outcome');
        break;
      // Thought/reasoning events and arbitrary protocol data are never forwarded.
    }
  }

  return {
    push(chunk: string) {
      // Process each line independently, including chunks containing many events.
      for (const segment of chunk.split(/(?<=\n)/)) {
        const ended = segment.endsWith('\n');
        if (!dropping) pending += segment;
        if (pending.length > MAX_LINE) {
          pending = ''; dropping = true;
          send('status', 'Skipped an oversized agent event (over 512,000 characters)');
        }
        if (ended) {
          if (!dropping && pending.trim()) line(pending.trim());
          pending = ''; dropping = false;
        }
      }
    },
    finish() {
      if (!dropping && pending.trim()) line(pending.trim());
      flushText();
      pending = '';
    },
    get toolCalls() { return toolCalls; },
  };
}
