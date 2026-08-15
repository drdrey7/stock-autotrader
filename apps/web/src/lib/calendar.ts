// Date.getDay() returns 0 = Sunday, but the calendar grid is Monday-first (Monday = 0 … Sunday = 6).
export const mondayBasedWeekday = (date: Date) => (date.getDay() + 6) % 7;

export function monthDays(month: number, year: number) {
  const first = new Date(year, month, 1); const days = new Date(year, month + 1, 0).getDate();
  const leadingEmpty = mondayBasedWeekday(first);
  const cells: Array<number | null> = [...Array(leadingEmpty).fill(null), ...Array.from({length: days}, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return cells;
}
