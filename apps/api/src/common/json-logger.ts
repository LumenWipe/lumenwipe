import type { LoggerService } from "@nestjs/common";
import { scrubLogLine } from "./log-privacy";
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

    const fields: Record<string, unknown> = {};
    let text: string;
    if (message instanceof Error) {
      text = message.message;
      fields.stack = message.stack;
    } else if (typeof message === "object" && message !== null) {
      const { message: inner, ...rest } = message as Record<string, unknown>;
      text = typeof inner === "string" ? inner : "";
      Object.assign(fields, rest);
    } else {
      text = String(message);
    }
    if (stack !== undefined) fields.stack = stack;

    const line = JSON.stringify({
      ...fields,
      severity,
      time: new Date().toISOString(),
      message: text,
      context,
      requestId: currentRequestId(),
    });
    this.write(scrubLogLine(line, currentSensitiveLiterals()));
  }
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}
