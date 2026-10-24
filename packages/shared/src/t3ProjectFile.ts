import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { T3ProjectFile, T3_PROJECT_FILE_SCHEMA_URL, type ProjectScript } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/** A checked-in `t3.json`'s scripts as project scripts, the way the web app imports them. */
export function projectScriptsFromT3ProjectFile(file: T3ProjectFile): ReadonlyArray<ProjectScript> {
  return (file.scripts ?? []).map((script, index) => ({
    id: `t3json-${index + 1}`,
    name: script.name,
    command: script.command,
    icon: script.icon ?? "play",
    runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
    ...(script.runOnSettle ? { runOnSettle: true } : {}),
    ...(script.runOnWorktreeCreate && script.async === false ? { async: false } : {}),
    ...(script.previewUrl
      ? { previewUrl: script.previewUrl, autoOpenPreview: script.autoOpenPreview ?? false }
      : {}),
  }));
}

export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T3ProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
