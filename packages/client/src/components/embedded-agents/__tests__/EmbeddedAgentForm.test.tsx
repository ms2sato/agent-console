import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMBEDDED_AGENT_TOOL_NAMES } from '@agent-console/shared';
import {
  EmbeddedAgentForm,
  READ_ONLY_TOOL_NAMES,
  COMMAND_EXECUTION_TOOL_NAMES,
  FILE_MODIFICATION_TOOL_NAMES,
  parseContextWindowTokens,
  parseHandoffRatio,
  formatHandoffRatioInput,
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
      instructions: [{ path: 'docs/AGENTS.md' }],
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

  describe('instructions', () => {
    it('should render with no instruction entries by default', () => {
      renderEmbeddedAgentForm();

      expect(screen.queryByPlaceholderText('e.g., docs/AGENTS.md')).toBeNull();
      expect(screen.getByText('+ Add file')).toBeTruthy();
    });

    it('should add and submit an instruction file path entry', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');

      await user.click(screen.getByText('+ Add file'));
      await user.type(screen.getByPlaceholderText('e.g., docs/AGENTS.md'), 'docs/AGENTS.md');

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect(formData.instructions).toEqual([{ path: 'docs/AGENTS.md' }]);
    });

    it('should show a validation error for an empty instruction file path', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');

      await user.click(screen.getByText('+ Add file'));

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('File path is required')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show a validation error for an absolute instruction file path', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');

      await user.click(screen.getByText('+ Add file'));
      await user.type(screen.getByPlaceholderText('e.g., docs/AGENTS.md'), '/etc/passwd');

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('Absolute paths are not allowed')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should remove an instruction file path entry', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');

      await user.click(screen.getByText('+ Add file'));
      await user.click(screen.getByText('+ Add file'));
      const pathInputs = screen.getAllByPlaceholderText('e.g., docs/AGENTS.md');
      await user.type(pathInputs[0], 'docs/first.md');
      await user.type(pathInputs[1], 'docs/second.md');

      await user.click(screen.getAllByText('Remove')[0]);

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect(formData.instructions).toEqual([{ path: 'docs/second.md' }]);
    });

    it('should pre-fill instructions in edit mode', () => {
      renderEmbeddedAgentForm({
        mode: 'edit',
        initialData: {
          name: 'Existing Embedded Agent',
          description: 'Test description',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen3:32b',
          apiKeyRef: 'my-key',
          systemPrompt: 'Be helpful',
          maxToolIterationsInput: '25',
          enabledTools: ['Read', 'Glob', 'Grep'],
          instructions: [{ path: 'docs/AGENTS.md' }],
        },
      });

      expect(screen.getByDisplayValue('docs/AGENTS.md')).toBeTruthy();
    });

    it('should allow clearing all instructions in edit mode', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm({
        mode: 'edit',
        initialData: {
          name: 'Existing Embedded Agent',
          description: 'Test description',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen3:32b',
          apiKeyRef: 'my-key',
          systemPrompt: 'Be helpful',
          maxToolIterationsInput: '25',
          enabledTools: ['Read', 'Glob', 'Grep'],
          instructions: [{ path: 'docs/AGENTS.md' }],
        },
      });

      await user.click(screen.getByText('Remove'));

      await user.click(screen.getByText('Save Changes'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect(formData.instructions).toEqual([]);
    });
  });

  describe('Context Handoff (Phase A) fields', () => {
    it('should render the contextWindowTokens/handoffSoftRatio/handoffHardRatio inputs', () => {
      renderEmbeddedAgentForm();

      expect(screen.getByPlaceholderText('e.g., 128000')).toBeTruthy();
      expect(screen.getByPlaceholderText('75')).toBeTruthy();
      expect(screen.getByPlaceholderText('90')).toBeTruthy();
    });

    it('should submit typed values for contextWindowTokensInput/handoffSoftRatioInput/handoffHardRatioInput', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.type(screen.getByPlaceholderText('e.g., 128000'), '128000');
      await user.type(screen.getByPlaceholderText('75'), '80');
      await user.type(screen.getByPlaceholderText('90'), '95');

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect(formData.contextWindowTokensInput).toBe('128000');
      expect(formData.handoffSoftRatioInput).toBe('80');
      expect(formData.handoffHardRatioInput).toBe('95');
    });

    it('should submit empty strings for contextWindowTokensInput/handoffSoftRatioInput/handoffHardRatioInput when left blank', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as EmbeddedAgentFormData;
      expect(formData.contextWindowTokensInput).toBe('');
      expect(formData.handoffSoftRatioInput).toBe('');
      expect(formData.handoffHardRatioInput).toBe('');
      // The submitted raw string form data converts to `undefined` via the
      // module's parse helpers (this is what AddEmbeddedAgentForm/
      // EditEmbeddedAgentForm actually call on submit -- see
      // parseContextWindowTokens/parseHandoffRatio unit tests below).
      expect(parseContextWindowTokens(formData.contextWindowTokensInput)).toBeUndefined();
      expect(parseHandoffRatio(formData.handoffSoftRatioInput)).toBeUndefined();
      expect(parseHandoffRatio(formData.handoffHardRatioInput)).toBeUndefined();
    });

    it('should show a validation error for a non-integer contextWindowTokensInput', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.type(screen.getByPlaceholderText('e.g., 128000'), 'abc');
      await user.tab();

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('Must be a positive integer')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show a validation error for a handoffSoftRatioInput above 100', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.type(screen.getByPlaceholderText('75'), '150');
      await user.tab();

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('Must be a number between 0 and 100')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show a validation error for a negative handoffHardRatioInput', async () => {
      const user = userEvent.setup();
      const { props } = renderEmbeddedAgentForm();

      await user.type(screen.getByPlaceholderText('e.g., Ollama qwen3:32b'), 'My Embedded Agent');
      await user.type(screen.getByPlaceholderText('http://localhost:11434/v1'), 'http://localhost:11434/v1');
      await user.type(screen.getByPlaceholderText('e.g., qwen3:32b'), 'qwen3:32b');
      await user.type(screen.getByPlaceholderText('90'), '-5');
      await user.tab();

      await user.click(screen.getByText('Add Embedded Agent'));

      await waitFor(() => {
        expect(screen.getByText('Must be a number between 0 and 100')).toBeTruthy();
      });
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should pre-fill percentage inputs in edit mode via formatHandoffRatioInput', () => {
      renderEmbeddedAgentForm({
        mode: 'edit',
        initialData: {
          name: 'Existing Embedded Agent',
          description: 'Test description',
          baseUrl: 'http://localhost:11434/v1',
          model: 'qwen3:32b',
          apiKeyRef: 'my-key',
          systemPrompt: 'Be helpful',
          maxToolIterationsInput: '25',
          enabledTools: ['Read', 'Glob', 'Grep'],
          instructions: [],
          contextWindowTokensInput: '128000',
          handoffSoftRatioInput: formatHandoffRatioInput(0.8),
          handoffHardRatioInput: formatHandoffRatioInput(0.95),
        },
      });

      expect(screen.getByDisplayValue('128000')).toBeTruthy();
      expect(screen.getByDisplayValue('80')).toBeTruthy();
      expect(screen.getByDisplayValue('95')).toBeTruthy();
    });
  });

  describe('parseContextWindowTokens', () => {
    it('should return undefined for an empty string', () => {
      expect(parseContextWindowTokens('')).toBeUndefined();
    });

    it('should return undefined for undefined input', () => {
      expect(parseContextWindowTokens(undefined)).toBeUndefined();
    });

    it('should return undefined for a whitespace-only string', () => {
      expect(parseContextWindowTokens('   ')).toBeUndefined();
    });

    it('should return the parsed number for a numeric string', () => {
      expect(parseContextWindowTokens('128000')).toBe(128000);
    });
  });

  describe('parseHandoffRatio', () => {
    it('should return undefined for an empty string', () => {
      expect(parseHandoffRatio('')).toBeUndefined();
    });

    it('should return undefined for undefined input', () => {
      expect(parseHandoffRatio(undefined)).toBeUndefined();
    });

    it('should convert a percentage string into a 0-1 ratio', () => {
      expect(parseHandoffRatio('75')).toBe(0.75);
    });

    it('should convert 100 into a ratio of 1', () => {
      expect(parseHandoffRatio('100')).toBe(1);
    });

    it('should convert 0 into a ratio of 0', () => {
      // '0' is truthy-empty-check-sensitive: the guard is `trimmed ? ... :
      // undefined`, and the string '0' is truthy (non-empty), so this must
      // return 0, not undefined.
      expect(parseHandoffRatio('0')).toBe(0);
    });
  });

  describe('formatHandoffRatioInput', () => {
    it('should format a 0-1 ratio into a rounded percentage string', () => {
      expect(formatHandoffRatioInput(0.75)).toBe('75');
    });

    it('should round to the nearest integer percentage', () => {
      expect(formatHandoffRatioInput(0.756)).toBe('76');
    });

    it('should map undefined to an empty string', () => {
      expect(formatHandoffRatioInput(undefined)).toBe('');
    });

    it('should map a ratio of 0 to "0"', () => {
      expect(formatHandoffRatioInput(0)).toBe('0');
    });
  });
});
