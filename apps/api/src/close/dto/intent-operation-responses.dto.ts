import { ApiProperty, getSchemaPath } from "@nestjs/swagger";
import type { AccountSigner, SubInvocationCall } from "@lumenwipe/types";
import { AccountSignerDto } from "../../account/dto/account-state-response.dto";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).
//
// IntentOperation = IntentOperationBody & { source: string } (close-api.ts) - a genuine
// discriminated union (11 variants, clean single-field discriminator on `type`, unlike
// DefiPosition's compound key) plus one field, `source`, common to every variant. Modeled as a
// real discriminated oneOf: each variant DTO carries `source` directly (there's no shared named
// interface in the source to extend - the union members are plain object literals - so the
// common field is just repeated once per class rather than factored through inheritance, same
// cost either way at one line per class).

export class SubInvocationCallDto implements SubInvocationCall {
  @ApiProperty()
  contract!: string;

  @ApiProperty()
  function!: string;

  @ApiProperty({
    description: "The decoded arguments rendered for a human, in order.",
    type: [String],
  })
  args!: string[];
}

export class PathPaymentStrictSendOpDto {
  @ApiProperty({ enum: ["path_payment_strict_send"] })
  type!: "path_payment_strict_send";

  @ApiProperty()
  source!: string;

  @ApiProperty()
  sendAsset!: string;

  @ApiProperty()
  sendAmount!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty()
  destAsset!: string;

  @ApiProperty()
  destMin!: string;

  @ApiProperty({ type: [String] })
  path!: string[];
}

export class PaymentOpDto {
  @ApiProperty({ enum: ["payment"] })
  type!: "payment";

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;

  @ApiProperty({ description: '"CODE:ISSUER" or "native".' })
  asset!: string;

  @ApiProperty()
  amount!: string;
}

export class ChangeTrustOpDto {
  @ApiProperty({ enum: ["change_trust"] })
  type!: "change_trust";

  @ApiProperty()
  source!: string;

  @ApiProperty()
  asset!: string;

  @ApiProperty({ description: '"0" removes the trustline.' })
  limit!: string;
}

export class AccountMergeOpDto {
  @ApiProperty({ enum: ["account_merge"] })
  type!: "account_merge";

  @ApiProperty()
  source!: string;

  @ApiProperty()
  destination!: string;
}

export class ManageSellOfferOpDto {
  @ApiProperty({ enum: ["manage_sell_offer"] })
  type!: "manage_sell_offer";

  @ApiProperty()
  source!: string;

  @ApiProperty({ description: '"0" cancels the offer.' })
  offerId!: string;

  @ApiProperty()
  amount!: string;
}

export class ManageDataOpDto {
  @ApiProperty({ enum: ["manage_data"] })
  type!: "manage_data";

  @ApiProperty()
  source!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    description: "Base64-encoded, or null to remove the entry.",
    type: "string",
    nullable: true,
  })
  value!: string | null;
}

export class SetOptionsOpDto {
  @ApiProperty({ enum: ["set_options"] })
  type!: "set_options";

  @ApiProperty()
  source!: string;

  @ApiProperty({
    description:
      "The signer this op touches, decoded to its real type/key. Null when the op only " +
      "touches thresholds/master weight and carries no signer field.",
    type: AccountSignerDto,
    nullable: true,
  })
  signer!: AccountSigner | null;

  @ApiProperty({ type: "integer", nullable: true })
  masterWeight!: number | null;

  @ApiProperty({ type: "integer", nullable: true })
  lowThreshold!: number | null;

  @ApiProperty({ type: "integer", nullable: true })
  medThreshold!: number | null;

  @ApiProperty({ type: "integer", nullable: true })
  highThreshold!: number | null;

  @ApiProperty({
    description:
      "The close flow's own normalization never legitimately sets this - carried through so verify() can reject an op that does.",
    type: "string",
    nullable: true,
  })
  homeDomain!: string | null;

  @ApiProperty({ type: "integer", nullable: true })
  setFlags!: number | null;

