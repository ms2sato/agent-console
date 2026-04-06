import { describe, it, expect, afterEach, mock } from 'bun:test';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import { TemplateManager } from '../TemplateManager';
import type { MessageTemplate } from '../../../hooks/useMessageTemplates';

const TEMPLATES: MessageTemplate[] = [
  { id: '1', title: 'Bug Report', content: 'Steps to reproduce:\n1.\n2.\n3.', sortOrder: 0, createdAt: '', updatedAt: '' },
  { id: '2', title: 'Feature Request', content: 'As a user, I want to...', sortOrder: 1, createdAt: '', updatedAt: '' },
  { id: '3', title: 'Code Review', content: 'Please review the following changes...', sortOrder: 2, createdAt: '', updatedAt: '' },
];

function renderManager(overrides: Partial<Parameters<typeof TemplateManager>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: mock(() => {}),
    templates: TEMPLATES,
    onAdd: mock(() => {}),
    onUpdate: mock(() => {}),
    onDelete: mock(() => {}),
    onReorder: mock(() => {}),
    ...overrides,
  };

  const result = render(<TemplateManager {...props} />);
  return { ...result, props };
}

function getDialogContent(): HTMLElement {
  return document.body;
}

describe('TemplateManager', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the dialog with template list', () => {
    renderManager();
    const dialog = getDialogContent();

    expect(dialog.textContent).toContain('Manage Templates');
    expect(dialog.textContent).toContain('Bug Report');
    expect(dialog.textContent).toContain('Feature Request');
    expect(dialog.textContent).toContain('Code Review');
  });

  it('adds a new template', () => {
    const { props } = renderManager();
    const dialog = within(getDialogContent());

    const nameInput = dialog.getByPlaceholderText('Template name');
    const contentInput = dialog.getByPlaceholderText('Template content');

    fireEvent.change(nameInput, { target: { value: 'New Template' } });
    fireEvent.change(contentInput, { target: { value: 'New content here' } });

    const addButton = dialog.getByText('Add Template');
    fireEvent.click(addButton);

    expect(props.onAdd).toHaveBeenCalledWith('New Template', 'New content here');
  });

  it('does not add template with empty name', () => {
    const { props } = renderManager();
    const dialog = within(getDialogContent());

    const contentInput = dialog.getByPlaceholderText('Template content');
    fireEvent.change(contentInput, { target: { value: 'Content only' } });

    const addButton = dialog.getByText('Add Template') as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    fireEvent.click(addButton);

    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it('does not add template with empty content', () => {
    const { props } = renderManager();
    const dialog = within(getDialogContent());

    const nameInput = dialog.getByPlaceholderText('Template name');
    fireEvent.change(nameInput, { target: { value: 'Name only' } });

    const addButton = dialog.getByText('Add Template') as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    fireEvent.click(addButton);

    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it('edits an existing template', () => {
    const { props } = renderManager();
    const dialog = getDialogContent();

    const editButtons = dialog.querySelectorAll('[aria-label^="Edit"]');
    fireEvent.click(editButtons[0]);

    const view = within(dialog);
    const nameInput = view.getByLabelText('Edit template name') as HTMLInputElement;
    const contentInput = view.getByLabelText('Edit template content') as HTMLTextAreaElement;

    expect(nameInput.value).toBe('Bug Report');
    expect(contentInput.value).toBe('Steps to reproduce:\n1.\n2.\n3.');

    fireEvent.change(nameInput, { target: { value: 'Updated Bug Report' } });
    fireEvent.change(contentInput, { target: { value: 'Updated content' } });

    const saveButton = view.getByText('Save');
    fireEvent.click(saveButton);

    expect(props.onUpdate).toHaveBeenCalledWith('1', {
      title: 'Updated Bug Report',
      content: 'Updated content',
    });
  });

  it('cancels editing', () => {
    const { props } = renderManager();
    const dialog = getDialogContent();

    const editButtons = dialog.querySelectorAll('[aria-label^="Edit"]');
    fireEvent.click(editButtons[0]);

    const view = within(dialog);
    const cancelButton = view.getByText('Cancel');
    fireEvent.click(cancelButton);

    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Bug Report');
  });

  it('deletes a template with confirmation', () => {
    const { props } = renderManager();
    const dialog = getDialogContent();

    const deleteButtons = dialog.querySelectorAll('[aria-label^="Delete"]');
    fireEvent.click(deleteButtons[0]);

    const view = within(dialog);
    const confirmButton = view.getByText('Confirm');
    fireEvent.click(confirmButton);

    expect(props.onDelete).toHaveBeenCalledWith('1');
  });

  it('cancels delete confirmation', () => {
    const { props } = renderManager();
    const dialog = getDialogContent();

    const deleteButtons = dialog.querySelectorAll('[aria-label^="Delete"]');
    fireEvent.click(deleteButtons[0]);

    const view = within(dialog);
    const cancelButtons = view.getAllByText('Cancel');
    fireEvent.click(cancelButtons[0]);

    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('reorders templates up', () => {
    const { props } = renderManager();
    const dialog = getDialogContent();

    const moveUpButtons = dialog.querySelectorAll('[aria-label^="Move"][aria-label$="up"]');
    fireEvent.click(moveUpButtons[1]);

    expect(props.onReorder).toHaveBeenCalledWith(1, 0);
  });

  it('reorders templates down', () => {
    const { props } = renderManager();
    const dialog = getDialogContent();

    const moveDownButtons = dialog.querySelectorAll('[aria-label^="Move"][aria-label$="down"]');
    fireEvent.click(moveDownButtons[0]);

    expect(props.onReorder).toHaveBeenCalledWith(0, 1);
  });

  it('disables move up for first template', () => {
    renderManager();
    const dialog = getDialogContent();

    const moveUpButtons = dialog.querySelectorAll('[aria-label^="Move"][aria-label$="up"]');
    expect((moveUpButtons[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables move down for last template', () => {
    renderManager();
    const dialog = getDialogContent();

    const moveDownButtons = dialog.querySelectorAll('[aria-label^="Move"][aria-label$="down"]');
    const lastButton = moveDownButtons[moveDownButtons.length - 1] as HTMLButtonElement;
    expect(lastButton.disabled).toBe(true);
  });

  it('pre-fills content from initialContent prop', () => {
    renderManager({ initialContent: 'Pre-filled message' });
    const dialog = within(getDialogContent());

    const contentInput = dialog.getByPlaceholderText('Template content') as HTMLTextAreaElement;
    expect(contentInput.value).toBe('Pre-filled message');

    expect(getDialogContent().textContent).toContain('Save Current Message as Template');
  });

  it('shows empty state message when no templates', () => {
    renderManager({ templates: [] });

    expect(getDialogContent().textContent).toContain('No templates yet');
  });

  it('resets form state when reopened', () => {
    const { rerender, props } = renderManager({ open: true });
    const dialog = within(getDialogContent());

    // Type into the new template fields
    const nameInput = dialog.getByPlaceholderText('Template name');
    const contentInput = dialog.getByPlaceholderText('Template content');
    fireEvent.change(nameInput, { target: { value: 'Dirty name' } });
    fireEvent.change(contentInput, { target: { value: 'Dirty content' } });

    // Start editing a template
    const editButtons = getDialogContent().querySelectorAll('[aria-label^="Edit"]');
    fireEvent.click(editButtons[0]);

    // Close the dialog
    rerender(<TemplateManager {...props} open={false} />);

    // Reopen the dialog
    rerender(<TemplateManager {...props} open={true} />);

    const dialog2 = within(getDialogContent());
    const nameInput2 = dialog2.getByPlaceholderText('Template name') as HTMLInputElement;
    const contentInput2 = dialog2.getByPlaceholderText('Template content') as HTMLTextAreaElement;

    expect(nameInput2.value).toBe('');
    expect(contentInput2.value).toBe('');
    // Editing mode should be cleared (template list items visible, not edit form)
    expect(getDialogContent().textContent).toContain('Bug Report');
  });

  it('initialContent updates when dialog reopens', () => {
    const { rerender, props } = renderManager({ open: false, initialContent: undefined });

    // Open with initialContent='hello'
    rerender(<TemplateManager {...props} open={true} initialContent="hello" />);

    const dialog = within(getDialogContent());
    const contentInput = dialog.getByPlaceholderText('Template content') as HTMLTextAreaElement;
    expect(contentInput.value).toBe('hello');
  });
});
