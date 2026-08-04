import { describe, it, expect } from 'bun:test';
import {
  expandTemplate,
  TemplateExpansionError,
} from '../template.js';

describe('expandTemplate', () => {
  describe('basic expansion', () => {
    it('should expand {{prompt}} placeholder with shell-escaped inline prompt', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: 'Hello World',
        cwd: '/repo',
      });

      expect(result.command).toBe("test-cli 'Hello World'");
      expect(result.env).toEqual({});
    });

    it('should expand {{cwd}} placeholder with shell-escaped path', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: '/path/to/repo',
      });

      // cwd and prompt are both shell-escaped (single-quoted) for safety
      expect(result.command).toBe("cd '/path/to/repo' && run 'test'");
      expect(result.env).toEqual({});
    });

    it('should expand both {{prompt}} and {{cwd}} placeholders', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && test-cli {{prompt}}',
        prompt: 'my task',
        cwd: '/workspace',
      });

      expect(result.command).toBe("cd '/workspace' && test-cli 'my task'");
      expect(result.env).toEqual({});
    });

    it('should handle multiple {{prompt}} placeholders', () => {
      const result = expandTemplate({
        template: 'cmd {{prompt}} --extra {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
      });

      expect(result.command).toBe("cmd 'test' --extra 'test'");
      expect(result.env).toEqual({});
    });

    it('should handle multiple {{cwd}} placeholders', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && ls {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
      });

      // Each cwd is shell-escaped (single-quoted) for safety
      expect(result.command).toBe("cd '/repo' && ls '/repo' && run 'test'");
      expect(result.env).toEqual({});
    });
  });

  describe('templates without {{prompt}}', () => {
    it('should work without {{prompt}} placeholder when no prompt provided', () => {
      const result = expandTemplate({
        template: 'test-cli --continue',
        cwd: '/repo',
      });

      expect(result.command).toBe('test-cli --continue');
      expect(result.env).toEqual({});
    });

    it('should expand {{cwd}} even without {{prompt}}', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && test-cli --continue',
        cwd: '/path/to/repo',
      });

      // cwd is shell-escaped (single-quoted) for safety
      expect(result.command).toBe("cd '/path/to/repo' && test-cli --continue");
      expect(result.env).toEqual({});
    });
  });

  describe('error handling', () => {
    it('should throw error for empty template', () => {
      expect(() =>
        expandTemplate({
          template: '',
          prompt: 'test',
          cwd: '/repo',
        })
      ).toThrow(TemplateExpansionError);
    });

    it('should throw error for whitespace-only template', () => {
      expect(() =>
        expandTemplate({
          template: '   ',
          prompt: 'test',
          cwd: '/repo',
        })
      ).toThrow(TemplateExpansionError);
    });
  });

  describe('no prompt provided', () => {
    it('should expand {{prompt}} with empty shell-escaped string when no prompt provided', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        cwd: '/repo',
      });

      expect(result.command).toBe("test-cli ''");
      expect(result.env).toEqual({});
    });

    it('should allow starting agents interactively without initial prompt', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: undefined,
        cwd: '/repo',
      });

      expect(result.command).toBe("test-cli ''");
      expect(result.env).toEqual({});
    });
  });

  describe('special characters in prompt', () => {
    it('should safely handle prompts with shell metacharacters', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: 'test; rm -rf /',
        cwd: '/repo',
      });

      // Single-quoted: every metacharacter is a literal, no command substitution.
      expect(result.command).toBe("test-cli 'test; rm -rf /'");
      expect(result.env).toEqual({});
    });

    it('should safely handle prompts with quotes', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: 'Say "hello" and \'goodbye\'',
        cwd: '/repo',
      });

      // Double quotes pass through inside single-quoted literal;
      // embedded single quote is escaped via '\''.
      expect(result.command).toBe("test-cli 'Say \"hello\" and '\\''goodbye'\\'''");
      expect(result.env).toEqual({});
    });

    it('should safely handle prompts with newlines', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: 'Line 1\nLine 2\nLine 3',
        cwd: '/repo',
      });

      // Newlines are preserved literally inside single-quoted shell literals.
      expect(result.command).toBe("test-cli 'Line 1\nLine 2\nLine 3'");
      expect(result.env).toEqual({});
    });

    it('should safely handle prompts with dollar signs', () => {
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt: '$HOME and $(whoami)',
        cwd: '/repo',
      });

      // Single quotes suppress all expansion (no $VAR, no $(...) substitution).
      expect(result.command).toBe("test-cli '$HOME and $(whoami)'");
      expect(result.env).toEqual({});
    });

    it('should not interpret String.replace special replacement patterns ($$, $&, $`, $\') in the prompt', () => {
      // String.prototype.replace() treats a STRING second argument
      // specially: $$ -> literal $, $& -> the matched substring, $` -> text
      // before the match, $' -> text after the match. A plain-string
      // replacer would silently mangle a prompt containing these sequences
      // before it ever reaches the shell. This locks in the function-form
      // replacer fix for the inline-prompt branch.
      const prompt = 'price is $$5, ref $&, before $` marker, after $\' marker';
      const result = expandTemplate({
        template: 'test-cli {{prompt}}',
        prompt,
        cwd: '/repo',
      });

      // shellEscape wraps in single quotes; the one literal `'` in the
      // prompt (from `$'`) is itself escaped via the `'\''` technique
      // (see the "should safely handle prompts with quotes" test above) --
      // that escaping is orthogonal to this test's concern, which is that
      // NONE of the $$/$&/$`/$' sequences get reinterpreted as
      // String.replace patterns.
      expect(result.command).toBe(
        "test-cli 'price is $$5, ref $&, before $` marker, after $'\\'' marker'"
      );
      expect(result.env).toEqual({});
    });
  });

  describe('path handling', () => {
    it('should handle paths with spaces in {{cwd}}', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: '/path/with spaces/repo',
      });

      // Paths with spaces are safely handled by single-quoting
      expect(result.command).toBe("cd '/path/with spaces/repo' && run 'test'");
      expect(result.env).toEqual({});
    });

    it('should handle paths with special characters', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: "/path/with'quote/repo",
      });

      // Single quotes in paths are escaped using the '\'' technique
      expect(result.command).toBe("cd '/path/with'\\''quote/repo' && run 'test'");
      expect(result.env).toEqual({});
    });

    it('should not interpret String.replace special replacement patterns ($&) in cwd', () => {
      // Same String.prototype.replace() trap as {{prompt}}: a plain-string
      // replacer would silently mangle a cwd containing these sequences.
      // Locks in the function-form replacer fix for the {{cwd}} site.
      const result = expandTemplate({
        template: 'cd {{cwd}} && run {{prompt}}',
        prompt: 'test',
        cwd: '/repo/$&marker',
      });

      expect(result.command).toBe("cd '/repo/$&marker' && run 'test'");
      expect(result.env).toEqual({});
    });
  });
});

