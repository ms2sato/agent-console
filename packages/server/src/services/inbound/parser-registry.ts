import type { ServiceParser } from './service-parser.js';

/**
 * Registry for service parsers.
 *
 * This class replaces the module-level singleton pattern to enable proper test isolation.
 * Each test can create its own registry instance, avoiding global state pollution.
 */
export class ServiceParserRegistry {
  private parsers = new Map<string, ServiceParser>();

  register(parser: ServiceParser): void {
    this.parsers.set(parser.serviceId, parser);
  }

  get(serviceId: string): ServiceParser | null {
    return this.parsers.get(serviceId) ?? null;
  }

  clear(): void {
    this.parsers.clear();
  }
}
