import "./env";
import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { configureApp } from "./configure-app";
import { buildOpenApiConfig } from "./openapi";
import { checkEnv, formatEnvFailure } from "./config/validate-env";
import { deprecatedEnvWarnings } from "./config/networks";

async function bootstrap(): Promise<void> {
  // Before Nest builds anything. A service that starts without its configuration and fails
  // per-request is worse than one that refuses to start: the deploy goes green, the instance
  // looks healthy, and users meet the problem one at a time.
  const { problems, warnings } = checkEnv();
  if (problems.length > 0) {
    console.error(formatEnvFailure(problems));
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const bootLogger = new Logger("bootstrap");
  // Logged, not fatal: each of these disables a path rather than the service, and the operator
  // should learn it here rather than from a user hitting the disabled path.
  for (const w of warnings) bootLogger.warn(w.message);
  for (const w of deprecatedEnvWarnings) bootLogger.warn(w);
  configureApp(app);

  // Deliberately reachable without an API key (#59): the schema itself carries no secret or
  // per-account data - it is a description of shapes, not a response - and an integrator needs
  // to see the API before they have a key to call it with. `/docs`/`/docs-json` are also outside
  // Nest's own routing entirely (SwaggerModule mounts them directly on the underlying HTTP
  // adapter), so `ApiKeyGuard`'s `@Public()` mechanism could not gate them even if this called
  // for it - a deliberate choice, not the guard failing to apply.
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  SwaggerModule.setup("docs", app, document);

  // Fire NestJS shutdown hooks on SIGTERM (Cloud Run sends it with a ~10s grace window on scale-down).
  app.enableShutdownHooks();

  // Cloud Run injects PORT and requires binding to 0.0.0.0 (not 127.0.0.1).
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
