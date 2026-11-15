import { formatPostDate } from "@/lib/blog-date";
import { BASE_RESERVE_CHECKED_ON, BASE_RESERVE_XLM } from "@/lib/site/reserve";

/** The network's base reserve, for a post to state without copying the number. */
export function BaseReserve() {
  return <>{BASE_RESERVE_XLM} XLM</>;
}

/** The day the base reserve was last checked against the network. */
export function BaseReserveCheckedOn() {
  return <time dateTime={BASE_RESERVE_CHECKED_ON}>{formatPostDate(BASE_RESERVE_CHECKED_ON)}</time>;
}
