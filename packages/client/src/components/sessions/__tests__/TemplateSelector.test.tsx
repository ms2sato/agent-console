import { describe, it, expect, afterEach, mock } from 'bun:test';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import { TemplateSelector } from '../TemplateSelector';
import type { MessageTemplate } from '../../../hooks/useMessageTemplates';

const TEMPLATES: MessageTemplate[] = [
  { id: '1', name: 'Bug Report', content: 'Steps to reproduce:\n1.\n2.\n3.' },
  { id: '2', name: 'Feature Request', content: 'As a user, I want to...' },
  { id: '3', name: 'Code Review', content: 'Please review the following changes...' },
];

describe('TemplateSelector', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders template list', () => {
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const options = view.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain('Bug Report');
    expect(options[1].textContent).toContain('Feature Request');
    expect(options[2].textContent).toContain('Code Review');
  });

  it('shows content preview in options', () => {
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const options = view.getAllByRole('option');
    expect(options[0].textContent).toContain('Steps to reproduce');
  });

  it('filters templates by name', () => {
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search templates...');
    fireEvent.change(searchInput, { target: { value: 'bug' } });

    const options = view.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Bug Report');
  });

  it('filters templates by content', () => {
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search templates...');
    fireEvent.change(searchInput, { target: { value: 'review' } });

    const options = view.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Code Review');
  });

  it('navigates with arrow keys', () => {
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search templates...');

    // First item selected by default
    let options = view.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    // Arrow down
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    options = view.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].getAttribute('aria-selected')).toBe('true');

    // Arrow up
    fireEvent.keyDown(searchInput, { key: 'ArrowUp' });
    options = view.getAllByRole('option');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('aria-selected')).toBe('false');
  });

  it('selects template with Enter', () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={onSelect}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search templates...');

    // Move to second item and select
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
    fireEvent.keyDown(searchInput, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith(TEMPLATES[1].content);
  });

  it('closes with Escape', () => {
    const onClose = mock(() => {});
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={onClose}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search templates...');
    fireEvent.keyDown(searchInput, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('selects template on click', () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={onSelect}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const options = view.getAllByRole('option');
    fireEvent.mouseDown(options[2]);

    expect(onSelect).toHaveBeenCalledWith(TEMPLATES[2].content);
  });

  it('shows empty state when no templates exist', () => {
    const { container } = render(
      <TemplateSelector
        templates={[]}
        onSelect={() => {}}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );

    expect(container.textContent).toContain('No templates saved');
  });

  it('shows no-match message when filter yields no results', () => {
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={() => {}}
        onManage={() => {}}
      />,
    );
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search templates...');
    fireEvent.change(searchInput, { target: { value: 'zzzznonexistent' } });

    expect(container.textContent).toContain('No templates match your search');
  });

  it('closes when clicking outside', () => {
    const onClose = mock(() => {});
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <TemplateSelector
          templates={TEMPLATES}
          onSelect={() => {}}
          onClose={onClose}
          onManage={() => {}}
        />
      </div>,
    );

    const outsideElement = document.querySelector('[data-testid="outside"]')!;
    fireEvent.mouseDown(outsideElement);

    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside', () => {
    const onClose = mock(() => {});
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={onClose}
        onManage={() => {}}
      />,
    );

    const searchInput = within(container).getByPlaceholderText('Search templates...');
    fireEvent.mouseDown(searchInput);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows Manage Templates button', () => {
    const onManage = mock(() => {});
    const { container } = render(
      <TemplateSelector
        templates={TEMPLATES}
        onSelect={() => {}}
        onClose={() => {}}
        onManage={onManage}
      />,
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    const manageBtn = buttons.find(b => b.textContent?.includes('Manage Templates'));
    expect(manageBtn).toBeTruthy();

    fireEvent.mouseDown(manageBtn!);
    expect(onManage).toHaveBeenCalled();
  });
});
