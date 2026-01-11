import type { ServiceParser } from './service-parser.js';

const serviceParsers = new Map<string, ServiceParser>();

export function registerServiceParser(parser: ServiceParser): void {
  serviceParsers.set(parser.serviceId, parser);
}

export function getServiceParser(serviceId: string): ServiceParser | null {
  return serviceParsers.get(serviceId) ?? null;
}

export function resetServiceParsers(): void {
  serviceParsers.clear();
}
