/**
 * Limits of an inbound webhook endpoint's operator-authored fields. The wire
 * shapes built on them live in `schemas/inbound-webhook-endpoint.ts`; the
 * `instruction_text` column of `inbound_webhook_endpoints` carries a length
 * CHECK reading the same number, which the request schema refuses first.
 */
export const INBOUND_WEBHOOK_LABEL_MAX_LENGTH = 100;
export const INBOUND_WEBHOOK_INSTRUCTION_TEXT_MAX_LENGTH = 4000;
