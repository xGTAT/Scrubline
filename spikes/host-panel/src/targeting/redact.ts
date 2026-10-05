export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of [...new Set(secrets)]
    .filter((s) => s.length >= 4)
    .sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[redacted]');
  return result
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}\b/g, '[token]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s<>"']+/gi, '[authorization]')
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^\s<>"']+/gi,
      '$1=[redacted]'
    )
    .replace(/\b[A-Z]:[\\/][^\s<>"']+/gi, '[path]')
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/var\/|\/etc\/|\/opt\/|\/mnt\/)[^\s<>"']+/g, '[path]')
    .replace(/\\\\[^\s<>"']+/g, '[path]')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/gi, '[local preview]');
}
export function envValues(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*(?:export\s+)?[A-Za-z_][\w]*\s*=\s*(.*?)\s*$/.exec(line)?.[1])
    .filter((s): s is string => !!s)
    .map((s) => s.replace(/^(['"])(.*)\1$/, '$2'))
    .filter((s) => s.length >= 4);
}
