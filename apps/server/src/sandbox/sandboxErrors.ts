import { SandboxError, type SandboxErrorCode } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type * as SandboxAccounts from "./SandboxAccounts.ts";
import type { SandboxGuestError } from "./SandboxGuest.ts";
import type { SandboxProviderError } from "./SandboxProvider.ts";
import type * as SandboxService from "./SandboxService.ts";

/** Everything the sandbox and sandbox account services fail with. */
export type SandboxFailure =
  | SandboxService.SandboxNotFoundError
  | SandboxService.SandboxDestroyedError
  | SandboxService.SandboxNotReadyError
  | SandboxService.SandboxPersistenceError
  | SandboxAccounts.SandboxAccountNotFoundError
  | SandboxAccounts.SandboxAccountInvalidError
  | SandboxAccounts.SandboxAccountKeyScopeError
  | SandboxAccounts.SandboxAccountInUseError
  | SandboxAccounts.SandboxAccountStoreError
  | SandboxProviderError
  | SandboxGuestError
  | ServerSecretStore.SecretStoreError;

const codeOf = (error: SandboxFailure): SandboxErrorCode => {
  if (ServerSecretStore.isSecretStoreError(error)) return "unavailable";
  switch (error._tag) {
    case "SandboxNotFoundError":
      return "not-found";
    case "SandboxDestroyedError":
      return "destroyed";
    case "SandboxNotReadyError":
      return "not-ready";
    case "SandboxAccountNotFoundError":
      return "account-not-found";
    case "SandboxAccountInvalidError":
      return "account-invalid";
    case "SandboxAccountKeyScopeError":
      return "key-missing-actions";
    case "SandboxAccountInUseError":
      return "account-in-use";
    case "SandboxProviderError":
      return "provider";
    case "SandboxGuestError":
    case "SandboxPersistenceError":
    case "SandboxAccountStoreError":
      return "unavailable";
  }
};

/** The wire error clients and agents see; every message is built from safe attributes. */
export const toSandboxError = (error: SandboxFailure): SandboxError =>
  new SandboxError({
    code: codeOf(error),
    message: error.message,
    ...(error._tag === "SandboxAccountKeyScopeError"
      ? { missingActions: error.missingActions }
      : {}),
  });
