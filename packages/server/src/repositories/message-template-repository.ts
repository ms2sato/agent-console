import type { MessageTemplate } from '@agent-console/shared';

/**
 * Repository interface for persisting message templates.
 * Provides an abstraction layer for message template storage operations.
 */
export interface MessageTemplateRepository {
  /**
   * Retrieve all message templates, ordered by sort_order ascending.
   */
  findAll(): Promise<MessageTemplate[]>;

  /**
   * Find a message template by its ID.
   * @param id - The template ID to search for
   * @returns The template if found, null otherwise
   */
  findById(id: string): Promise<MessageTemplate | null>;

  /**
   * Create a new message template.
   * @param id - The template ID
   * @param title - The display title
   * @param content - The template content
   * @param sortOrder - The sort order for display
   * @returns The created template
   */
  create(id: string, title: string, content: string, sortOrder: number): Promise<MessageTemplate>;

  /**
   * Update specific fields of a message template.
   * @param id - The template ID to update
   * @param updates - The fields to update
   * @returns The updated template if found, null otherwise
   */
  update(id: string, updates: { title?: string; content?: string }): Promise<MessageTemplate | null>;

  /**
   * Delete a message template by its ID.
   * @param id - The template ID to delete
   * @returns true if a template was deleted, false if not found
   */
  delete(id: string): Promise<boolean>;

  /**
   * Reorder templates by updating sort_order for each ID in the given order.
   * @param orderedIds - Array of template IDs in desired display order
   */
  reorder(orderedIds: string[]): Promise<void>;
}
