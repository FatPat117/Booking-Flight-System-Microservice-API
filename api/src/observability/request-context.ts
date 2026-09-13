import { AsyncLocalStorage } from "node:async_hooks";

export type AuthenticatedUser = {
  userId: string;
  email: string;
};

export type RequestContext = {
  requestId: string;
  /** Set by verifyJwt when the request carries a valid Bearer token. */
  authenticatedUser?: AuthenticatedUser;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getAuthenticatedUser(): AuthenticatedUser | undefined {
  return storage.getStore()?.authenticatedUser;
}

export function setAuthenticatedUser(user: AuthenticatedUser): void {
  const store = storage.getStore();

  if (store === undefined) {
    throw new Error(
      "setAuthenticatedUser requires an active request context",
    );
  }

  store.authenticatedUser = user;
}
