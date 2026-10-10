import type { LoggerService } from "@nestjs/common";
import { scrubValue } from "./log-privacy";
import { currentRequestId, currentSensitiveLiterals } from "./request-context";

type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/**
 * One JSON object per line on stdout, which Cloud Run forwards to Cloud Logging. `severity` is
 * the field Cloud Logging reads to classify an entry; `message` becomes its text.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = defaultWrite) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit("INFO", message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit("WARNING", message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit("ERROR", message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit("CRITICAL", message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit("DEBUG", message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit("DEBUG", message, params);
  }

  private emit(severity: Severity, message: unknown, params: unknown[]): void {
    const strings = params.filter((p): p is string => typeof p === "string");
    const isFailure = severity === "ERROR" || severity === "CRITICAL";
    // Nest appends the logger's context last; a failure may carry a stack before it.
    const hasStack = isFailure && (strings.length > 1 || strings[0]?.includes("\n") === true);
    const stack = hasStack ? strings[0] : undefined;
    const context = hasStack && strings.length === 1 ? undefined : strings[strings.length - 1];

    let text: string;
    let stackText = stack;
    let fields: Record<string, unknown> = {};
    let trusted = false;
    if (message instanceof Error) {
      text = message.message;
      stackText = stack ?? message.stack;
    } else if (typeof message === "object" && message !== null) {
      const { message: inner, ...rest } = message as Record<string, unknown>;
      text = typeof inner === "string" ? inner : "";
      fields = rest;
      trusted = true;
    } else {
      text = String(message);
    }

    // A structured record is written by our own code (the access line), so it keeps its values;
    // free text and stacks can carry what a request supplied and lose the request's memo.
    const literals = [...currentSensitiveLiterals()];
    const body = {
      ...(scrubValue(fields, []) as Record<string, unknown>),
      message: scrubValue(text, trusted ? [] : literals),
      context,
      stack: scrubValue(stackText, literals),
    };
    this.write(
      JSON.stringify({
        ...body,
        severity,
        time: new Date().toISOString(),
        requestId: currentRequestId(),
      })
    );
  }
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}
