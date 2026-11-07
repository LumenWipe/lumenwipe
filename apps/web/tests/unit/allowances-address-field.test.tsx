import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Suspense } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as navigation from "next/navigation";
import AllowancesPage from "@/app/[network]/allowances/page";
import { useDemolishStore } from "@/store/demolish";

// Synthetic: the shape of a secret seed with a checksum that does not match, never a real key.
const SECRET_SHAPED = "S" + "A".repeat(55);

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  useDemolishStore.getState().reset();
  spyOn(navigation, "useRouter").mockReturnValue({ push: mock(() => {}) } as never);
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => mock.restore());

async function renderPage(query = ""): Promise<HTMLInputElement> {
  spyOn(navigation, "useSearchParams").mockReturnValue(new URLSearchParams(query) as never);
  const params = Promise.resolve({ network: "testnet" as const });
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <AllowancesPage params={params} />
      </Suspense>
    );
  });
  return screen.getByRole("textbox", { name: "Account to inspect" }) as HTMLInputElement;
}

test("the inspector refuses a pasted secret key and looks nothing up", async () => {
  const input = await renderPage();

  fireEvent.paste(input, { clipboardData: { getData: () => SECRET_SHAPED } });
  fireEvent.change(input, { target: { value: SECRET_SHAPED } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
  });

  expect(input.value).toBe("");
  expect(document.body.innerHTML).not.toContain(SECRET_SHAPED);
  expect(document.body.textContent).toContain("That looks like a secret key.");
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a secret key in the link is not put in the field", async () => {
  const input = await renderPage(`address=${SECRET_SHAPED}`);
  expect(input.value).toBe("");
  expect(document.body.innerHTML).not.toContain(SECRET_SHAPED);
  expect(fetchSpy).not.toHaveBeenCalled();
});
