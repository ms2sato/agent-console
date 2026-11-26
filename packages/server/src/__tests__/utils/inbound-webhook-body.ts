/**
 * Test-only builder of an inbound webhook body with `schema_version` 2.
 *
 * It deliberately imports nothing from production, so a reader that drifted from this shape fails
 * the tests. The defaults are filler: a test that asserts on a field passes that field explicitly.
 */
export function v2Body(
  over: Record<string, unknown> = {},
  hikyac: Record<string, unknown> = {},
  source: Record<string, unknown> = {},
) {
  return {
    schema_version: 2,
    message: 'default message',
    hikyac: { v: 1, permalink: null, files: [], ...hikyac },
    source: {
      type: 'slack',
      ids: { channel: 'C0DEFAULT', ts: '0.0' },
      event: null,
      truncated: false,
      ...source,
    },
    ...over,
  };
}