describe('custom template variables', () => {
  describe('default value expansion', () => {
    it('should expand {{model:claude-opus-4-6}} to shell-escaped default when no templateVars provided', () => {
      const result = expandTemplate({
        template: 'cli --model {{model:claude-opus-4-6}} {{prompt}}',
        prompt: 'do stuff',
        cwd: '/repo',
      });

      expect(result.command).toBe("cli --model 'claude-opus-4-6' 'do stuff'");
      expect(result.env).toEqual({});
    });

    it('should expand {{model}} (no default) to empty string when no templateVars provided', () => {
      const result = expandTemplate({
        template: 'cli --model {{model}} {{prompt}}',
        prompt: 'do stuff',
        cwd: '/repo',
      });

      expect(result.command).toBe("cli --model  'do stuff'");
    });
  });

  describe('templateVars override defaults', () => {
    it('should override default value when templateVars provides a value', () => {
      const result = expandTemplate({
        template: 'cli --model {{model:claude-opus-4-6}} {{prompt}}',
        prompt: 'do stuff',
        cwd: '/repo',
        templateVars: { model: 'gpt-4' },
      });

      expect(result.command).toBe("cli --model 'gpt-4' 'do stuff'");
    });

    it('should override no-default variable when templateVars provides a value', () => {
      const result = expandTemplate({
        template: 'cli --model {{model}} {{prompt}}',
        prompt: 'do stuff',
        cwd: '/repo',
        templateVars: { model: 'gpt-4' },
      });

      expect(result.command).toBe("cli --model 'gpt-4' 'do stuff'");
    });
  });

  describe('multiple custom variables', () => {
    it('should expand multiple custom variables in one template', () => {
      const result = expandTemplate({
        template: 'cli --model {{model:default-model}} --temp {{temperature:0.7}} {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
        templateVars: { model: 'gpt-4' },
      });

      // model overridden, temperature uses default
      expect(result.command).toBe("cli --model 'gpt-4' --temp '0.7' 'test'");
    });
  });

  describe('interaction with reserved variables', () => {
    it('should work alongside {{prompt}} and {{cwd}}', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && cli --model {{model:default}} {{prompt}}',
        prompt: 'my task',
        cwd: '/workspace',
        templateVars: { model: 'sonnet' },
      });

      expect(result.command).toBe("cd '/workspace' && cli --model 'sonnet' 'my task'");
      expect(result.env).toEqual({});
    });

    it('should NOT allow templateVars to override {{prompt}} expansion', () => {
      const result = expandTemplate({
        template: 'cli {{prompt}}',
        prompt: 'real prompt',
        cwd: '/repo',
        templateVars: { prompt: 'hacked' },
      });

      // {{prompt}} should still expand to the real prompt, not the templateVars value
      expect(result.command).toBe("cli 'real prompt'");
      expect(result.env).toEqual({});
    });

    it('should NOT allow templateVars to override {{cwd}} expansion', () => {
      const result = expandTemplate({
        template: 'cd {{cwd}} && cli {{prompt}}',
        prompt: 'test',
        cwd: '/real/path',
        templateVars: { cwd: '/hacked/path' },
      });

      expect(result.command).toBe("cd '/real/path' && cli 'test'");
    });
  });

  describe('continueTemplate (without {{prompt}})', () => {
    it('should expand custom variables in continueTemplate', () => {
      const result = expandTemplate({
        template: 'cli --model {{model:default-model}} --continue',
        cwd: '/repo',
        templateVars: { model: 'sonnet' },
      });

      expect(result.command).toBe("cli --model 'sonnet' --continue");
      expect(result.env).toEqual({});
    });

    it('should use default when no templateVars provided for continueTemplate', () => {
      const result = expandTemplate({
        template: 'cli --model {{model:default-model}} --continue',
        cwd: '/repo',
      });

      expect(result.command).toBe("cli --model 'default-model' --continue");
    });
  });

  describe('headlessTemplate (with {{prompt}})', () => {
    it('should expand custom variables in headlessTemplate alongside {{prompt}}', () => {
      const result = expandTemplate({
        template: 'cli --model {{model:default-model}} -p {{prompt}}',
        prompt: 'headless task',
        cwd: '/repo',
        templateVars: { model: 'haiku' },
      });

      expect(result.command).toBe("cli --model 'haiku' -p 'headless task'");
      expect(result.env).toEqual({});
    });
  });

  describe('shell escaping of custom variable values', () => {
    it('should shell-escape values with spaces', () => {
      const result = expandTemplate({
        template: 'cli --model {{model}} {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
        templateVars: { model: 'my model name' },
      });

      expect(result.command).toBe("cli --model 'my model name' 'test'");
    });

    it('should shell-escape values with single quotes', () => {
      const result = expandTemplate({
        template: 'cli --model {{model}} {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
        templateVars: { model: "it's-a-model" },
      });

      expect(result.command).toBe("cli --model 'it'\\''s-a-model' 'test'");
    });

    it('should shell-escape values with double quotes and semicolons', () => {
      const result = expandTemplate({
        template: 'cli --note {{note}} {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
        templateVars: { note: 'say "hello"; rm -rf /' },
      });

      expect(result.command).toBe("cli --note 'say \"hello\"; rm -rf /' 'test'");
    });

    it('should shell-escape default values with special characters', () => {
      const result = expandTemplate({
        template: 'cli --flag {{flag:value with spaces}} {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
      });

      expect(result.command).toBe("cli --flag 'value with spaces' 'test'");
    });
  });
});

