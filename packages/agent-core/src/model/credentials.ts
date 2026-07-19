/** Check presence without ever returning or logging the credential itself. */
export function isModelCredentialConfigured(value: string | null | undefined): boolean {
  const normalized = value?.trim();
  return Boolean(
    normalized &&
    normalized !== 'your-api-key' &&
    normalized !== 'sk-your-api-key' &&
    normalized !== 'sk-ant-your-api-key'
  );
}

/** Remove URL credentials and redact sensitive query parameters before display. */
export function sanitizeModelEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of url.searchParams.keys()) {
      if (/(?:key|token|secret|auth)/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.split('?')[0];
  }
}
