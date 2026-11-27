import { writeFileSync } from "node:fs";
import { UpstreamError } from "@/lib/stellar/upstream-client";

export type ReadStatus = "finding" | "incomplete";

/**
 * A read with no answer to judge: an outage the RPC client typed, or a request that never got a
 * response (refused connection, DNS failure, reset). An HTTP error the client did not type is the
 * provider's answer, as in `rpcFailureKind`.
 */
function isUnanswered(error: unknown): boolean {
  if (error instanceof UpstreamError) return true;
  const transport = error as { isAxiosError?: unknown; response?: unknown } | null;
  return transport?.isAxiosError === true && transport.response === undefined;
}

/**
 * How a monitor's tests failed, for the workflow step that runs them: `finding` when something
 * read from the ledger was wrong, `incomplete` when the only failures were reads the provider did
 * not answer. A finding wins, so an outage in one test never hides a mismatch in another.
 */
export class ReadStatusRecorder {
  private findings = 0;
  private unread = 0;

  finding(): void {
    this.findings++;
  }

  /** A read that got no answer is unread; any other failure is a finding. */
  record(error: unknown): void {
    if (isUnanswered(error)) this.unread++;
    else this.findings++;
  }

  /** Runs a test body, recording why it failed before failing it the same way. */
  watch(body: () => Promise<void>): () => Promise<void> {
    return async () => {
      try {
        await body();
      } catch (error) {
        this.record(error);
        throw error;
      }
    };
  }

  status(): ReadStatus | null {
    if (this.findings > 0) return "finding";
    return this.unread > 0 ? "incomplete" : null;
  }

  /** Writes the status to `path`; nothing when every test passed or no path was given. */
  write(path: string | undefined): void {
    const status = this.status();
    if (path && status) writeFileSync(path, status);
  }
}
