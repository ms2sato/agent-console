import { describe, it, expect, mock, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isValidRegex } from '@agent-console/shared';
import {
  AgentForm,
  parseAskingPatterns,
  parseAskingPatternsWithValidation,
  type AgentFormData,
} from '../AgentForm';

afterEach(() => {
  cleanup();
});

function renderAgentForm(props: Partial<React.ComponentProps<typeof AgentForm>> = {}) {
  const defaultProps = {
    mode: 'create' as const,
    onSubmit: mock(() => {}),
    onCancel: mock(() => {}),
    isPending: false,
  };

  const mergedProps = { ...defaultProps, ...props };

  return {
    ...render(<AgentForm {...mergedProps} />),
    props: mergedProps,
  };
}

describe('AgentForm', () => {
  describe('create mode', () => {
    it('should render form with empty fields', () => {
      renderAgentForm();

      expect(screen.getByText('Add New Agent')).toBeTruthy();
      expect(screen.getByPlaceholderText('e.g., Aider')).toBeTruthy();
      expect(screen.getByPlaceholderText('e.g., aider --yes -m {{prompt}}')).toBeTruthy();
      expect(screen.getByText('Add Agent')).toBeTruthy();
    });

    it('should submit form with valid data', async () => {
      const user = userEvent.setup();
      // userEvent.type() treats { and } as special characters for keyboard shortcuts.
      // Typing '{{prompt}}' doesn't work as expected in tests, though it works fine in browsers.
      // Workaround: Pre-fill commandTemplate in initialData to avoid typing curly braces.
      // See: https://github.com/testing-library/user-event/issues/584
      const initialData: AgentFormData = {
        name: '',
        commandTemplate: 'myagent --msg {{prompt}}',
      };
      const { props } = renderAgentForm({ initialData });

      // Fill in name field
      const nameInput = screen.getByPlaceholderText('e.g., Aider');
      await user.type(nameInput, 'My Agent');

      // Submit form
      const submitButton = screen.getByText('Add Agent');
      await user.click(submitButton);

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      const formData = submitCall[0] as AgentFormData;
      expect(formData.name).toBe('My Agent');
      expect(formData.commandTemplate).toBe('myagent --msg {{prompt}}');
    });

    it('should show validation error for missing name', async () => {
      const user = userEvent.setup();
      const { props } = renderAgentForm();

      // Fill command template but not name
      const cmdInput = screen.getByPlaceholderText('e.g., aider --yes -m {{prompt}}');
      await user.type(cmdInput, 'myagent {{prompt}}');
      await user.tab();

      // Submit form
      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeTruthy();
      });

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show validation error for command template without {{prompt}}', async () => {
      const user = userEvent.setup();
      const { props } = renderAgentForm();

      // Fill fields with invalid command template
      await user.type(screen.getByPlaceholderText('e.g., Aider'), 'My Agent');
      await user.type(screen.getByPlaceholderText('e.g., aider --yes -m {{prompt}}'), 'myagent');
      await user.tab();

      // Submit form
      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(screen.getByText('Command template must contain {{prompt}} placeholder')).toBeTruthy();
      });

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should call onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const { props } = renderAgentForm();

      await user.click(screen.getByText('Cancel'));

      expect(props.onCancel).toHaveBeenCalledTimes(1);
    });

    it('should show validation error for headless template without {{prompt}}', async () => {
      const user = userEvent.setup();
      // Pre-fill commandTemplate to avoid userEvent curly brace issues
      const initialData: AgentFormData = {
        name: '',
        commandTemplate: 'myagent {{prompt}}',
      };
      const { props } = renderAgentForm({ initialData });

      // Fill name
      await user.type(screen.getByPlaceholderText('e.g., Aider'), 'My Agent');

      // Expand advanced settings
      await user.click(screen.getByText('Advanced Settings'));

      // Fill headless template WITHOUT {{prompt}}
      const headlessInput = screen.getByPlaceholderText('e.g., aider --yes -m {{prompt}} --exit');
      await user.type(headlessInput, 'myagent --headless');
      await user.tab();

      // Submit form
      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(screen.getByText('Headless template must contain {{prompt}}')).toBeTruthy();
      });

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show validation error for invalid regex in asking patterns', async () => {
      const user = userEvent.setup();
      // Pre-fill with invalid regex pattern to avoid userEvent's special handling of [ character
      const initialData: AgentFormData = {
        name: 'My Agent',
        commandTemplate: 'myagent {{prompt}}',
        askingPatternsInput: '[invalid regex',
      };
      const { props } = renderAgentForm({ initialData });

      // With mode: 'onBlur', validation requires the field to be touched
      // Click on the textarea and tab away to trigger blur validation
      const askingPatternsTextarea = screen.getByPlaceholderText(/Enter one regex pattern per line/);
      await user.click(askingPatternsTextarea);
      await user.tab();

      // Submit form - askingPatternsInput has invalid regex
      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(screen.getByText('All patterns must be valid regular expressions')).toBeTruthy();
      });

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should show validation error for ReDoS-vulnerable regex pattern', async () => {
      const user = userEvent.setup();
      // Pre-fill with ReDoS-vulnerable pattern (nested quantifiers)
      const initialData: AgentFormData = {
        name: 'My Agent',
        commandTemplate: 'myagent {{prompt}}',
        askingPatternsInput: '(a+)+',
      };
      const { props } = renderAgentForm({ initialData });

      // Trigger blur validation
      const askingPatternsTextarea = screen.getByPlaceholderText(/Enter one regex pattern per line/);
      await user.click(askingPatternsTextarea);
      await user.tab();

      // Submit form - askingPatternsInput has ReDoS-vulnerable regex
      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(screen.getByText('All patterns must be valid regular expressions')).toBeTruthy();
      });

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should trim whitespace from name', async () => {
      const user = userEvent.setup();
      const initialData: AgentFormData = {
        name: '',
        commandTemplate: 'agent {{prompt}}',
      };
      const { props } = renderAgentForm({ initialData });

      await user.type(screen.getByPlaceholderText('e.g., Aider'), '  Spaced Name  ');
      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as AgentFormData;
      expect(formData.name).toBe('Spaced Name');
    });

    it('should treat whitespace-only name as empty and show validation error', async () => {
      const user = userEvent.setup();
      const initialData: AgentFormData = {
        name: '',
        commandTemplate: 'agent {{prompt}}',
      };
      const { props } = renderAgentForm({ initialData });

      await user.type(screen.getByPlaceholderText('e.g., Aider'), '   ');
      await user.tab();

      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeTruthy();
      });

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it('should allow resubmission after fixing validation errors', async () => {
      const user = userEvent.setup();
      const initialData: AgentFormData = {
        name: '',
        commandTemplate: 'agent {{prompt}}',
      };
      const { props } = renderAgentForm({ initialData });

      // Submit without name - should fail
      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeTruthy();
      });

      expect(props.onSubmit).not.toHaveBeenCalled();

      // Fix the error by adding name
      await user.type(screen.getByPlaceholderText('e.g., Aider'), 'Fixed Agent');

      // Submit again - should succeed
      await user.click(screen.getByText('Add Agent'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as AgentFormData;
      expect(formData.name).toBe('Fixed Agent');
    });
  });

  describe('edit mode', () => {
    const initialData: AgentFormData = {
      name: 'Existing Agent',
      description: 'Test description',
      commandTemplate: 'existing {{prompt}}',
      continueTemplate: 'existing --continue',
      headlessTemplate: '',
      askingPatternsInput: '',
    };

    it('should render form with pre-filled data', () => {
      renderAgentForm({ mode: 'edit', initialData });

      expect(screen.queryByText('Add New Agent')).toBeNull();
      expect(screen.getByDisplayValue('Existing Agent')).toBeTruthy();
      expect(screen.getByDisplayValue('Test description')).toBeTruthy();
      expect(screen.getByDisplayValue('existing {{prompt}}')).toBeTruthy();
      expect(screen.getByText('Save Changes')).toBeTruthy();
    });

    it('should submit form with modified data', async () => {
      const user = userEvent.setup();
      const { props } = renderAgentForm({ mode: 'edit', initialData });

      // Modify name
      const nameInput = screen.getByDisplayValue('Existing Agent');
      await user.clear(nameInput);
      await user.type(nameInput, 'Modified Agent');
      await user.tab();

      // Submit form
      await user.click(screen.getByText('Save Changes'));

      // Extended timeout: edit mode with initialData triggers additional re-renders
      // due to form value synchronization with react-hook-form
      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      }, { timeout: 2000 });

      const submitCall = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0];
      const formData = submitCall[0] as AgentFormData;
      expect(formData.name).toBe('Modified Agent');
    });

    it('should handle clearing optional field in edit mode', async () => {
      const user = userEvent.setup();
      const dataWithDescription: AgentFormData = {
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
        description: 'Original description',
      };
      const { props } = renderAgentForm({ mode: 'edit', initialData: dataWithDescription });

      // Clear description
      const descInput = screen.getByDisplayValue('Original description');
      await user.clear(descInput);
      await user.tab();

      await user.click(screen.getByText('Save Changes'));

      await waitFor(() => {
        expect(props.onSubmit).toHaveBeenCalledTimes(1);
      });

      const formData = (props.onSubmit as ReturnType<typeof mock>).mock.calls[0][0] as AgentFormData;
      expect(formData.description).toBe('');
    });
  });

  describe('advanced settings', () => {
    it('should toggle advanced settings visibility', async () => {
      const user = userEvent.setup();
      renderAgentForm();

      // Advanced settings should be hidden initially
      expect(screen.queryByPlaceholderText('e.g., aider --yes -m {{prompt}} --exit')).toBeNull();

      // Click toggle
      await user.click(screen.getByText('Advanced Settings'));

      // Advanced settings should be visible - headless template field appears
      expect(screen.getByPlaceholderText('e.g., aider --yes -m {{prompt}} --exit')).toBeTruthy();
      // Also verify the asking patterns label is visible
      expect(screen.getByText('Asking Patterns (optional)')).toBeTruthy();
    });

    it('should show advanced settings by default if initialData has headlessTemplate', () => {
      const initialData: AgentFormData = {
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
        headlessTemplate: 'cmd {{prompt}} --exit',
        askingPatternsInput: '',
      };

      renderAgentForm({ mode: 'edit', initialData });

      // Advanced settings should be visible because headlessTemplate has a value
      const headlessInput = screen.getByPlaceholderText('e.g., aider --yes -m {{prompt}} --exit') as HTMLInputElement;
      expect(headlessInput.value).toBe('cmd {{prompt}} --exit');
    });

    it('should show advanced settings by default if initialData has askingPatternsInput', () => {
      const initialData: AgentFormData = {
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
        headlessTemplate: '',
        askingPatternsInput: 'Do you want to.*\\?\n\\[y\\].*\\[n\\]',
      };

      renderAgentForm({ mode: 'edit', initialData });

      // Advanced settings should be visible because askingPatternsInput has a value
      // Query by placeholder text - now a textarea with multi-line placeholder
      const askingInput = screen.getByPlaceholderText(/Enter one regex pattern per line/) as HTMLTextAreaElement;
      expect(askingInput.value).toBe('Do you want to.*\\?\n\\[y\\].*\\[n\\]');
    });
  });

  describe('pending state', () => {
    it('should show overlay message when isPending in create mode', () => {
      renderAgentForm({ isPending: true });

      expect(screen.getByText('Adding agent...')).toBeTruthy();
    });

    it('should show overlay message when isPending in edit mode', () => {
      const initialData: AgentFormData = {
        name: 'Agent',
        commandTemplate: 'cmd {{prompt}}',
      };
      renderAgentForm({ mode: 'edit', initialData, isPending: true });

      expect(screen.getByText('Saving changes...')).toBeTruthy();
    });

    it('should disable fieldset when isPending is true', () => {
      renderAgentForm({ isPending: true });

      const fieldset = document.querySelector('fieldset') as HTMLFieldSetElement;
      expect(fieldset.disabled).toBe(true);
    });
  });

  describe('error display', () => {
    it('should display error message when provided', () => {
      renderAgentForm({ error: 'Something went wrong' });

      expect(screen.getByText('Something went wrong')).toBeTruthy();
    });
  });
});

