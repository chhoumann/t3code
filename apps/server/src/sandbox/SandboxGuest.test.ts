// @effect-diagnostics nodeBuiltinImport:off - the rendered guest commands are run by a real bash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  SandboxId,
  SandboxRemoteUrl,
  type ProjectCloneListEvent,
  type ProjectCloneSnapshot,
  type ProjectCloneStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";
import { Socket } from "effect/socket";

import {
  SANDBOX_ENV_FILE,
  SANDBOX_GITHUB_TOKEN_FILE,
  SANDBOX_INPUTS_READY_FILE,
  SANDBOX_MACHINE_SETUP_SCRIPT,
  SANDBOX_MANAGED_FILE,
  SANDBOX_SETUP_ENV_FILE,
} from "./sandboxBootScript.ts";
import * as SandboxGuest from "./SandboxGuest.ts";
import { ProviderMachineId, SandboxProvider } from "./SandboxProvider.ts";

const unused = () => Effect.die("unused");

/** The guest over a provider whose machine runs only `machine`'s calls. */
const guestLayer = (machine: Pick<SandboxProvider["Service"], "exec" | "writeFile">) =>
  SandboxGuest.layer.pipe(
    Layer.provide(
      Layer.succeed(
        SandboxProvider,
        SandboxProvider.of({
          checkAccess: unused,
          listTemplates: unused,
          create: unused,
          inspect: unused,
          host: unused,
          setDeadline: unused,
          stop: unused,
          resume: unused,
          destroy: unused,
          ...machine,
        }),
      ),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(unused))),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

