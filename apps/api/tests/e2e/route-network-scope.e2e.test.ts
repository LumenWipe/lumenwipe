import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AppModule } from "@/app.module";
import { IS_NETWORK_AGNOSTIC_KEY } from "@/auth/network-agnostic.decorator";
import { IS_PUBLIC_KEY } from "@/auth/public.decorator";

interface Route {
  path: string;
  networkInPath: boolean;
  isPublic: boolean;
  networkAgnostic: boolean;
}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

function routes(): Route[] {
  const reflector = new Reflector();
  const found: Route[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) continue;
      const base = [Reflect.getMetadata(PATH_METADATA, controller) as string | string[]].flat();
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== "function" || name === "constructor") continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        const sub = [Reflect.getMetadata(PATH_METADATA, handler) as string | string[]].flat();
        const flag = (key: string) =>
          reflector.getAllAndOverride<boolean>(key, [handler, controller]) === true;
        for (const b of base) {
          for (const s of sub) {
            const path = `/${[b, s].filter((p) => p && p !== "/").join("/")}`;
            found.push({
              path,
              networkInPath: path.split("/").includes(":network"),
              isPublic: flag(IS_PUBLIC_KEY),
              networkAgnostic: flag(IS_NETWORK_AGNOSTIC_KEY),
            });
          }
        }
      }
    }
  }
  return found;
}

test("the route walk sees the keyed network routes", () => {
  const paths = routes().map((r) => r.path);
  expect(paths).toContain("/v1/:network/account/:address");
  expect(paths).toContain("/v1/:network/close/plan");
  expect(paths).toContain("/v1/integrator/keys");
});

test("every keyed route without :network is explicitly network-agnostic", () => {
  const unscoped = routes().filter((r) => !r.networkInPath && !r.isPublic && !r.networkAgnostic);
  expect(unscoped.map((r) => r.path)).toEqual([]);
});

test("no route reads the network from the body or the query", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(join(import.meta.dir, "../../src"));
  const offenders = files.filter((file) =>
    /@(Query|Body)\(\s*["']network["']|(body|query)\??\.network\b|query\[\s*["']network["']\]/.test(
      readFileSync(file, "utf8")
    )
  );
  expect(offenders).toEqual([]);
});
