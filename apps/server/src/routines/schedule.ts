import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { RoutineSchedule, RoutineWeekday } from "./types.ts";

export class RoutineScheduleError extends Schema.TaggedErrorClass<RoutineScheduleError>()(
  "RoutineScheduleError",
  { detail: Schema.String },
) {}

const parseTime = (time: string): readonly [hour: number, minute: number] => {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(time);
  if (match === null) throw new RoutineScheduleError({ detail: `Invalid routine time: ${time}` });
  return [Number(time.slice(0, 2)), Number(time.slice(3, 5))];
};

const matchesDay = (schedule: RoutineSchedule, weekDay: number) => {
  switch (schedule.kind) {
    case "daily":
      return true;
    case "weekdays":
      return weekDay >= 1 && weekDay <= 5;
    case "weekly":
      return schedule.weekdays.includes(weekdays[weekDay]!);
  }
};

const weekdays: ReadonlyArray<RoutineWeekday> = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const candidateForDay = (
  day: DateTime.Zoned,
  schedule: RoutineSchedule,
  timezone: string,
): DateTime.Zoned => {
  const [hour, minute] = parseTime(schedule.time);
  const parts = DateTime.toParts(day);
  const candidate = DateTime.makeZoned(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour,
      minute,
    },
    { timeZone: timezone, adjustForTimeZone: true },
  );
  if (Option.isNone(candidate)) {
    throw new RoutineScheduleError({ detail: `Invalid routine timezone: ${timezone}` });
  }
  return candidate.value;
};

export const latestScheduledFor = (
  schedule: RoutineSchedule,
  timezone: string,
  nowEpochMillis: number,
): string => {
  const now = DateTime.makeZoned(nowEpochMillis, { timeZone: timezone });
  if (Option.isNone(now)) {
    throw new RoutineScheduleError({ detail: `Invalid routine timezone: ${timezone}` });
  }

  for (let daysBack = 0; daysBack <= 7; daysBack += 1) {
    const day = DateTime.subtract(now.value, { days: daysBack });
    if (!matchesDay(schedule, DateTime.toParts(day).weekDay)) continue;
    const candidate = candidateForDay(day, schedule, timezone);
    if (DateTime.toEpochMillis(candidate) <= nowEpochMillis) return DateTime.formatIso(candidate);
  }

  throw new RoutineScheduleError({ detail: "Routine schedule has no matching day." });
};

export const nextScheduledFor = (
  schedule: RoutineSchedule,
  timezone: string,
  afterEpochMillis: number,
): string => {
  const after = DateTime.makeZoned(afterEpochMillis, { timeZone: timezone });
  if (Option.isNone(after)) {
    throw new RoutineScheduleError({ detail: `Invalid routine timezone: ${timezone}` });
  }

  for (let daysAhead = 0; daysAhead <= 7; daysAhead += 1) {
    const day = DateTime.add(after.value, { days: daysAhead });
    if (!matchesDay(schedule, DateTime.toParts(day).weekDay)) continue;
    const candidate = candidateForDay(day, schedule, timezone);
    if (DateTime.toEpochMillis(candidate) > afterEpochMillis) return DateTime.formatIso(candidate);
  }

  throw new RoutineScheduleError({ detail: "Routine schedule has no matching day." });
};
