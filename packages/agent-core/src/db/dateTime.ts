/**
 * SQLite's datetime('now') stores UTC wall-clock strings with no zone
 * marker ('YYYY-MM-DD HH:MM:SS'), which V8's Date parser treats as LOCAL
 * time — shifting relative-time displays by the host's UTC offset (a
 * freshly created thread showed "8 hours ago" in UTC+8). Normalize to an
 * explicit UTC ISO string at the read boundary. Stores that already write
 * toISOString() (with 'T' and 'Z') pass through unchanged.
 */
export function normalizeUtcDateTime(value: string): string {
  if (!value.includes('T')) {
    return value.replace(' ', 'T') + 'Z';
  }
  return value;
}