describe("SandboxGuest", () => {
  it.effect("names why a guest command failed with the end of its stderr", () => {
    const stderr = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "error: the session could not be issued",
      "",
    ].join("\n");
    const layer = guestLayer({
      exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr, timedOut: false }),
      writeFile: unused,
    });
    return Effect.gen(function* () {
      const guest = yield* SandboxGuest.SandboxGuest;
      const failure = yield* guest
        .mintAdminSession({ apiKey: Redacted.make("key") }, ProviderMachineId.make("bx_1"))
        .pipe(Effect.flip);
      expect(failure.message).toBe(
        [
          "Could not mint the owner session on the sandbox.",
          "line 3",
          "line 4",
          "line 5",
          "line 6",
          "error: the session could not be issued",
        ].join("\n"),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "uploads the GitHub token as a file the login reads; the command never carries it",
    () => {
      const steps: Array<string> = [];
      const layer = guestLayer({
        exec: (_account, _machineId, { command }) =>
          Effect.sync(() => {
            steps.push(`exec:${command}`);
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
          }),
        writeFile: (_account, _machineId, { path, content }) =>
          Effect.sync(() => void steps.push(`write:${path}:${new TextDecoder().decode(content)}`)),
      });
      return Effect.gen(function* () {
        const guest = yield* SandboxGuest.SandboxGuest;
        yield* guest.deliverGitHubToken(
          { apiKey: Redacted.make("key") },
          ProviderMachineId.make("bx_1"),
          {
            generation: 3,
            token: Redacted.make("ghu_secret"),
            expiresAt: 0,
            login: "octocat",
            name: null,
            email: null,
          },
        );
        expect(steps).toHaveLength(2);
        expect(steps[0]).toBe(`write:${SANDBOX_GITHUB_TOKEN_FILE}:ghu_secret`);
        expect(steps[1]).toContain(`< '${SANDBOX_GITHUB_TOKEN_FILE}'`);
        expect(steps[1]).not.toContain("ghu_secret");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("reports whether a credential refresh left T3's restart pending", () => {
    let pending = "1";
    const layer = guestLayer({
      exec: () =>
        Effect.sync(() => ({
          exitCode: 0,
          stdout: `setup_restarted=1 t3_restart_pending=${pending}\n`,
          stderr: "",
          timedOut: false,
        })),
      writeFile: () => Effect.void,
    });
    const credentials = { envFile: "", setupEnvFile: "", machineSetupScript: "" };
    return Effect.gen(function* () {
      const guest = yield* SandboxGuest.SandboxGuest;
      const account = { apiKey: Redacted.make("key") };
      const first = yield* guest.refreshCredentials(
        account,
        ProviderMachineId.make("bx_1"),
        credentials,
      );
      pending = "0";
      const second = yield* guest.refreshCredentials(
        account,
        ProviderMachineId.make("bx_1"),
        credentials,
      );
      expect(first).toEqual({ restartPending: true });
      expect(second).toEqual({ restartPending: false });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "uploads the inputs of a machine made from a template over the earlier sandbox's, once",
    () => {
      // The machine's home is a temp dir its commands and files are redirected to.
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sandbox-inputs-"));
      const at = (path: string) => path.replace("/home/user", home);
      NodeFS.mkdirSync(NodePath.dirname(at(SANDBOX_INPUTS_READY_FILE)), { recursive: true });
      NodeFS.writeFileSync(at(SANDBOX_INPUTS_READY_FILE), "sbx-earlier");
      NodeFS.writeFileSync(
        at(SANDBOX_MANAGED_FILE),
        '{"ownerEnvironmentId":"env-owner","sandboxId":"sbx-earlier"}',
      );
      const written: Array<string> = [];
      const layer = guestLayer({
        exec: (_account, _machineId, { command }) =>
          Effect.sync(() => {
            const result = NodeChildProcess.spawnSync("bash", ["-c", at(command)], {
              encoding: "utf8",
            });
            return {
              exitCode: result.status,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: false,
            };
          }),
        writeFile: (_account, _machineId, { path, content }) =>
          Effect.sync(() => {
            written.push(path);
            NodeFS.writeFileSync(at(path), content);
          }),
      });
      return Effect.gen(function* () {
        const guest = yield* SandboxGuest.SandboxGuest;
        const inputs = {
          envFile: 'ANTHROPIC_API_KEY="new"\n',
          setupEnvFile: "",
          machineSetupScript: "",
          tarball: null,
          managed: {
            ownerEnvironmentId: EnvironmentId.make("env-owner"),
            sandboxId: SandboxId.make("sbx-0a1b2c3d"),
          },
        };
        const account = { apiKey: Redacted.make("key") };
        yield* guest.writeBootInputs(account, ProviderMachineId.make("bx_1"), inputs);
        yield* guest.writeBootInputs(account, ProviderMachineId.make("bx_1"), inputs);
        const managed = NodeFS.readFileSync(at(SANDBOX_MANAGED_FILE), "utf8");
        const ready = NodeFS.readFileSync(at(SANDBOX_INPUTS_READY_FILE), "utf8");
        NodeFS.rmSync(home, { recursive: true });

        expect(managed).toBe('{"ownerEnvironmentId":"env-owner","sandboxId":"sbx-0a1b2c3d"}');
        expect(ready).toBe("sbx-0a1b2c3d");
        expect(written).toEqual([
          SANDBOX_ENV_FILE,
          SANDBOX_SETUP_ENV_FILE,
          SANDBOX_MACHINE_SETUP_SCRIPT,
          SANDBOX_MANAGED_FILE,
          SANDBOX_INPUTS_READY_FILE,
        ]);
      }).pipe(Effect.provide(layer));
    },
  );
});

const seedProject: SandboxGuest.SandboxSeedProject = {
  projectId: ProjectId.make("project-1"),
  title: "t3code",
  path: "/home/user/projects/t3code",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: {
    remoteUrl: SandboxRemoteUrl.make("https://github.com/octocat/t3code.git"),
    base: { _tag: "default" },
  },
};
const base = { branch: "main", commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" };
let sequence = 0;
const clone = (
  phase: ProjectCloneSnapshot["phase"],
  extra: Partial<ProjectCloneSnapshot> = {},
): ProjectCloneSnapshot => ({
  projectId: seedProject.projectId,
  remoteUrl: seedProject.source.remoteUrl,
  destinationPath: seedProject.path,
  repository: null,
  phase,
  stage: "receiving",
  percent: null,
  detail: null,
  stalled: false,
  error: null,
  startedAt: seedProject.createdAt,
  endedAt: null,
  sequence: ++sequence,
  ...extra,
});
const another = clone("running", { projectId: ProjectId.make("project-other") });

/**
 * A guest's clone service as seen over RPC: `lists` is what the subscription
 * delivers; a start or a retry publishes the lists it is told to.
 */
const cloneRpc = (behavior: {
  readonly onStart?: ReadonlyArray<ProjectCloneListEvent>;
  readonly onRetry?: {
    readonly applied: boolean;
    readonly lists: ReadonlyArray<ProjectCloneListEvent>;
  };
}) =>
  Effect.gen(function* () {
    const lists = yield* Queue.unbounded<ProjectCloneListEvent>();
    const calls: Array<{ start: ProjectCloneStartInput } | "retry"> = [];
    const publish = (events: ReadonlyArray<ProjectCloneListEvent>) =>
      Effect.forEach(events, (event) => Queue.offer(lists, event), { discard: true });
    const rpc: SandboxGuest.ProjectCloneRpc<never> = {
      subscribeProjectClones: () => Effect.succeed(lists),
      "projectClone.start": (input) =>
        Effect.gen(function* () {
          calls.push({ start: input });
          yield* publish(behavior.onStart ?? []);
          return {};
        }),
      "projectClone.retry": () =>
        Effect.gen(function* () {
          calls.push("retry");
          yield* publish(behavior.onRetry?.lists ?? []);
          return { applied: behavior.onRetry?.applied ?? false };
        }),
    };
    const prepare = SandboxGuest.prepareProjectOver(rpc, seedProject).pipe(Effect.scoped);
    return { lists, calls, prepare };
  });

describe("prepareProjectOver", () => {
  it.effect("starts the clone when the guest has none, and returns the base it pins", () =>
    Effect.gen(function* () {
      const { lists, calls, prepare } = yield* cloneRpc({
        onStart: [
          [another, clone("running")],
          [another, clone("done", { base })],
        ],
      });
      yield* Queue.offer(lists, [another]);
      expect(yield* prepare).toEqual(base);
      expect(calls).toEqual([
        {
          start: {
            projectId: seedProject.projectId,
            title: "t3code",
            createdAt: seedProject.createdAt,
            remoteUrl: seedProject.source.remoteUrl,
            destinationPath: seedProject.path,
            protocol: "https",
            checkout: {
              base: { _tag: "default" },
              reuseMatching: true,
              importProjectScripts: true,
            },
          },
        },
      ]);
    }),
  );

  it.effect("joins a clone the guest already runs instead of starting another", () =>
    Effect.gen(function* () {
      const { lists, calls, prepare } = yield* cloneRpc({});
      yield* Queue.offer(lists, [clone("running", { percent: 40 })]);
      yield* Queue.offer(lists, [clone("done", { base })]);
      expect(yield* prepare).toEqual(base);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("retries a clone that failed and waits for the retry's outcome", () =>
    Effect.gen(function* () {
      const { lists, calls, prepare } = yield* cloneRpc({
        onRetry: { applied: true, lists: [[clone("running")], [clone("done", { base })]] },
      });
      yield* Queue.offer(lists, [clone("failed", { error: "fatal: could not read from remote" })]);
      expect(yield* prepare).toEqual(base);
      expect(calls).toEqual(["retry"]);
    }),
  );

  it.effect("a clone that failed after being joined names git's reason", () =>
    Effect.gen(function* () {
      const { lists, prepare } = yield* cloneRpc({});
      yield* Queue.offer(lists, [clone("running")]);
      yield* Queue.offer(lists, [clone("failed", { error: "fatal: repository not found" })]);
      const error = yield* Effect.flip(prepare);
      expect(error.operation).toBe("clone");
      expect(error.message).toContain("fatal: repository not found");
    }),
  );

  it.effect("a finished clone without a pinned base is a failure, not a launch", () =>
    Effect.gen(function* () {
      const { lists, calls, prepare } = yield* cloneRpc({});
      yield* Queue.offer(lists, [clone("done")]);
      const error = yield* Effect.flip(prepare);
      expect(error.operation).toBe("clone");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("fails at once when the guest drops the clone as the retry is asked", () =>
    Effect.gen(function* () {
      const { lists, prepare } = yield* cloneRpc({
        onRetry: { applied: false, lists: [[another]] },
      });
      yield* Queue.offer(lists, [another, clone("cancelled")]);
      const error = yield* Effect.flip(prepare);
      expect(error.message).toContain("stopped tracking");
    }),
  );
});