describe('parseAskingPatterns', () => {
  it('should return undefined for empty input', () => {
    expect(parseAskingPatterns('')).toBeUndefined();
    expect(parseAskingPatterns(undefined)).toBeUndefined();
  });

  it('should parse newline-separated patterns', () => {
    const result = parseAskingPatterns('Do you want to.*\\?\n\\[y\\].*\\[n\\]\ntest>');
    expect(result).toEqual(['Do you want to.*\\?', '\\[y\\].*\\[n\\]', 'test>']);
  });

  it('should trim whitespace from patterns', () => {
    const result = parseAskingPatterns('  pattern1  \n  pattern2  ');
    expect(result).toEqual(['pattern1', 'pattern2']);
  });

  it('should filter out empty lines', () => {
    const result = parseAskingPatterns('pattern1\n\n\npattern2');
    expect(result).toEqual(['pattern1', 'pattern2']);
  });

  it('should return undefined if all lines are empty', () => {
    const result = parseAskingPatterns('\n\n\n');
    expect(result).toBeUndefined();
  });
});

describe('isValidRegex', () => {
  it('should return valid for valid regex patterns', () => {
    expect(isValidRegex('Do you want to.*\\?')).toEqual({ valid: true });
    expect(isValidRegex('\\[y\\].*\\[n\\]')).toEqual({ valid: true });
    expect(isValidRegex('simple text')).toEqual({ valid: true });
    expect(isValidRegex('^start.*end$')).toEqual({ valid: true });
  });

  it('should return invalid with error for invalid regex patterns', () => {
    const result = isValidRegex('[invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return invalid for unbalanced parentheses', () => {
    const result = isValidRegex('(unclosed');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return invalid for ReDoS-vulnerable patterns', () => {
    // Nested quantifiers
    const result1 = isValidRegex('(a+)+');
    expect(result1.valid).toBe(false);
    expect(result1.error).toContain('dangerous');

    // Alternation with quantifier
    const result2 = isValidRegex('(a|b)+');
    expect(result2.valid).toBe(false);
    expect(result2.error).toContain('dangerous');
  });

  it('should return invalid for patterns that are too long', () => {
    const longPattern = 'a'.repeat(501);
    const result = isValidRegex(longPattern);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too long');
  });
});

describe('parseAskingPatternsWithValidation', () => {
  it('should return empty array for empty input', () => {
    expect(parseAskingPatternsWithValidation('')).toEqual([]);
    expect(parseAskingPatternsWithValidation(undefined)).toEqual([]);
  });

  it('should parse patterns with validation status', () => {
    const result = parseAskingPatternsWithValidation('valid.*pattern\n[invalid');
    expect(result).toHaveLength(2);

    expect(result[0].pattern).toBe('valid.*pattern');
    expect(result[0].valid).toBe(true);
    expect(result[0].error).toBeUndefined();

    expect(result[1].pattern).toBe('[invalid');
    expect(result[1].valid).toBe(false);
    expect(result[1].error).toBeDefined();
  });

  it('should filter out empty lines', () => {
    const result = parseAskingPatternsWithValidation('pattern1\n\npattern2');
    expect(result).toHaveLength(2);
    expect(result[0].pattern).toBe('pattern1');
    expect(result[1].pattern).toBe('pattern2');
  });

  it('should trim whitespace from patterns', () => {
    const result = parseAskingPatternsWithValidation('  pattern1  \n  pattern2  ');
    expect(result[0].pattern).toBe('pattern1');
    expect(result[1].pattern).toBe('pattern2');
  });
});
