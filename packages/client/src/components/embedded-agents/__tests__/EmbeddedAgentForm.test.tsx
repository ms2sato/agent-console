import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmbeddedAgentForm, type EmbeddedAgentFormData } from '../EmbeddedAgentForm';

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