  @ApiProperty({ type: "integer", nullable: true })
  clearFlags!: number | null;

  @ApiProperty({ type: "string", nullable: true })
  inflationDest!: string | null;
}

export class ClaimClaimableBalanceOpDto {
  @ApiProperty({ enum: ["claim_claimable_balance"] })
  type!: "claim_claimable_balance";

  @ApiProperty()
  source!: string;

  @ApiProperty()
  balanceId!: string;
}

export class RevokeSponsorshipOpDto {
  @ApiProperty({ enum: ["revoke_sponsorship"] })
  type!: "revoke_sponsorship";

  @ApiProperty()
  source!: string;

  @ApiProperty({ enum: ["account", "trustline", "offer", "data_entry", "signer"] })
  entryKind!: "account" | "trustline" | "offer" | "data_entry" | "signer";

  @ApiProperty()
  owner!: string;
}

export class InvokeHostFunctionOpDto {
  @ApiProperty({ enum: ["invoke_host_function"] })
  type!: "invoke_host_function";

  @ApiProperty()
  source!: string;

  @ApiProperty()
  contract!: string;

  @ApiProperty()
  function!: string;

  @ApiProperty({
    description: "The decoded arguments rendered for a human, in order.",
    type: [String],
  })
  args!: string[];

  @ApiProperty({
    description:
      "Every Stellar account (G...) named anywhere in the arguments or the authorization tree. " +
      "A verifier insists these are all the closing account.",
    type: [String],
  })
  accountsReferenced!: string[];

  @ApiProperty({
    description: "Every contract (C...) named the same way, including authorized nested calls.",
    type: [String],
  })
  contractsReferenced!: string[];

  @ApiProperty({
    description:
      "Address forms that cannot be pinned to anything (muxed, claimable balance, LP). A verifier refuses any.",
  })
  unsupportedAddressCount!: number;

  @ApiProperty({
    description:
      "True when the signature authorizes more than the account's own plain contract calls.",
  })
  authorizesBeyondSelf!: boolean;

  @ApiProperty({
    description: "How deep the authorization tree nests. A token transfer must be 0.",
  })
  authDepth!: number;

  @ApiProperty({
    description:
      "Every non-root call in the authorization tree, one level down from the root call.",
    type: [SubInvocationCallDto],
  })
  subInvocations!: SubInvocationCall[];
}

export class UnknownOpDto {
  @ApiProperty({ enum: ["unknown"] })
  type!: "unknown";

  @ApiProperty()
  source!: string;
}

// Paired with the real `type` literal explicitly, not read off an instance - the same class of
// bug the SponsoredEntry discriminator had (account-state-response.dto.ts): these fields carry
// no runtime initializer behind `!`, so `new SomeOpDto().type` would read back `undefined`.
export const INTENT_OPERATION_MODELS = [
  { type: "path_payment_strict_send", model: PathPaymentStrictSendOpDto },
  { type: "payment", model: PaymentOpDto },
  { type: "change_trust", model: ChangeTrustOpDto },
  { type: "account_merge", model: AccountMergeOpDto },
  { type: "manage_sell_offer", model: ManageSellOfferOpDto },
  { type: "manage_data", model: ManageDataOpDto },
  { type: "set_options", model: SetOptionsOpDto },
  { type: "claim_claimable_balance", model: ClaimClaimableBalanceOpDto },
  { type: "revoke_sponsorship", model: RevokeSponsorshipOpDto },
  { type: "invoke_host_function", model: InvokeHostFunctionOpDto },
  { type: "unknown", model: UnknownOpDto },
] as const;

export function intentOperationSchema() {
  return {
    oneOf: INTENT_OPERATION_MODELS.map(({ model }) => ({ $ref: getSchemaPath(model) })),
    discriminator: {
      propertyName: "type",
      mapping: Object.fromEntries(
        INTENT_OPERATION_MODELS.map(({ type, model }) => [type, getSchemaPath(model)])
      ),
    },
  };
}

export const INTENT_OPERATION_EXTRA_MODELS = INTENT_OPERATION_MODELS.map(({ model }) => model);
