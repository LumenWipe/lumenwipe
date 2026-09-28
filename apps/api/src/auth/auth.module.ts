import { Module } from "@nestjs/common";
import { ApiKeyService } from "./api-key.service";
import { ApiKeyDirectory } from "./api-key-directory";
import { API_KEY_STORE, createApiKeyStore, type ApiKeyStore } from "./api-key-store";

@Module({
  providers: [
    ApiKeyService,
    { provide: API_KEY_STORE, useFactory: createApiKeyStore },
    {
      provide: ApiKeyDirectory,
      useFactory: (staticKeys: ApiKeyService, store: ApiKeyStore) =>
        new ApiKeyDirectory(staticKeys, store),
      inject: [ApiKeyService, API_KEY_STORE],
    },
  ],
  exports: [ApiKeyService, API_KEY_STORE, ApiKeyDirectory],
})
export class AuthModule {}
