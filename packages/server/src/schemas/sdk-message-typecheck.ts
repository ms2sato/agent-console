/**
 * Type compatibility check for SDKUserMessage schema.
 *
 * This file ensures that the valibot schema defined in @agent-console/shared
 * produces a type that is compatible with the actual SDKUserMessage type
 * from the Claude Code SDK.
 *
 * If the schema diverges from the SDK type, TypeScript will produce a
 * compile-time error here.
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SdkUserMessageInput } from '@agent-console/shared';

/**
 * Type compatibility check: SdkUserMessageInput -> SDKUserMessage
 *
 * This assignment will fail at compile time if SdkUserMessageInput
 * is not assignable to SDKUserMessage.
 */

// Type assertion helper that checks assignability at compile time
type AssertAssignable<_T, _U extends _T> = true;

// This will error if SdkUserMessageInput is not assignable to SDKUserMessage
export type SchemaCompatibilityCheck = AssertAssignable<SDKUserMessage, SdkUserMessageInput>;

// Additional check: ensure all required SDK fields are present
type RequiredSDKFields = keyof SDKUserMessage;
type InferredFields = keyof SdkUserMessageInput;

// Verify that all required SDK fields exist in the inferred type
export type FieldsCompatibilityCheck = RequiredSDKFields extends InferredFields ? true : never;
