import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Validates integrator API keys against the manually-provisioned set.
 *
 * Keys are configured via the `API_KEYS` env var as comma-separated
 * `label=key` pairs, e.g. `lumenwipe-web=key_abc,polar=key_xyz`. The label is
 * the integrator identity used for metering. Self-serve key issuance and
 * billing are deferred (demand-driven); provisioning is manual for now.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private readonly keyToLabel = new Map<string, string>();

  constructor(config: ConfigService) {
    const raw = config.get<string>("API_KEYS") ?? "";
    for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const label = pair.slice(0, eq).trim();
      const key = pair.slice(eq + 1).trim();
      if (label && key) this.keyToLabel.set(key, label);
    }
    if (this.keyToLabel.size === 0) {
      this.logger.warn("No API_KEYS configured - every authenticated route will reject requests.");
    }
  }

  /** Returns the integrator label for a key, or null if the key is unknown. */
  resolve(key: string): string | null {
    return this.keyToLabel.get(key) ?? null;
  }
}
