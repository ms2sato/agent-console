import type { SystemEvent } from '@agent-console/shared';

export interface ServiceParser {
  /** Service identifier (e.g., 'github', 'gitlab') */
  readonly serviceId: string;

  /** Authenticate the incoming webhook request */
  authenticate(payload: string, headers: Headers): Promise<boolean>;

  /**
   * Parse raw payload into SystemEvent.
   * Returns null if the event type is not supported.
   */
  parse(payload: string, headers: Headers): Promise<SystemEvent | null>;
}
