import { applyDecorators } from "@nestjs/common";
import { ApiExtraModels, ApiResponse, getSchemaPath } from "@nestjs/swagger";
import type { ErrorCode } from "@lumenwipe/types";
import { ErrorResponseDto } from "./dto/error-response.dto";

/**
 * Documents one error status of a route: the shared error envelope, with `error.code` narrowed to
 * the closed set of codes the route can return at that status. Works on a class or a method.
 */
export function ApiErrorResponse(
  status: number,
  description: string,
  codes: readonly ErrorCode[]
): ClassDecorator & MethodDecorator {
  return applyDecorators(
    ApiExtraModels(ErrorResponseDto),
    ApiResponse({
      status,
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ErrorResponseDto) },
          {
            type: "object",
            properties: {
              error: { type: "object", properties: { code: { type: "string", enum: [...codes] } } },
            },
          },
        ],
      },
    })
  );
}

/** Body-handling errors every route that reads a JSON body can return (see configure-app.ts). */
export function ApiBodyErrorResponses(): ClassDecorator & MethodDecorator {
  return applyDecorators(
    ApiErrorResponse(413, "The request body is larger than 100 KB.", ["payload_too_large"]),
    ApiErrorResponse(415, "The request body is not UTF-8 JSON.", ["unsupported_media_type"])
  );
}
