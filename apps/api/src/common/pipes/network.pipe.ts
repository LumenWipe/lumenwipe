import type { PipeTransform } from "@nestjs/common";
import { isValidNetwork, type Network } from "@/config/networks";
import { fail } from "@/common/fail";

/** Message wording differs between controllers and is part of the byte-stable contract. */
export class NetworkPipe implements PipeTransform<string, Network> {
  constructor(private readonly message = "Invalid network.") {}

  transform(value: string): Network {
    if (!isValidNetwork(value)) fail("invalid_network", this.message, 400);
    return value;
  }
}
