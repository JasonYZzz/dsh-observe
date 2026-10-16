const sensitive = /^(?:token|.*password.*|.*secret.*|.*credential.*|api[-_]?key|authorization|cookie|set-cookie|(?:access|refresh|launch)[-_]?token)$/i;
const content = /^(?:content|arguments|result|rawOutput|summary|stream|replayState|text)$/i;
export function safeText(text: string, limit = 8192): string {
  return text.replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/((?:api[-_]?key|password|secret|(?:access|refresh|launch)?[-_]?token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/g, (value) => {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
      catch { return '[URL omitted]'; }
    }).slice(0, limit);
}
export function redact(value: unknown, omitContent = false, depth = 0, seen = new WeakSet<object>()): unknown {
  try {
    if (typeof value === 'string') {
      if (depth < 4 && /^[\s]*[\[{]/.test(value)) {
        try { return redact(JSON.parse(value), omitContent, depth + 1, seen); } catch { /* ordinary text */ }
      }
      return safeText(value);
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return '[Unavailable]';
    if (depth >= 6 || seen.has(value)) return '[Truncated or circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 64).map((entry) => redact(entry, omitContent, depth + 1, seen));
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 64)) {
      if (!('value' in descriptor)) { output[key] = '[Accessor omitted]'; continue; }
      output[key] = sensitive.test(key) ? '[REDACTED]' : omitContent && content.test(key) ? '[Content omitted]' : redact(descriptor.value, omitContent, depth + 1, seen);
    }
    return output;
  } catch { return '[Content unavailable]'; }
}
export function logSummary(args: unknown): string {
  try { return new TextDecoder().decode(Buffer.from(JSON.stringify(redact(args))).subarray(0, 8192), { stream: true }); } catch { return '[Content unavailable]'; }
}

// Explicit local inspection is separate from log summaries and metadata-only source queries.
export function inspectSerialize(value: unknown, budget = 2_000_000): { text: string; truncated: boolean } {
  let remaining = budget; let truncated = false; const seen = new WeakSet<object>();
  const visit = (value: unknown, depth = 0): unknown => {
    if (remaining <= 0 || depth > 16) { truncated = true; return '[Display limit reached]'; }
    remaining -= 8;
    if (typeof value === 'string') {
      if (/^data:[^,]+;base64,/i.test(value)) return '[Binary content omitted]';
      if (/^\s*[\[{]/.test(value) && value.length < remaining) { try { return JSON.stringify(visit(JSON.parse(value), depth + 1)); } catch {} }
      const text = safeText(value, remaining); remaining -= text.length;
      if (text.length < value.length && remaining === 0) truncated = true;
      return text;
    }
    if (value === undefined) return null;
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]'; seen.add(value);
    if (Array.isArray(value)) { if (value.length > 10000) truncated = true; return value.slice(0, 10000).map((entry) => visit(entry, depth + 1)); }
    const output: Record<string, unknown> = Object.create(null);
    const fields = Object.entries(Object.getOwnPropertyDescriptors(value)); if (fields.length > 200) truncated = true;
    for (const [key, descriptor] of fields.slice(0, 200)) {
      output[key] = !('value' in descriptor) ? '[Accessor omitted]' : sensitive.test(key) || /^(?:replayState|base64|bytes)$/i.test(key) ? '[REDACTED]' : visit(descriptor.value, depth + 1);
    }
    return output;
  };
  const safe = visit(value);
  return { text: typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2), truncated };
}
