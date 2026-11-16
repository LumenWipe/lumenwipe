import { Controller, Get, Header } from "@nestjs/common";
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  type ApiResponseCommonMetadata,
} from "@nestjs/swagger";
import { Public } from "./auth/public.decorator";
import { API_CATALOG, API_CATALOG_CONTENT_TYPE, type ApiCatalog } from "./common/discovery-links";

const LINKSET_CONTENT: ApiResponseCommonMetadata["content"] = {
  "application/linkset+json": {
    schema: {
      type: "object",
      required: ["linkset"],
      properties: {
        linkset: {
          type: "array",
          items: {
            type: "object",
            required: ["anchor"],
            properties: { anchor: { type: "string" } },
            additionalProperties: {
              type: "array",
              items: {
                type: "object",
                required: ["href"],
                properties: { href: { type: "string" }, type: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};

@ApiTags("service")
@Controller(".well-known")
export class WellKnownController {
  // Public and unthrottled like `/`: a static description a client reads before it has a key.
  @Public()
  @Get("api-catalog")
  @Header("Content-Type", API_CATALOG_CONTENT_TYPE)
  @ApiOperation({ summary: "API catalog (RFC 9727, public, no API key)." })
  @ApiResponse({
    status: 200,
    description: "A linkset naming the OpenAPI document, the documentation and the status check.",
    content: LINKSET_CONTENT,
  })
  apiCatalog(): ApiCatalog {
    return API_CATALOG;
  }
}
