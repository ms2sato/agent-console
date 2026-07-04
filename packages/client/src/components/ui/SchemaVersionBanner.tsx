import { useSchemaVersionMismatch } from '../../lib/schema-version';

/**
 * Banner shown when the client bundle is running an incompatible wire-schema
 * version from the server AND an automatic reload has already failed to resolve
 * it (a stale cache or proxy is serving old assets). It asks the user to refresh
 * manually because the reload-loop guard has stopped auto-reloading.
 */
export function SchemaVersionBanner() {
  const mismatch = useSchemaVersionMismatch();

  if (!mismatch) {
    return null;
  }

  return (
    <div role="alert" className="bg-red-700 text-white px-4 py-2 text-sm flex items-center justify-center gap-2 text-center">
      <span>
        The server was updated but this page could not load the new version
        automatically. Please refresh the page (Shift+Reload if the problem
        persists).
      </span>
    </div>
  );
}
