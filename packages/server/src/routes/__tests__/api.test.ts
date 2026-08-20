import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Hono } from 'hono';
import type { AppBindings } from '../../app-context.js';
import { setupTestEnvironment, cleanupTestEnvironment, createTestApp } from '../../__tests__/test-utils.js';
import type { ConfigResponse, SkillDefinition } from '@agent-console/shared';
import type { MessageTemplateRepository } from '../../repositories/message-template-repository.js';
import type { EmbeddedAgentManager } from '../../services/embedded-agent-manager.js';
import type { UserRepository } from '../../repositories/user-repository.js';
import type { ArtifactRepository } from '../../repositories/artifact-repository.js';
import type { BookmarkRepository } from '../../repositories/bookmark-repository.js';
import { NotificationService } from '../../services/notification-service.js';
import { SharedAccountRegistry } from '../../services/shared-account-registry.js';
import { serverConfig } from '../../lib/server-config.js';
import { createMockSystemCapabilities } from '../../__tests__/utils/mock-system-capabilities-helper.js';

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

  it('should mount embedded-agents route at /api/embedded-agents', async () => {
    app = await createTestApp({
      embeddedAgentManager: { getAllEmbeddedAgents: () => [] } as Pick<EmbeddedAgentManager, 'getAllEmbeddedAgents'> as EmbeddedAgentManager,
    });
    const res = await app.request('/api/embedded-agents');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { embeddedAgents: unknown[] };
    expect(Array.isArray(body.embeddedAgents)).toBe(true);
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

  it('should mount artifacts route at /api/artifacts', async () => {
    app = await createTestApp({
      artifactRepository: { findByUserId: async () => [] } as Pick<ArtifactRepository, 'findByUserId'> as ArtifactRepository,
    });
    const res = await app.request('/api/artifacts');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: unknown[] };
    expect(Array.isArray(body.artifacts)).toBe(true);
  });

  it('should mount bookmarks route at /api/bookmarks', async () => {
    app = await createTestApp({
      bookmarkRepository: { findByUserId: async () => [] } as Pick<BookmarkRepository, 'findByUserId'> as BookmarkRepository,
    });
    const res = await app.request('/api/bookmarks');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { bookmarks: unknown[] };
    expect(Array.isArray(body.bookmarks)).toBe(true);
  });

  it('should mount notifications route at /api/notifications', async () => {
    const notificationService = new NotificationService({
      artifactRepository: { findByUserId: async () => [] },
      jobs: { getJobs: async () => [] },
      cursorRepository: { getCursor: async () => null, advance: async (_userId, lastSeenAt) => lastSeenAt },
    });
    app = await createTestApp({ notificationService });
    const res = await app.request('/api/notifications');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; lastSeenAt: string | null; unreadCount: number };
    expect(body).toEqual({ items: [], lastSeenAt: null, unreadCount: 0 });
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
    // serverPort is exposed so clients can compose absolute URLs (e.g. MCP endpoint).
    expect(body.serverPort).toBe(Number(serverConfig.PORT));
    expect(Number.isFinite(body.serverPort)).toBe(true);
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
