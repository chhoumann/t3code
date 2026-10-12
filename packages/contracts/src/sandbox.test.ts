import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SandboxRepository } from "./sandbox.ts";

const decode = Schema.decodeUnknownExit(SandboxRepository);
const decodeSync = Schema.decodeUnknownSync(SandboxRepository);
const PROJECT = { name: "origin", url: "https://github.com/pingdotgg/t3code.git" };
const FORK = { name: "fork", url: "https://github.com/chhoumann/t3code.git" };

describe("SandboxRepository", () => {
  it("names the remote it tracks among its remotes", () => {
    const repository = { remotes: [FORK, PROJECT], trackedRemote: "fork", commit: null };
    expect(decodeSync(repository)).toEqual(repository);
  });

  it.each([
    ["no remotes", { remotes: [], trackedRemote: "origin", commit: null }],
    ["a tracked remote it lacks", { remotes: [PROJECT], trackedRemote: "fork", commit: null }],
    [
      "two remotes of one name",
      { remotes: [PROJECT, { ...FORK, name: "origin" }], trackedRemote: "origin", commit: null },
    ],
  ])("refuses %s", (_, repository) => {
    expect(decode(repository)._tag).toBe("Failure");
  });
});
