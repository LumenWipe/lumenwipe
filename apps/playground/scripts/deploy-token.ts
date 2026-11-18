// Creates and initializes the playground token on testnet once, or checks it and extends its TTL
// on any later run (lib/token-deploy.ts). Signs only with the pinned admin's key, read from the
// environment, and prints only the token's contract id.
//
//   PLAYGROUND_TOKEN_ADMIN_SECRET_TESTNET=... bun run token:deploy
import { PLAYGROUND_TOKEN } from "../lib/scenarios";
import {
  ensureToken,
  TOKEN_ADMIN_SECRET_ENV,
  tokenAdminKeypair,
  TokenDeployError,
} from "../lib/token-deploy";

const admin = tokenAdminKeypair(process.env[TOKEN_ADMIN_SECRET_ENV]);
if (!admin) {
  console.error(
    "Refused: %s must hold the secret key of the pinned admin, %s.",
    TOKEN_ADMIN_SECRET_ENV,
    PLAYGROUND_TOKEN.admin
  );
  process.exit(1);
}

try {
  console.log(await ensureToken(admin));
} catch (err) {
  console.error(
    "The token was not deployed: %s",
    err instanceof TokenDeployError ? err.message : String(err)
  );
  process.exit(1);
}
