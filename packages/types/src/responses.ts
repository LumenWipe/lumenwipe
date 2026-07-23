import type { ConversionPath } from "./plan";

/** Response from `POST /v1/:network/submit`. */
export interface SubmitResponse {
  status: "success";
  hash: string;
  ledger: number;
}

/** Response from `GET /:network/paths`. */
export interface PathResponse {
  path: ConversionPath | null;
}

/** Response from `POST /:network/mediator/sign`. */
export interface MediatorSignResponse {
  transaction: string;
}

/** Response from `GET /health`. */
export interface HealthResponse {
  status: string;
}