describe('optional-argument form {{var:+prefix}}', () => {
  describe('parsing collision with the default-value form', () => {
    it('should treat {{var:+prefix}} as the optional-argument form, NOT a default value literal "+prefix"', () => {
      // Under the pre-existing default-value regex alone, "{{flag:+--flag}}"
      // parses as name "flag" with default value "+--flag" (the literal "+"
      // included), which would expand to "cli '+--flag' 'test'" when flag is
      // unset. This test locks in that the optional-argument form is
      // recognized first and takes precedence: unset -> empty string, not the
      // "+--flag" default-value literal.
      const result = expandTemplate({
        template: 'cli {{flag:+--flag}} {{prompt}}',
        prompt: 'test',
        cwd: '/repo',
      });

      expect(result.command).not.toBe("cli '+--flag' 'test'");
      expect(result.command).toBe("cli  'test'");
    });
  });

  describe('byte-identity regression', () => {
    it('should produce a command byte-identical to the plain {{prompt}} template when the var is unset', () => {
      const withOptionalArg = expandTemplate({
        template: 'claude {{model:+--model}}{{prompt}}',
        prompt: 'do the task',
        cwd: '/repo',
      });
      const legacy = expandTemplate({
        template: 'claude {{prompt}}',
        prompt: 'do the task',
        cwd: '/repo',
      });

      expect(withOptionalArg.command).toBe(legacy.command);
      expect(withOptionalArg.command).toBe("claude 'do the task'");
      expect(withOptionalArg.env).toEqual({});
    });
  });

  describe('value provided', () => {
    it('should expand to "prefix <escaped value> " with a trailing space when templateVars provides a non-empty value', () => {
      const result = expandTemplate({
        template: 'claude {{model:+--model}}{{prompt}}',
        prompt: 'do the task',
        cwd: '/repo',
        templateVars: { model: 'claude-sonnet-5' },
      });

      expect(result.command).toBe("claude --model 'claude-sonnet-5' 'do the task'");
      expect(result.env).toEqual({});
    });

    it('should shell-escape a value containing spaces and quotes as a single argument', () => {
      const result = expandTemplate({
        template: 'claude {{model:+--model}}{{prompt}}',
        prompt: 'test',
        cwd: '/repo',
        templateVars: { model: "weird model's name" },
      });

      expect(result.command).toBe("claude --model 'weird model'\\''s name' 'test'");
    });

    it('should expand the form correctly when used twice in the same template', () => {
      const result = expandTemplate({
        template: 'cli {{model:+--model}}{{temperature:+--temp}}{{prompt}}',
        prompt: 'test',
        cwd: '/repo',
        templateVars: { model: 'sonnet', temperature: '0.7' },
      });

      expect(result.command).toBe("cli --model 'sonnet' --temp '0.7' 'test'");
    });
  });

  describe('value absent or empty', () => {
    it('should expand to empty string when the var is not present in templateVars at all', () => {
      const result = expandTemplate({
        template: 'claude {{model:+--model}}{{prompt}}',
        prompt: 'test',
        cwd: '/repo',
      });

      expect(result.command).toBe("claude 'test'");
    });

    it('should expand to empty string when templateVars provides an empty string (mirrors POSIX ${var:+word})', () => {
      const result = expandTemplate({
        template: 'claude {{model:+--model}}{{prompt}}',
        prompt: 'test',
        cwd: '/repo',
        templateVars: { model: '' },
      });

      expect(result.command).toBe("claude 'test'");
    });
  });

  describe('reserved variable guard', () => {
    it('should NOT expand {{prompt:+X}} through the optional-argument form', () => {
      const result = expandTemplate({
        template: 'cli {{prompt:+--extra}}',
        prompt: 'real prompt',
        cwd: '/repo',
      });

      // {{prompt}} (no colon) is already expanded before this point via its
      // own dedicated regex, which does not match "{{prompt:+--extra}}", so
      // this placeholder reaches the optional-argument pass unexpanded. The
      // reserved-name guard there must also refuse to expand it.
      expect(result.command).toBe('cli {{prompt:+--extra}}');
    });

    it('should NOT expand {{cwd:+X}} through the optional-argument form', () => {
      const result = expandTemplate({
        template: 'cli {{cwd:+--extra}}',
        prompt: 'test',
        cwd: '/repo',
      });

      expect(result.command).toBe('cli {{cwd:+--extra}}');
    });
  });
});

