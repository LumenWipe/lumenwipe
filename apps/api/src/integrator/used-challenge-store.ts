import { createHash } from "crypto";
import { Timestamp, type Firestore } from "@google-cloud/firestore";
import { fail } from "@/common/fail";
import { createFirestore } from "@/config/firestore";
import { withTimeout } from "@/lib/utils/with-timeout";

export const USED_CHALLENGE_STORE = Symbol("USED_CHALLENGE_STORE");

const STORE_TIMEOUT_MS = 5_000;
const STORE_TIMEOUT_MESSAGE = "used challenge store timed out";
/** gRPC `ALREADY_EXISTS`, what Firestore answers a `create` of a document that exists. */
const ALREADY_EXISTS = 6;

/**
 * Records that a sign-in challenge was exchanged, so it can be exchanged once only. A challenge is
 * named by any string that identifies it; only its SHA-256 is stored.
 */
export interface UsedChallengeStore {
  /** True the first time `challenge` is claimed, false on every later claim before `expiresAt`. */
  claim(challenge: string, expiresAt: Date): Promise<boolean>;
}

const idOf = (challenge: string): string => createHash("sha256").update(challenge).digest("hex");

/**
 * One document per claimed challenge, keyed by the hash of the challenge, written with `create` so
 * two concurrent claims cannot both succeed. `expireAt` is the field a Firestore TTL policy deletes
 * on; a document outliving it changes nothing, because an expired challenge is refused before it
 * is claimed.
 */
export class FirestoreUsedChallengeStore implements UsedChallengeStore {
  private readonly collection: FirebaseFirestore.CollectionReference;

  constructor(
    firestore: Firestore,
    collectionName = "usedChallenges",
    private readonly timeoutMs = STORE_TIMEOUT_MS
  ) {
    this.collection = firestore.collection(collectionName);
  }

  async claim(challenge: string, expiresAt: Date): Promise<boolean> {
    try {
      await withTimeout(
        this.collection.doc(idOf(challenge)).create({ expireAt: Timestamp.fromDate(expiresAt) }),
        this.timeoutMs,
        STORE_TIMEOUT_MESSAGE
      );
      return true;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === ALREADY_EXISTS) return false;
      fail("service_unavailable", "Sign-in is busy. Please try again shortly.", 503);
    }
  }
}

/** In-process store for dev, test and CI, which never set `FIRESTORE_PROJECT_ID`. */
export class InMemoryUsedChallengeStore implements UsedChallengeStore {
  private readonly claimed = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async claim(challenge: string, expiresAt: Date): Promise<boolean> {
    const now = this.now();
    for (const [id, until] of this.claimed) if (until <= now) this.claimed.delete(id);
    const id = idOf(challenge);
    if (this.claimed.has(id)) return false;
    this.claimed.set(id, expiresAt.getTime());
    return true;
  }
}

export function createUsedChallengeStore(): UsedChallengeStore {
  const projectId = process.env.FIRESTORE_PROJECT_ID;
  if (!projectId) return new InMemoryUsedChallengeStore();
  return new FirestoreUsedChallengeStore(createFirestore(projectId));
}
