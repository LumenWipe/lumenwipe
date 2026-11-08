import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import {
  API_KEY_ENV,
  LabRefusal,
  assertOutsideCheckout,
  checkoutRoot,
  labHome,
  productionApiKey,
  readPrivateFile,
  withoutLabEnv,
} from "../src/home";

const root = checkoutRoot();
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lab-home-test-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writePrivate(path: string, text: string, mode = 0o600): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

describe("the lab folder", () => {
  test("is refused inside the checkout", () => {
    expect(() => labHome({ LUMENWIPE_LAB_HOME: join(root, "tools", "lab", ".lab") }, root)).toThrow(
      LabRefusal
    );
    expect(() => assertOutsideCheckout(root, "x", root)).toThrow(LabRefusal);
  });

  test("is refused when a symlink outside points back into the checkout", () => {
    const link = join(home, "link");
    symlinkSync(root, link);
    expect(() => assertOutsideCheckout(join(link, "results"), "x", root)).toThrow(LabRefusal);
  });

  test("is refused inside any other checkout or worktree", () => {
    mkdirSync(join(home, "other-repo", ".git"), { recursive: true });
    expect(() =>
      assertOutsideCheckout(join(home, "other-repo", "keys", "api-key"), "x", root)
    ).toThrow(LabRefusal);
  });

  test("is accepted outside the checkout", () => {
    expect(labHome({ LUMENWIPE_LAB_HOME: home }, root)).toBe(home);
  });
});

describe("the production API key", () => {
  test("comes from the environment first", () => {
    expect(productionApiKey({ [API_KEY_ENV]: " key-from-env " }, home, root)).toBe("key-from-env");
  });

  test("comes from keys/api-key when it is readable by its owner only", () => {
    writePrivate(join(home, "keys", "api-key"), "key-from-file\n");
    expect(productionApiKey({}, home, root)).toBe("key-from-file");
  });

  test("is refused when missing, so the production target never runs without one", () => {
    expect(() => productionApiKey({}, home, root)).toThrow(/needs an API key/);
  });

  test("is refused from a file others can read", () => {
    writePrivate(join(home, "keys", "api-key"), "key", 0o644);
    expect(() => productionApiKey({}, home, root)).toThrow(/readable by others/);
  });

  test("is refused from an empty file", () => {
    writePrivate(join(home, "keys", "api-key"), "  \n");
    expect(() => productionApiKey({}, home, root)).toThrow(/empty/);
  });

  test("is refused through a symlink, even to an owner-only file", () => {
    const target = join(home, "real-key");
    writePrivate(target, "key");
    mkdirSync(join(home, "keys"), { recursive: true });
    symlinkSync(target, join(home, "keys", "api-key"));
    expect(() => productionApiKey({}, home, root)).toThrow(/is a symlink/);
  });

  test("is refused when the path is not a regular file", () => {
    mkdirSync(join(home, "keys", "api-key"), { recursive: true });
    expect(() => productionApiKey({}, home, root)).toThrow(/not a regular file/);
  });

  test("is never read from inside the checkout", () => {
    expect(() =>
      readPrivateFile(join(root, "apps", "api", ".env.local"), "The key file", root)
    ).toThrow(/outside the repository checkout/);
  });
});

describe("config.json", () => {
  test("is optional and defaults to the production URL and public providers", () => {
    const config = loadConfig(home, root);
    expect(config.productionUrl).toBe("https://api.lumenwipe.com");
    expect(config.localEnv).toEqual({});
    expect(config.e2e).toBeUndefined();
  });

  test("is refused through a symlink", () => {
    writePrivate(join(home, "real-config.json"), "{}");
    symlinkSync(join(home, "real-config.json"), join(home, "config.json"));
    expect(() => loadConfig(home, root)).toThrow(/is a symlink/);
  });

  test("is refused when others can read it, since it can hold provider keys", () => {
    writePrivate(join(home, "config.json"), "{}", 0o640);
    expect(() => loadConfig(home, root)).toThrow(/readable by others/);
  });

  test("resolves the e2e secret file against the lab folder and needs https URLs", () => {
    writePrivate(
      join(home, "config.json"),
      JSON.stringify({ e2e: { sourceSecretFile: "keys/source.secret", destinations: [] } })
    );
    const config = loadConfig(home, root);
    expect(config.e2e?.sourceSecretFile).toBe(join(home, "keys", "source.secret"));
    expect(config.e2e?.horizon.mainnet).toBe("https://horizon.stellar.org");

    writePrivate(
      join(home, "config.json"),
      JSON.stringify({ productionUrl: "http://plain.example" })
    );
    expect(() => loadConfig(home, root)).toThrow(/https/);
  });
});

describe("helper commands", () => {
  test("never receive the lab's own variables", () => {
    expect(
      withoutLabEnv({ PATH: "/bin", [API_KEY_ENV]: "secret", LUMENWIPE_LAB_HOME: "/x" })
    ).toEqual({ PATH: "/bin" });
  });
});
