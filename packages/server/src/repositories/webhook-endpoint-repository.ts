/**
 * An inbound webhook endpoint as every ordinary read returns it. Structurally
 * has no `secret` / `previous_secret`: a route that lists or fetches an
 * endpoint cannot leak them because the type it holds does not carry them.
 *
 * `previousSecretExpiresAt` is the stored column. Whether a previous secret is
 * still honoured is a question about the current time, so it is derived by the
 * caller, not stored here.
 */
export interface InboundWebhookEndpointView {
  id: string;
  label: string;
  repositoryId: string;
  instructionText: string;
  /** ISO 8601 expiry of the previous secret, or null when there is none. */
  previousSecretExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An endpoint together with its signing secrets. Returned only by `create`,
 * `rotateSecret` and `findWithSecretById` (the verifier's lookup); never put it
 * in a list or get response.
 */
export interface InboundWebhookEndpointWithSecret extends InboundWebhookEndpointView {
  secret: string;
  previousSecret: string | null;
}

export interface CreateInboundWebhookEndpointParams {
  id: string;
  label: string;
  repositoryId: string;
  instructionText: string;
  secret: string;
  /** ISO 8601 timestamp used for both `created_at` and `updated_at`. */
  now: string;
}

/** Editable fields. An omitted key is left unchanged. */
export interface UpdateInboundWebhookEndpointParams {
  label?: string;
  instructionText?: string;
}

export interface InboundWebhookEndpointRepository {
  /** Every endpoint, oldest first. */
  list(): Promise<InboundWebhookEndpointView[]>;

  /** @returns The endpoint, or null when no row has this id. */
  findById(id: string): Promise<InboundWebhookEndpointView | null>;

  /** The verifier's lookup: the endpoint with its secrets, or null when no row has this id. */
  findWithSecretById(id: string): Promise<InboundWebhookEndpointWithSecret | null>;

  /**
   * Insert an endpoint. A `repositoryId` that matches no repository, or an
   * `instructionText` containing a line break, makes the database throw (FK /
   * CHECK); callers validate both first.
   */
  create(params: CreateInboundWebhookEndpointParams): Promise<InboundWebhookEndpointWithSecret>;

  /** Update label and/or instruction text and touch `updated_at`. Never touches the secrets. */
  update(id: string, updates: UpdateInboundWebhookEndpointParams, now: string): Promise<InboundWebhookEndpointView | null>;

  /**
   * Replace the secret: in ONE statement the old current secret becomes
   * `previous_secret` (expiring at `previousSecretExpiresAt`) and `newSecret`
   * becomes current. A second rotation replaces the previous secret with the
   * then-current one.
   */
  rotateSecret(
    id: string,
    newSecret: string,
    previousSecretExpiresAt: string,
    now: string,
  ): Promise<InboundWebhookEndpointWithSecret | null>;

  /** End the rotation window early: both previous columns become NULL. */
  clearPreviousSecret(id: string, now: string): Promise<InboundWebhookEndpointView | null>;

  /** Delete an endpoint (its delivery ledger cascades). @returns true when a row was deleted. */
  delete(id: string): Promise<boolean>;
}
