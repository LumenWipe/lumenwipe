import { afterEach, expect, spyOn, test } from "bun:test";
import { requestMediatorCosignature } from "@/lib/stellar/mediator";
import { ApiRequestError } from "@/lib/utils/user-error";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => fetchSpy?.mockRestore());

test("posts the user-signed envelope to the network's co-sign route and returns the co-signed one", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(json({ transaction: "CO-SIGNED" }));
  expect(await requestMediatorCosignature("USER-SIGNED", "testnet")).toBe("CO-SIGNED");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0]!;
  expect(url).toBe("/api/testnet/mediator/sign");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(init?.body))).toEqual({ transaction: "USER-SIGNED" });
});

test("a refused co-signature throws the API's error and returns no envelope", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    json({ error: { code: "mediator_refused", message: "The relay step was refused." } }, 422)
  );
  const error = await requestMediatorCosignature("USER-SIGNED", "mainnet").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiRequestError);
  expect(error).toMatchObject({ status: 422, code: "mediator_refused" });
  expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/mainnet/mediator/sign");
});
