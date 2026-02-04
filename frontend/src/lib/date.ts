export function toYMD(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function todayRange() {
  const d = new Date();
  const from = toYMD(d);
  const to = toYMD(d); // inclusive
  return { from, to };
}
export function last15DaysRange() {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 15)

  const fmt = (d: Date) => d.toISOString().slice(0, 10) // YYYY-MM-DD
  return { from: fmt(from), to: fmt(to) }
}

