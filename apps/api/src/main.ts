import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { configureApp } from "./configure-app";
import { buildOpenApiConfig } from "./openapi";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app);

  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  SwaggerModule.setup("docs", app, document);

  // Fire NestJS shutdown hooks on SIGTERM (Cloud Run sends it with a ~10s grace window on scale-down).
  app.enableShutdownHooks();

  // Cloud Run injects PORT and requires binding to 0.0.0.0 (not 127.0.0.1).
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
