/**
 * Local wall-clock time from an instant and an IANA zone name (Decision 7,
 * Decision 17). Always through Intl and the zone's rules, never a fixed
 * offset: `Europe/London` is +00:00 in winter and +01:00 in summer, and the
 * day it changes is 23 or 25 hours long.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function wallClock(instantMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/**
 * `2026-11-19T23:00:00.000Z` in `Asia/Ho_Chi_Minh` →
 * `2026-11-20T06:00:00+07:00`: the local date and time, with the offset the
 * zone had at that instant. Milliseconds are dropped (flights are minutes).
 */
export function toLocalIso(instant: string, timeZone: string): string {
  const instantMs = Date.parse(instant);
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000;
  const local = wallClock(wholeSecondMs, timeZone);
  const asIfUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const offsetMinutes = Math.round((asIfUtc - wholeSecondMs) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);

  return (
    `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}` +
    `T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/** The local calendar date (`YYYY-MM-DD`) of an instant in a zone. */
export function localDateOf(instant: string, timeZone: string): string {
  const local = wallClock(Date.parse(instant), timeZone);
  return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}`;
}

/**
 * How many local dates the arrival is after the departure, each in its own
 * airport's zone: `1` for 23:00 → 05:00, `0` for a same-day flight, `-1`
 * for a westbound hop that lands on the previous local date.
 */
export function arrivalDayOffset(
  departureAt: string,
  departureTimeZone: string,
  arrivalAt: string,
  arrivalTimeZone: string,
): number {
  const days = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  return days(localDateOf(arrivalAt, arrivalTimeZone)) - days(localDateOf(departureAt, departureTimeZone));
}
