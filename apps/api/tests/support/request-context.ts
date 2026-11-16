import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Request, Response } from "express";
import { requestContextMiddleware } from "@/common/request-context";

/** A real, unconnected Node request and response for driving the request-context middleware. */
export function requestPair(): { req: Request; res: Response } {
  const incoming = new IncomingMessage(new Socket());
  incoming.url = "/x";
  // Express adds its helpers to these Node objects at runtime; the middleware reads none before finish.
  const req = incoming as Request;
  const res = new ServerResponse(incoming) as Response;
  res.json = () => res;
  return { req, res };
}

/** Runs `run` inside a fresh request context, as a request handler would. */
export function inRequestContext<T>(run: () => Promise<T>, deadlineMs?: number): Promise<T> {
  const { req, res } = requestPair();
  return new Promise<T>((resolve, reject) =>
    requestContextMiddleware(deadlineMs)(req, res, () => {
      run().then(resolve, reject);
    })
  );
}
