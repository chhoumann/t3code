import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  parseT3ProjectFile,
  projectScriptsFromT3ProjectFile,
  T3ProjectFileFromJson,
} from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://t3.codes/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});

describe("projectScriptsFromT3ProjectFile", () => {
  it("imports scripts with stable ids and the defaults the scripts menu assumes", () => {
    expect(
      projectScriptsFromT3ProjectFile({
        scripts: [
          { name: "Dev", command: "pnpm dev", previewUrl: "http://localhost:3000" },
          {
            name: "Install",
            command: "pnpm i",
            icon: "build",
            runOnWorktreeCreate: true,
            async: false,
            runOnSettle: true,
          },
        ],
      }),
    ).toEqual([
      {
        id: "t3json-1",
        name: "Dev",
        command: "pnpm dev",
        icon: "play",
        runOnWorktreeCreate: false,
        previewUrl: "http://localhost:3000",
        autoOpenPreview: false,
      },
      {
        id: "t3json-2",
        name: "Install",
        command: "pnpm i",
        icon: "build",
        runOnWorktreeCreate: true,
        runOnSettle: true,
        async: false,
      },
    ]);
    expect(projectScriptsFromT3ProjectFile({})).toEqual([]);
  });
});
