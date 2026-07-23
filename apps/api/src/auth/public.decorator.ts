import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** Marks a route as reachable without an API key (e.g. health checks). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
