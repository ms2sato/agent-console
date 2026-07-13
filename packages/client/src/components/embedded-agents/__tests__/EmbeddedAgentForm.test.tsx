import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMBEDDED_AGENT_TOOL_NAMES } from '@agent-console/shared';
import {
  EmbeddedAgentForm,
  READ_ONLY_TOOL_NAMES,
  COMMAND_EXECUTION_TOOL_NAMES,
  FILE_MODIFICATION_TOOL_NAMES,
  type EmbeddedAgentFormData,
} from '../EmbeddedAgentForm';

afterEach(() => {
  cleanup();
});

function renderEmbeddedAgentForm(props: Partial<React.ComponentProps<typeof EmbeddedAgentForm>> = {}) {
  const defaultProps = {
    mode: 'create' as const,
    onSubmit: mock(() => {}),
    onCancel: mock(() => {}),
    isPending: false,
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(<EmbeddedAgentForm {...mergedProps} />),
    props: mergedProps,
  };
}

describe('EmbeddedAgentForm', () => {
  describe('create mode', () => {
    it('should render form with empty fields', () => {
      renderEmbeddedAgentForm();

      expect(screen.getByText('Add New Embedded Agent')).toBeTruthy();
      expect(screen.getByPlaceholderText('e.g., Ollama qwen3:32b')).toBeTruthy();
      expect(screen.getByPlaceholderText('http://localhost:11434/v1')).toBeTruthy();
      expect(screen.getByPlaceholderText('e.g., qwen3:32b')).toBeTruthy();
    });

    it('should show validation error for missing name', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.tab();

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show validation error for invalid base URL', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'not-a-url');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.tab();

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('Must be a valid URL, e.g. http://localhost:11434/v1')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show validation error for missing model', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.tab();

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('Invalid length: Expected >=1 but received 0')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show validation error for non-integer max tool iterations', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.type(screen.getByPlaceholderText('25'), 'abc');
      await user.tab();

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('Must be a positive integer')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should submit form with valid data', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.type(screen.getByPlaceholderText('25'), '10');

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect(formData.name).toBe('My Embedded Agent');
      expect(formData.baseUrl).toBe('http://localhost:11434/v1');
      expect(formData.model).toBe('qwen3:32b');
      expect(formData.maxToolIterationsInput).toBe('10');
    });

    it('should call onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.click(screen.getByText('Cancel'));

      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });

    it('should check Read/Glob/Grep and leave Bash/Write/Edit unchecked by default', () => {
      renderEmbeddedAgentForm();

      for (const name of READ_ONLY_TOOL_NAMES) {
        expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(true);
      }
      for (const name of COMMAND_EXECUTION_TOOL_NAMES) {
        expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(false);
      }
      for (const name of FILE_MODIFICATION_TOOL_NAMES) {
        expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).checked).toBe(false);
      }
    });

    it('should include a toggled Bash checkbox in the submitted enabledTools array', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.click(screen.getByRole('checkbox', { name: 'Bash' }));

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect([...formData.enabledTools].sort()).toEqual(['Bash', 'Glob', 'Grep', 'Read']);
    });

    it('should include toggled Write/Edit checkboxes in the submitted enabledTools array', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      for (const name of FILE_MODIFICATION_TOOL_NAMES) {
        await user.click(screen.getByRole('checkbox', { name }));
      }

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect([...formData.enabledTools].sort()).toEqual(['Edit', 'Glob', 'Grep', 'Read', 'Write']);
    });

    it('should show an amber danger warning associated with the File modification checkbox group', () => {
      renderEmbeddedAgentForm();

      const warning = screen.getByText(/Creates and modifies files/);
      expect(warning).toBeTruthy();
      expect(warning.textContent).toContain('as the session user');
      expect(warning.className).toContain('amber');

      const writeCheckbox = screen.getByRole('checkbox', { name: 'Write' });
      const editCheckbox = screen.getByRole('checkbox', { name: 'Edit' });
      const readCheckbox = screen.getByRole('checkbox', { name: 'Read' });
      // The warning's enclosing "File modification" group contains the
      // Write/Edit checkboxes but not a "Read-only" group checkbox.
      expect(warning.parentElement?.contains(writeCheckbox)).toBe(true);
      expect(warning.parentElement?.contains(editCheckbox)).toBe(true);
      expect(warning.parentElement?.contains(readCheckbox)).toBe(false);
    });

    it('should submit enabledTools: [] when all read-only checkboxes are unchecked', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      for (const name of READ_ONLY_TOOL_NAMES) {
        await user.click(screen.getByRole('checkbox', { name }));
      }

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect(formData.enabledTools).toEqual([]);
    });

    it('shows the experimental-feature banner', () => {
      renderEmbeddedAgentForm();

      expect(
        screen.getByText('Embedded Agent is an experimental feature. API and behavior may change.'),
      ).toBeTruthy();
    });

    it('should show an amber danger warning associated with the Bash checkbox group', () => {
      renderEmbeddedAgentForm();

      const warning = screen.getByText(/Runs arbitrary shell commands/);
      expect(warning).toBeTruthy();
      expect(warning.textContent).toContain('as the session user');
      expect(warning.className).toContain('amber');

      const bashCheckbox = screen.getByRole('checkbox', { name: 'Bash' });
      const readCheckbox = screen.getByRole('checkbox', { name: 'Read' });
      // The warning's enclosing "Command execution" group contains the Bash
      // checkbox but not a "Read-only" group checkbox.
      expect(warning.parentElement?.contains(bashCheckbox)).toBe(true);
      expect(warning.parentElement?.contains(readCheckbox)).toBe(false);
    });
  });

  describe('tool group partitioning', () => {
    it('READ_ONLY_TOOL_NAMES, COMMAND_EXECUTION_TOOL_NAMES, and FILE_MODIFICATION_TOOL_NAMES partition EMBEDDED_AGENT_TOOL_NAMES exactly', () => {
      const union = [
        ...READ_ONLY_TOOL_NAMES,
        ...COMMAND_EXECUTION_TOOL_NAMES,
        ...FILE_MODIFICATION_TOOL_NAMES,
      ].sort();
      const all = [...EMBEDDED_AGENT_TOOL_NAMES].sort();
      expect(union).toEqual(all);
      // No duplicates across the three groups.
      expect(new Set(union).size).toBe(union.length);
    });
  });

  describe('edit mode', () => {
    const initialData: EmbeddedAgentFormData = {
      name: 'Existing Embedded Agent',
      description: 'Test description',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3:32b',
      apiKeyRef: 'my-key',
      systemPrompt: 'Be helpful',
      maxToolIterationsInput: '25',
      enabledTools: ['Read', 'Glob', 'Grep'],
    };

    it('should render form with pre-filled data', () => {
      renderEmbeddedAgentForm({ mode: 'edit', initialData });

      expect(screen.queryByText('Add New Embedded Agent')).toBeNull();
      expect(screen.getByDisplayValue('Existing Embedded Agent')).toBeTruthy();
      expect(screen.getByDisplayValue('Test description')).toBeTruthy();
      expect(screen.getByDisplayValue('http://localhost:11434/v1')).toBeTruthy();
      expect(screen.getByDisplayValue('qwen3:32b')).toBeTruthy();
      expect(screen.getByDisplayValue('my-key')).toBeTruthy();
      expect(screen.getByDisplayValue('Be helpful')).toBeTruthy();
      expect(screen.getByDisplayValue('25')).toBeTruthy();
      expect(screen.getByText('Save Changes')).toBeTruthy();
    });

    it('shows the experimental-feature banner in edit mode too', () => {
      renderEmbeddedAgentForm({ mode: 'edit', initialData });

      expect(
        screen.getByText('Embedded Agent is an experimental feature. API and behavior may change.'),
      ).toBeTruthy();
    });

    it('should submit updated data, allowing an optional field to be cleared', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm({ mode: 'edit', initialData });

      const apiKeyInput = screen.getByDisplayValue('my-key');
      await user.clear(apiKeyInput);

      await user.click(screen.getByText('Save Changes'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect(formData.name).toBe('Existing Embedded Agent');
      expect(formData.apiKeyRef).toBe('');
    });
  });
});
