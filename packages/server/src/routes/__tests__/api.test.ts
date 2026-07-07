import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '../../__tests__/test-utils.js';
import type { ConfigResponse, SkillDefinition } from '@agent-console/shared';
import type { MessageTemplateRepository } from '../../repositories/message-template-repository.js';
import type { UserRepository } from '../../repositories/user-repository.js';
import { SharedAccountRegistry } from '../../services/shared-account-registry.js';
import { SystemCapabilitiesService } from '../../services/system-capabilities-service.js';

/**
 * Minimal SystemCapabilitiesService mock that returns no detected capabilities.
 *
 * Constructs a real instance and seeds its private state via Reflect so we
 * avoid running the underlying `which` shell-out. Mirrors the pattern used in
 * `__tests__/system.test.ts`. Returning a real instance also lets the test
 * stay structurally honest without `as unknown as` casts.
 */
function createMockSystemCapabilities(): SystemCapabilitiesService {
  const service = new SystemCapabilitiesService();
  Reflect.set(service, 'capabilities', {
    vscode: false,
    vscodeOpenMode: 'local-spawn',
    vscodeRemoteHost: null,
  });
  Reflect.set(service, 'vscodeCommand', null);
  return service;
}

describe('API route mounting', () => {
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    await setupTestEnvironment();
    app = await createTestApp();
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  it('should mount skills route at /api/skills', async () => {
    const res = await app.request('/api/skills');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: SkillDefinition[] };
    expect(Array.isArray(body.skills)).toBe(true);
  });

  it('should mount message-templates route at /api/message-templates', async () => {
    app = await createTestApp({
      messageTemplateRepository: { findAll: async () => [] } as Pick<MessageTemplateRepository, 'findAll'> as MessageTemplateRepository,
    });
    const res = await app.request('/api/message-templates');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: unknown[] };
    expect(Array.isArray(body.templates)).toBe(true);
  });
});

describe('GET /api/config — sharedAccountsAvailable', () => {
  beforeEach(async () => {
    await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment();
  });

  it('returns sharedAccountsAvailable: false when the registry is disabled', async () => {
    // The default test app uses SharedAccountRegistry.createDisabled() — no
    // override needed. This case mirrors AGENT_CONSOLE_SHARED_USERNAME unset.
    const app = await createTestApp({
      systemCapabilities: createMockSystemCapabilities(),
    });

    const res = await app.request('/api/config');

    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigResponse;
    expect(body.sharedAccountsAvailable).toBe(false);
    // The set of shared-account user-ids must NOT leak into the response.
    // Boundary contract: only the boolean gate is exposed.
    expect(body).not.toHaveProperty('sharedAccountIds');
    expect(body).not.toHaveProperty('sharedAccounts');
    // VS Code capability fields are always present in the response so the
    // client can decide how to render the "Open in VS Code" affordance.
    expect(body.capabilities.vscode).toBe(false);
    expect(body.capabilities.vscodeOpenMode).toBe('local-spawn');
    expect(body.capabilities.vscodeRemoteHost).toBeNull();
  });

  it('returns sharedAccountsAvailable: true when the registry is enabled', async () => {
    // Construct an enabled registry by stubbing the OS lookup + user repository
    // so create() returns an instance with a configured shared account.
    const fakeUserRepository = {
      upsertByOsUid: async () => ({
        id: 'shared-user-uuid',
        username: 'sharedusr',
        homeDir: '/home/sharedusr',
      }),
      findById: async () => null,
    } satisfies UserRepository;
    const enabledRegistry = await SharedAccountRegistry.create({
      username: 'sharedusr',
      userRepository: fakeUserRepository,
      lookupOsUser: async () => ({ uid: 9999, homeDir: '/home/sharedusr' }),
    });

    const app = await createTestApp({
      sharedAccountRegistry: enabledRegistry,
      systemCapabilities: createMockSystemCapabilities(),
    });

    const res = await app.request('/api/config');

    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigResponse;
    expect(body.sharedAccountsAvailable).toBe(true);
    // Boundary contract: still no exposure of the underlying user-id set.
    expect(body).not.toHaveProperty('sharedAccountIds');
    expect(body).not.toHaveProperty('sharedAccounts');
  });
});
