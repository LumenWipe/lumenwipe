import type { ErrorCode } from "@lumenwipe/types";
import { expect, test } from "bun:test";
import { codeForStatus } from "@/common/error-envelope.filter";

test.each<[number, ErrorCode]>([
  [400, "bad_request"],
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [413, "payload_too_large"],
  [415, "unsupported_media_type"],
  [422, "unprocessable_entity"],
  [429, "rate_limited"],
  [503, "service_unavailable"],
  [500, "internal_error"],
  [409, "request_failed"],
])("codeForStatus(%d) is %s", (status, code) => {
  expect(codeForStatus(status)).toBe(code);
});
