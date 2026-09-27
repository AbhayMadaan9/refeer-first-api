import { DateTime } from 'luxon';

export function localJobDate(timezone: string, instant = new Date()): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate()!;
}

export function localDayKeyToUtcDate(day: string): Date {
  return DateTime.fromISO(`${day}T12:00:00.000Z`, { zone: 'utc' }).toJSDate();
}

export function localDayEnd(timezone: string, instant = new Date()): Date {
  return DateTime.fromJSDate(instant, { zone: timezone }).plus({ days: 1 }).startOf('day').toUTC().toJSDate();
}

export function scheduleSameDay(instant: Date, hours: number, timezone: string): Date | null {
  const scheduledAt = new Date(instant.getTime() + hours * 60 * 60 * 1000);
  const endOfDay = localDayEnd(timezone, instant);
  if (scheduledAt <= instant || scheduledAt >= endOfDay) return null;
  return scheduledAt;
}