describe('promptFilePath option', () => {
  it('should expand {{prompt}} to a quoted command substitution reading the prompt file', () => {
    const result = expandTemplate({
      template: 'claude {{prompt}}',
      promptFilePath: '/home/alice/.agent-console/prompts/w1.prompt',
      cwd: '/repo',
    });

    expect(result.command).toBe(
      `claude "$(cat '/home/alice/.agent-console/prompts/w1.prompt')"`
    );
    expect(result.env).toEqual({});
  });

  it('should shell-escape a promptFilePath containing a single quote', () => {
    const result = expandTemplate({
      template: 'claude {{prompt}}',
      promptFilePath: "/home/al'ice/w1.prompt",
      cwd: '/repo',
    });

    expect(result.command).toBe(`claude "$(cat '/home/al'\\''ice/w1.prompt')"`);
    expect(result.env).toEqual({});
  });

  it('should not interpret String.replace special replacement patterns ($$, $&, $`, $\') in the promptFilePath', () => {
    // Same String.prototype.replace() trap as the inline-prompt branch: a
    // plain-string replacer would silently mangle a path containing these
    // sequences. Paths are derived from AGENT_CONSOLE_HOME / an OS user's
    // homeDir, which could theoretically contain such characters depending
    // on system configuration. Locks in the function-form replacer fix for
    // the promptFilePath branch.
    const promptFilePath = "/home/weird$$user/$&marker/$`before/$'after/w1.prompt";
    const result = expandTemplate({
      template: 'claude {{prompt}}',
      promptFilePath,
      cwd: '/repo',
    });

    // shellEscape wraps in single quotes; the one literal `'` in the path
    // (from `$'`) is itself escaped via the `'\''` technique (see the
    // "should shell-escape a promptFilePath containing a single quote" test
    // above) -- that escaping is orthogonal to this test's concern, which
    // is that NONE of the $$/$&/$`/$' sequences get reinterpreted as
    // String.replace patterns.
    expect(result.command).toBe(
      "claude \"$(cat '/home/weird$$user/$&marker/$`before/$'\\''after/w1.prompt')\""
    );
    expect(result.env).toEqual({});
  });

  it('should throw TemplateExpansionError when both prompt and promptFilePath are provided', () => {
    expect(() =>
      expandTemplate({
        template: 'claude {{prompt}}',
        prompt: 'inline prompt',
        promptFilePath: '/home/alice/.agent-console/prompts/w1.prompt',
        cwd: '/repo',
      })
    ).toThrow(TemplateExpansionError);
  });

  // Regression lock: promptFilePath being absent must not change existing
  // behavior for ordinary inputs (Issue #1234 fix must be byte-identical
  // when unused). This covers the LEGACY CONTRACT, not the legacy $$/$&/
  // $`/$' mangling bug -- inputs containing those sequences now produce
  // verbatim (fixed) output regardless of whether promptFilePath is used;
  // see "should not interpret String.replace special replacement
  // patterns..." above for that corrected contract.
  it('should produce byte-identical output to before when promptFilePath is absent (basic prompt)', () => {
    const result = expandTemplate({
      template: 'test-cli {{prompt}}',
      prompt: 'Hello World',
      cwd: '/repo',
    });

    expect(result.command).toBe("test-cli 'Hello World'");
    expect(result.env).toEqual({});
  });

  it('should produce byte-identical output to before when promptFilePath is absent (special characters)', () => {
    const result = expandTemplate({
      template: 'test-cli {{prompt}}',
      prompt: '$HOME and $(whoami)',
      cwd: '/repo',
    });

    expect(result.command).toBe("test-cli '$HOME and $(whoami)'");
    expect(result.env).toEqual({});
  });

  it('should be a no-op when promptFilePath is set but the template has no {{prompt}}', () => {
    const result = expandTemplate({
      template: 'cli --continue',
      promptFilePath: '/home/alice/.agent-console/prompts/w1.prompt',
      cwd: '/repo',
    });

    expect(result.command).toBe('cli --continue');
    expect(result.env).toEqual({});
  });

  it('should replace multiple {{prompt}} occurrences identically when promptFilePath is set', () => {
    const result = expandTemplate({
      template: 'cmd {{prompt}} --extra {{prompt}}',
      promptFilePath: '/home/alice/.agent-console/prompts/w1.prompt',
      cwd: '/repo',
    });

    const expected = `"$(cat '/home/alice/.agent-console/prompts/w1.prompt')"`;
    expect(result.command).toBe(`cmd ${expected} --extra ${expected}`);
    expect(result.env).toEqual({});
  });
});

describe('TemplateExpansionError', () => {
  it('should be instance of Error', () => {
    const error = new TemplateExpansionError('test message');
    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct name', () => {
    const error = new TemplateExpansionError('test message');
    expect(error.name).toBe('TemplateExpansionError');
  });

  it('should have correct message', () => {
    const error = new TemplateExpansionError('test message');
    expect(error.message).toBe('test message');
  });
});
