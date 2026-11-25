import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { openGitHubAppManifestPage } from "../../app/GitHubAppManifestPage.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export class GitHubAppManifestError extends Schema.TaggedError<GitHubAppManifestError>()(
  "GitHubAppManifestError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

const ManifestForm = Schema.Struct({
  action: Schema.String.check(Schema.isMaxLength(2_048)),
  manifest: Schema.String.check(Schema.isMaxLength(16_384)),
});

export const openGitHubAppManifest = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_GITHUB_APP_MANIFEST_CHANNEL,
  payload: ManifestForm,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.githubAppManifest.open")(function* (form) {
    const shell = yield* ElectronShell.ElectronShell;
    const context = yield* Effect.context<ElectronShell.ElectronShell>();
    const runPromise = Effect.runPromiseWith(context);
    yield* Effect.tryPromise({
      try: () => openGitHubAppManifestPage(form, (url) => runPromise(shell.openExternal(url))),
      catch: (cause) =>
        new GitHubAppManifestError({
          detail: cause instanceof Error ? cause.message : "Could not open GitHub.",
        }),
    });
  }),
});
