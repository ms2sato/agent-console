// Type declarations for the exports of generate-schema-version.mjs that
// TypeScript tests import.
export function computeVersion(schemasDir?: string): string;
export function collectSchemaFiles(schemasDir?: string): string[];
export function copySchemaClosureTo(
  destDir: string,
  schemasDir?: string,
): { schemasDir: string; files: string[] };
