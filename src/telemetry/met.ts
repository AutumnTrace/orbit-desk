// Mission elapsed time. Packets carry it as whole milliseconds; people read it as MM:SS.mmm.

export function formatMet(ms: number, withMillis = true): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(Math.round(ms));
  const minutes = Math.floor(abs / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  const millis = abs % 1000;
  const base = `${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return withMillis ? `${base}.${String(millis).padStart(3, '0')}` : base;
}

// Accepts 04:18, 04:18.25, 4:18.250 or plain seconds (258.25).
export function parseMet(text: string): number | null {
  const m = /^(\d{1,3}):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (m) {
    const millis = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
    return Number(m[1]) * 60000 + Number(m[2]) * 1000 + millis;
  }
  const seconds = Number(text);
  return Number.isFinite(seconds) && text.trim() !== '' ? Math.round(seconds * 1000) : null;
}
