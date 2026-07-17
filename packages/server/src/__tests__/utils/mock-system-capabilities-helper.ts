/**
 * Centralized SystemCapabilitiesService mock factory for tests.
 *
 * IMPORTANT: Import this module in test files that need a mock
 * SystemCapabilitiesService instance instead of running the underlying
 * `which` shell-out.
 *
 * @example
 * ```typescript
 * import { createMockSystemCapabilities } from '../../__tests__/utils/mock-system-capabilities-helper.js';
 *
 * const systemCapabilities = createMockSystemCapabilities({ vscode: true });
 * ```
 */
import { SystemCapabilitiesService } from '../../services/system-capabilities-service.js';

export interface MockSystemCapabilitiesOptions {
  vscode?: boolean;
  vscodeOpenMode?: 'local-spawn' | 'remote-url-scheme';
  vscodeRemoteHost?: string | null;
  vscodeCommand?: 'code' | 'code-insiders' | null;
}

/**
 * Create a mock SystemCapabilitiesService for testing.
 *
 * Constructs a real instance and seeds its private state via Reflect so
 * tests avoid running the underlying `which` shell-out, while staying
 * structurally honest without `as unknown as` casts.
 *
 * Defaults mirror "no capabilities detected" (vscode: false). Pass
 * `{ vscode: true }` (or any subset of options) to override per call site.
 */
export function createMockSystemCapabilities(
  options: MockSystemCapabilitiesOptions = {},
): SystemCapabilitiesService {
  const {
    vscode = false,
    vscodeOpenMode = 'local-spawn',
    vscodeRemoteHost = null,
    vscodeCommand = vscode ? 'code' : null,
  } = options;

  const service = new SystemCapabilitiesService();
  Reflect.set(service, 'capabilities', {
    vscode,
    vscodeOpenMode,
    vscodeRemoteHost,
  });
  Reflect.set(service, 'vscodeCommand', vscodeCommand);
  return service;
}
