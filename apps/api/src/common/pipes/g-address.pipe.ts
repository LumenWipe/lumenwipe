import type { PipeTransform } from "@nestjs/common";
import type { ErrorCode } from "@lumenwipe/types";
import { requireGAddress } from "@/common/require-g-address";

export class GAddressPipe implements PipeTransform<string, string> {
  constructor(
    private readonly code: ErrorCode,
    private readonly message: string
  ) {}

  transform(value: string): string {
    requireGAddress(value, this.code, this.message);
    return value;
  }
}
