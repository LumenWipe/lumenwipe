import { describe, expect, test } from "bun:test";
import { secondsUntilNextUtcDay, utcDayKey } from "@/lib/utc-day";

describe("secondsUntilNextUtcDay", () => {
  test.each([
    ["2026-11-08T00:00:00.000Z", 86_400],
    ["2026-11-08T00:00:00.001Z", 86_400],
    ["2026-11-08T12:00:00.000Z", 43_200],
    ["2026-11-08T23:59:58.500Z", 2],
    ["2026-11-08T23:59:59.000Z", 1],
    ["2026-11-08T23:59:59.999Z", 1],
    ["2026-12-31T23:59:00.000Z", 60],
    ["2028-02-28T23:00:00.000Z", 3_600],
    ["2028-02-29T23:59:30.000Z", 30],
  ])("at %s it is %d", (instant, seconds) => {
    expect(secondsUntilNextUtcDay(new Date(instant))).toBe(seconds);
  });
});

describe("utcDayKey", () => {
  test("changes exactly at 00:00 UTC", () => {
    expect(utcDayKey(new Date("2026-11-08T23:59:59.999Z"))).toBe("2026-11-08");
    expect(utcDayKey(new Date("2026-11-09T00:00:00.000Z"))).toBe("2026-11-09");
    expect(utcDayKey(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-31");
    expect(utcDayKey(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01-01");
  });

  test("does not follow a local time zone", () => {
    // 2026-11-08T23:30 in UTC-10 is already the 9th in UTC.
    const instant = new Date(Date.UTC(2026, 10, 9, 9, 30));
    expect(utcDayKey(instant)).toBe("2026-11-09");
    expect(secondsUntilNextUtcDay(instant)).toBe(14.5 * 3_600);
  });
});
