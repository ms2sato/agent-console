import { describe, it, expect, beforeEach } from 'bun:test'
import { PTYOperationExecutor } from '../pty-operation-executor'
import { MessageContentProcessor } from '../message-content-processor'
import { SubmitKeystrokeUtils } from '@agent-console/shared'

describe('PTYOperationExecutor', () => {
  let mockPTYWrite: (data: string) => void
  let capturedWrites: string[]

  beforeEach(() => {
    capturedWrites = []
    mockPTYWrite = (data: string) => {
      capturedWrites.push(data)
    }
  })

  describe('injectMessage()', () => {
    it('sends content and submit operation separately', () => {
      const input = 'test\ncontent\nwith\nnewlines'
      const content = MessageContentProcessor.process(input)

      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      expect(capturedWrites.length).toBe(2)

      // First call: content only (no submit operations)
      expect(capturedWrites[0]).toBe('test\ncontent\nwith\nnewlines')
      expect(capturedWrites[0]).not.toContain('\r')

      // Second call: submit operation only
      expect(capturedWrites[1]).toBe('\r')
    })

    it('sends only content when submit is disabled', () => {
      const input = 'test content'
      const content = MessageContentProcessor.process(input)

      PTYOperationExecutor.injectMessage(content, mockPTYWrite, false)

      expect(capturedWrites.length).toBe(1)
      expect(capturedWrites[0]).toBe('test content')
    })

    it('preserves newlines in content but never converts to submit', () => {
      const testCases = [
        '\n\nleading newlines',
        'middle\n\nnewlines',
        'trailing newlines\n\n',
        '\n\n\n\n', // only newlines
        'complex\n\npattern\nwith\n\nmany\n'
      ]

      testCases.forEach(input => {
        capturedWrites = []
        const content = MessageContentProcessor.process(input)

        PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

        // Content write (first call) should preserve newlines as \n
        const contentWrite = capturedWrites[0]
        expect(contentWrite).toContain('\n')
        expect(contentWrite).not.toContain('\r')

        // Submit write (second call) should be separate \r
        const submitWrite = capturedWrites[1]
        expect(submitWrite).toBe('\r')
        expect(submitWrite).not.toContain('\n')
      })
    })

    it('validates content purity before injection', () => {
      // Create contaminated content (simulating old dangerous pattern)
      const contaminatedContent = 'text\rwith\rsubmit' as any

      expect(() => {
        PTYOperationExecutor.injectMessage(contaminatedContent, mockPTYWrite)
      }).toThrow(expect.stringContaining('Contract violation'))
    })

    it('handles empty content correctly', () => {
      const content = MessageContentProcessor.process('')

      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      expect(capturedWrites.length).toBe(2)
      expect(capturedWrites[0]).toBe('')
      expect(capturedWrites[1]).toBe('\r')
    })

    it('handles newline-only content correctly', () => {
      const content = MessageContentProcessor.process('\n\n\n')

      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      expect(capturedWrites.length).toBe(2)
      expect(capturedWrites[0]).toBe('\n\n\n')
      expect(capturedWrites[1]).toBe('\r')
    })
  })

  describe('createSubmitOperation()', () => {
    it('creates proper submit keystroke', () => {
      const submit = PTYOperationExecutor.createSubmitOperation()
      const extracted = SubmitKeystrokeUtils.extract(submit)

      expect(extracted).toBe('\r')
    })

    it('creates distinct submit operations', () => {
      const submit1 = PTYOperationExecutor.createSubmitOperation()
      const submit2 = PTYOperationExecutor.createSubmitOperation()

      expect(SubmitKeystrokeUtils.extract(submit1)).toBe('\r')
      expect(SubmitKeystrokeUtils.extract(submit2)).toBe('\r')
    })
  })

  describe('executeSubmit()', () => {
    it('executes submit keystroke separately from content', () => {
      const submit = PTYOperationExecutor.createSubmitOperation()

      PTYOperationExecutor.executeSubmit(submit, mockPTYWrite)

      expect(capturedWrites.length).toBe(1)
      expect(capturedWrites[0]).toBe('\r')
    })
  })

  describe('migrateLegacyPattern()', () => {
    it('converts dangerous legacy pattern to safe separation', () => {
      // Simulate legacy dangerous pattern input
      const legacyInput = 'text\nwith\nnewlines'

      PTYOperationExecutor.migrateLegacyPattern(legacyInput, mockPTYWrite)

      expect(capturedWrites.length).toBe(2)

      // Should separate content and submit
      expect(capturedWrites[0]).toBe('text\nwith\nnewlines')
      expect(capturedWrites[1]).toBe('\r')
    })

    it('handles legacy edge cases that caused Issue #660', () => {
      const legacyCases = [
        '\n\nproblematic case',
        'text\r\nwith\r\ncrlf',
        '\n\n\n\n',
        'mixed\n\r\ncontent'
      ]

      legacyCases.forEach(input => {
        capturedWrites = []

        PTYOperationExecutor.migrateLegacyPattern(input, mockPTYWrite)

        // Content should not contain submit operations
        expect(capturedWrites[0]).not.toContain('\r')
        // Submit should be separate
        expect(capturedWrites[1]).toBe('\r')
      })
    })
  })

  describe('validatePTYWrite()', () => {
    it('passes validation for function', () => {
      expect(() => {
        PTYOperationExecutor.validatePTYWrite(mockPTYWrite)
      }).not.toThrow()
    })

    it('throws error for non-function', () => {
      const invalidWrites = [null, undefined, 'string', {}, [], 123]

      invalidWrites.forEach(invalid => {
        expect(() => {
          PTYOperationExecutor.validatePTYWrite(invalid)
        }).toThrow(expect.stringContaining('PTY write function is required'))
      })
    })
  })

  describe('Separation of Concerns Verification', () => {
    it('content operations never include submit logic', () => {
      const content = MessageContentProcessor.process('test\ncontent')
      const extractedContent = MessageContentProcessor.extractContent(content)

      // Content processing should never produce submit operations
      expect(extractedContent).not.toContain('\r')
      expect(extractedContent).toContain('\n') // but preserves content newlines
    })

    it('submit operations are completely separate from content', () => {
      const submit = PTYOperationExecutor.createSubmitOperation()
      const submitValue = SubmitKeystrokeUtils.extract(submit)

      // Submit operations should only be submit, no content
      expect(submitValue).toBe('\r')
      expect(submitValue.length).toBe(1)
    })

    it('injection process maintains clear separation', () => {
      const input = '\n\ncomplex\ncontent\nwith\nmany\nnewlines\n'
      const content = MessageContentProcessor.process(input)

      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      const [contentWrite, submitWrite] = capturedWrites

      // Content write contains only normalized content
      expect(contentWrite).toBe(input) // normalized but preserved
      expect(contentWrite).not.toContain('\r')

      // Submit write contains only submit operation
      expect(submitWrite).toBe('\r')
      expect(submitWrite.length).toBe(1)

      // No mixing of responsibilities
      expect(contentWrite).not.toBe(submitWrite)
    })
  })

  describe('Issue #660 Prevention Integration', () => {
    it('prevents exact Issue #660 scenario', () => {
      // Exact input pattern that caused Issue #660
      const problematicInput = '\n\n複数行テキスト1\n複数行テキスト2'
      const content = MessageContentProcessor.process(problematicInput)

      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      expect(capturedWrites.length).toBe(2)

      // Should send as single message, not split
      expect(capturedWrites[0]).toBe('\n\n複数行テキスト1\n複数行テキスト2')
      expect(capturedWrites[1]).toBe('\r')

      // No data loss or splitting
      expect(capturedWrites.length).toBe(2)
    })

    it('prevents all variations of splitting scenarios', () => {
      const splittingScenarios = [
        '\n\nstart',
        'middle\n\nmiddle',
        'end\n\n',
        '\n\na\nb\nc\n',
        '\n\n\n\n\n'
      ]

      splittingScenarios.forEach(input => {
        capturedWrites = []
        const content = MessageContentProcessor.process(input)

        PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

        // Always exactly 2 calls: content + submit
        expect(capturedWrites.length).toBe(2)

        // Content preserved without conversion to submit
        expect(capturedWrites[0]).toBe(input)
        expect(capturedWrites[0]).not.toContain('\r')

        // Separate submit operation
        expect(capturedWrites[1]).toBe('\r')
      })
    })
  })
})