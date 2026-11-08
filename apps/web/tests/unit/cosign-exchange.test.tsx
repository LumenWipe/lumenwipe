import { expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import CosignExchange from "@/components/execution/CosignExchange";
import type { CosignStatus } from "@/hooks/useCloseExecution";
import { COSIGN_UNAVAILABLE } from "@/lib/cosign/merge";
import { IMPORT_FLOOR_SECONDS } from "@/lib/cosign/station-checks";

const HASH = "0123456789abcdef".repeat(4);
const now = (): number => Math.floor(Date.now() / 1000);

function status(overrides: Partial<CosignStatus> = {}, maxTime = now() + 200): CosignStatus {
  return {
    export: { available: true, request: '{"format":"lumenwipe-cosign"}', hash: HASH, maxTime },
    collectedWeight: 1,
    ready: false,
    ...overrides,
  };
}

function renderExchange(given: CosignStatus, onImport = mock(() => null as string | null)) {
  const onContinue = mock(() => {});
  const onRebuild = mock(() => {});
  render(
    <CosignExchange
      status={given}
      requiredWeight={3}
      onImport={onImport}
      onContinue={onContinue}
      onRebuild={onRebuild}
      canRebuild
      disabled={false}
    />
  );
  return { onImport, onContinue, onRebuild };
}

test("shows the fingerprint and the exact origin as text, never as a link", () => {
  renderExchange(status());
  expect(screen.getByTestId("cosign-fingerprint").textContent).toBe("01234567 89abcdef");
  expect(screen.getByText(`${window.location.origin}/cosign`).tagName).toBe("SPAN");
  expect(document.querySelector("a[href]")).toBeNull();
  expect(screen.getByText("1 of 3 signing weight collected.")).toBeTruthy();
});

test("passes a pasted response on and shows why it was refused", () => {
  const { onImport } = renderExchange(
    status(),
    mock(() => "This response is for another transaction.")
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Or paste a response" }), {
    target: { value: "{}" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add response" }));
  expect(onImport).toHaveBeenCalledWith("{}");
  expect(screen.getByText("This response is for another transaction.")).toBeTruthy();
});

test("offers to continue only once the set is ready", () => {
  const { onContinue } = renderExchange(status({ collectedWeight: 3, ready: true }));
  fireEvent.click(screen.getByRole("button", { name: "Continue the close" }));
  expect(onContinue).toHaveBeenCalledTimes(1);
});

test("offers a rebuild instead of the export once too little time is left", () => {
  const { onRebuild } = renderExchange(status({}, now() + IMPORT_FLOOR_SECONDS - 1));
  expect(screen.queryByRole("button", { name: "Save request file" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Rebuild and re-export" }));
  expect(onRebuild).toHaveBeenCalledTimes(1);
});

test("stays hidden for a step that is not the signer normalization", () => {
  renderExchange(
    status({ export: { available: false, reason: COSIGN_UNAVAILABLE.notNormalization } })
  );
  expect(screen.queryByTestId("cosign-exchange")).toBeNull();
});
