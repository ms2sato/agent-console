# Webhook Receiver Patterns

This document defines patterns for receiving webhooks from external services (GitHub, Slack, etc.).

**Important:** These patterns apply to **webhook receivers** (endpoints that external services call), NOT to regular API endpoints. API endpoints SHOULD return proper HTTP status codes (400, 401, 404, 500, etc.) to their callers.

## Core Principle: Always Return 200 OK

**Always return `200 OK` to the webhook sender, regardless of internal processing results.**

```typescript
// ✅ Webhook receiver - always 200
app.post('/webhooks/github', async (c) => {
  try {
    const payload = await c.req.json();
    await enqueueWebhookEvent('github', payload);
  } catch (error) {
    logger.error({ err: error }, 'Failed to enqueue webhook event');
    // Still return 200 - this is our problem, not the sender's
  }
  return c.json({ received: true }, 200);
});

// ❌ Wrong - returning error codes from a webhook receiver
app.post('/webhooks/github', async (c) => {
  const payload = await c.req.json();
  try {
    await processWebhookEvent(payload);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: 'Processing failed' }, 500); // Don't do this
  }
});
```

### Rationale

- **Retries are wasted on permanent errors.** Webhook senders (e.g., GitHub) retry on non-2xx responses. Configuration errors (wrong secret, missing parser) are permanent — retries will never fix them.
- **Sender may disable the webhook.** Persistent error responses can cause the sender to automatically disable the webhook endpoint.
- **Internal failures are your responsibility.** Transient errors (queue failure, DB down) should be handled internally with your own retry mechanisms, not by relying on the sender's retry logic.

## Async Processing

Accept the event and process it asynchronously:

```typescript
app.post('/webhooks/github', async (c) => {
  const payload = await c.req.json();

  // Enqueue for async processing - return immediately
  await enqueueWebhookEvent('github', payload);

  return c.json({ received: true }, 200);
});

// Separate worker processes the queue
async function processWebhookQueue() {
  let event;
  try {
    event = await dequeueEvent();
    await handleEvent(event);
  } catch (error) {
    logger.error({ err: error, eventId: event?.id }, 'Webhook processing failed');
    // Internal retry, alerting, dead-letter queue, etc.
  }
}
```

## Authentication

Verify webhook signatures before enqueuing, but **still return 200 on auth failure**:

```typescript
app.post('/webhooks/github', async (c) => {
  const signature = c.req.header('X-Hub-Signature-256');
  const body = await c.req.text();

  if (!signature || !verifyGitHubSignature(body, signature, secret)) {
    // Log the auth failure for investigation, but don't tell the caller
    logger.warn({ ip: c.req.header('X-Forwarded-For') }, 'Webhook signature verification failed');
    return c.json({ received: true }, 200);
  }

  const payload = JSON.parse(body);
  await enqueueWebhookEvent('github', payload);
  return c.json({ received: true }, 200);
});
```

**Why return 200 even on auth failure?** Returning 401/403 reveals that the endpoint exists and is active, providing attackers with information. Silent acceptance with internal logging is more secure.

> **Operational requirement:** Because senders receive 200 regardless of signature validity, a misconfigured secret (e.g., rotated on the sender side but not updated locally) will cause all events to be silently dropped with no sender-side delivery failure. **You must monitor and alert on signature-failure rate** (e.g., via the structured log emitted in the `logger.warn` call above) to detect misconfiguration promptly.

## Error Handling Strategy

| Failure Type | Action | Return to Sender |
|--------------|--------|-----------------|
| Signature verification failed | Log + alert | 200 OK |
| Payload parse error | Log + alert | 200 OK |
| Queue enqueue failure | Log + alert + internal retry | 200 OK |
| Processing logic error | Log + internal retry/dead-letter | 200 OK |

All failures are handled internally through logging, alerting, and internal retry mechanisms.

## Webhook Receiver vs API Endpoint

| Aspect | Webhook Receiver | API Endpoint |
|--------|-----------------|--------------|
| Response codes | Always 200 | Proper HTTP codes (400, 401, 404, 500) |
| Processing | Async (enqueue + return) | Sync (process + respond) |
| Error reporting | Internal (logs, alerts) | To caller (error response) |
| Caller relationship | External service, not in your control | Your own client or known consumer |
| Retry responsibility | Internal | Caller decides based on status code |
