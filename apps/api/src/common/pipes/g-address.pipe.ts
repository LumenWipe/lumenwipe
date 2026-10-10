import type { PipeTransform } from "@nestjs/common";
import type { ErrorCode } from "@lumenwipe/types";
import { isValidGAddress } from "@/lib/utils/validation";
import { fail } from "@/common/fail";

export class GAddressPipe implements PipeTransform<string, string> {
  constructor(
    private readonly code: ErrorCode,
    private readonly message: string
  ) {}

  transform(value: string): string {
    if (!isValidGAddress(value)) fail(this.code, this.message, 400);
    return value;
  }
}
