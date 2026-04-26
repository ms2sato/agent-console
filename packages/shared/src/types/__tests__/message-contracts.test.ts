import { describe, it, expect } from 'bun:test'
import {
  MessageContentUtils,
  SubmitKeystrokeUtils,
  isMessageContent,
  isSubmitKeystroke
} from '../message-contracts'

describe('Message Contracts Type Safety', () => {
  describe('MessageContentUtils', () => {
    it('create() produces branded MessageContent type', () => {
      const content = MessageContentUtils.create('test content')

      // Type is branded (compile-time check)
      expect(content).toBeDefined()
      expect(typeof content).toBe('string')

      // But retains string operations
      expect((content as string).length).toBeGreaterThan(0)
    })

    it('preserveNewlines() normalizes to soft newlines', () => {
      const testCases = [
        { input: 'text\nwith\nnewlines', expected: 'text\nwith\nnewlines' },
        { input: 'text\r\nwith\r\ncrlf', expected: 'text\nwith\ncrlf' },
        { input: 'text\rwith\rcarriage', expected: 'text\nwith\ncarriage' },
        { input: '\r\n\r\n', expected: '\n\n' },
        { input: '\r', expected: '\n' },
        { input: '', expected: '' }
      ]

      testCases.forEach(({ input, expected }) => {
        const content = MessageContentUtils.create(input)
        const result = MessageContentUtils.preserveNewlines(content)
        expect(result).toBe(expected)
      })
    })

    it('raw() extracts normalized content', () => {
      const testCases = [
        { input: 'test', expected: 'test' },
        { input: 'with\nnewlines', expected: 'with\nnewlines' },
        { input: '\r\n', expected: '\n' },
        { input: '', expected: '' }
      ]

      testCases.forEach(({ input, expected }) => {
        const content = MessageContentUtils.create(input)
        const result = MessageContentUtils.raw(content)
        expect(result).toBe(expected)
      })
    })

    it('isEmpty() correctly identifies empty content', () => {
      const emptyCases = [
        '',
        '   ',
        '\t\t',
        '\n\n  \n',
        ' \t \n '
      ]

      emptyCases.forEach(input => {
        const content = MessageContentUtils.create(input)
        expect(MessageContentUtils.isEmpty(content)).toBe(true)
      })

      const nonEmptyCases = [
        'text',
        'text\nwith\nnewlines',
        '\n\n\n', // newlines are content
        '0',
        'false'
      ]

      nonEmptyCases.forEach(input => {
        const content = MessageContentUtils.create(input)
        expect(MessageContentUtils.isEmpty(content)).toBe(false)
      })
    })
  })

  describe('SubmitKeystrokeUtils', () => {
    it('create() produces branded SubmitKeystroke type', () => {
      const keystroke = SubmitKeystrokeUtils.create()

      expect(keystroke).toBeDefined()
      expect(typeof keystroke).toBe('string')
    })

    it('extract() returns submit keystroke value', () => {
      const keystroke = SubmitKeystrokeUtils.create()
      const result = SubmitKeystrokeUtils.extract(keystroke)

      expect(result).toBe('\r')
    })

    it('create() always returns consistent submit keystroke', () => {
      const keystroke1 = SubmitKeystrokeUtils.create()
      const keystroke2 = SubmitKeystrokeUtils.create()

      expect(SubmitKeystrokeUtils.extract(keystroke1)).toBe('\r')
      expect(SubmitKeystrokeUtils.extract(keystroke2)).toBe('\r')
      expect(SubmitKeystrokeUtils.extract(keystroke1)).toBe(SubmitKeystrokeUtils.extract(keystroke2))
    })
  })

  describe('Type Guards', () => {
    it('isMessageContent() validates message content', () => {
      expect(isMessageContent('test string')).toBe(true)
      expect(isMessageContent('')).toBe(true)
      expect(isMessageContent('with\nnewlines')).toBe(true)

      expect(isMessageContent(null)).toBe(false)
      expect(isMessageContent(undefined)).toBe(false)
      expect(isMessageContent(123)).toBe(false)
      expect(isMessageContent({})).toBe(false)
      expect(isMessageContent([])).toBe(false)
    })

    it('isSubmitKeystroke() validates submit keystroke', () => {
      expect(isSubmitKeystroke('\r')).toBe(true)

      expect(isSubmitKeystroke('not submit')).toBe(false)
      expect(isSubmitKeystroke('\n')).toBe(false)
      expect(isSubmitKeystroke('')).toBe(false)
      expect(isSubmitKeystroke(null)).toBe(false)
      expect(isSubmitKeystroke(undefined)).toBe(false)
      expect(isSubmitKeystroke(123)).toBe(false)
    })
  })

  describe('Type System Contract Enforcement', () => {
    it('MessageContent and SubmitKeystroke are distinct types', () => {
      const content = MessageContentUtils.create('test content')
      const keystroke = SubmitKeystrokeUtils.create()

      // At runtime both are strings, but TypeScript sees them as distinct types
      expect(typeof content).toBe('string')
      expect(typeof keystroke).toBe('string')

      // Values should be different for most cases
      expect(MessageContentUtils.raw(content)).not.toBe(SubmitKeystrokeUtils.extract(keystroke))
    })

    it('branded types prevent accidental mixing', () => {
      // This test verifies the type system design
      // In actual TypeScript usage, these would cause compile errors:

      const content = MessageContentUtils.create('test')
      const keystroke = SubmitKeystrokeUtils.create()

      // These should be caught at compile time:
      // const mixedUp1: MessageContent = keystroke      // ❌ Type error
      // const mixedUp2: SubmitKeystroke = content       // ❌ Type error

      // Runtime validation enforces semantic separation
      expect(isMessageContent(content)).toBe(true)
      expect(isSubmitKeystroke(content)).toBe(false)
      expect(isMessageContent(keystroke)).toBe(false) // Keystroke contains \r (submit operation)
      expect(isSubmitKeystroke(keystroke)).toBe(true)
    })
  })

  describe('Contract Violation Prevention', () => {
    it('MessageContent preserves newlines but never produces submit operations', () => {
      const problematicInputs = [
        '\n\n', // Issue #660 trigger
        'text\nwith\nnewlines',
        '\r\n\r\n', // Windows newlines
        'complex\n\r\nmixed'
      ]

      problematicInputs.forEach(input => {
        const content = MessageContentUtils.create(input)
        const preserved = MessageContentUtils.preserveNewlines(content)

        // Should never contain submit operations
        expect(preserved).not.toContain('\r')

        // But should contain normalized newlines
        if (input.includes('\n') || input.includes('\r')) {
          expect(preserved).toContain('\n')
        }
      })
    })

    it('SubmitKeystroke only produces submit operations', () => {
      const keystroke = SubmitKeystrokeUtils.create()
      const extracted = SubmitKeystrokeUtils.extract(keystroke)

      // Should only be submit operation
      expect(extracted).toBe('\r')
      expect(extracted.length).toBe(1)

      // Should not contain content newlines
      expect(extracted).not.toContain('\n')
    })

    it('prevents Issue #660 pattern at type level', () => {
      // Original dangerous pattern: content.replace(/\r?\n/g, '\r')
      // New safe pattern enforced by types:

      const input = '\n\ntest content\nwith newlines'

      // Step 1: Create proper MessageContent
      const content = MessageContentUtils.create(input)

      // Step 2: Process content (preserves newlines, never converts to submit)
      const processedContent = MessageContentUtils.preserveNewlines(content)
      expect(processedContent).not.toContain('\r')
      expect(processedContent).toContain('\n')

      // Step 3: Create separate submit operation
      const submitKeystroke = SubmitKeystrokeUtils.create()
      const submitValue = SubmitKeystrokeUtils.extract(submitKeystroke)
      expect(submitValue).toBe('\r')

      // Step 4: Verify complete separation
      expect(processedContent).not.toBe(submitValue)
      expect(processedContent + submitValue).not.toBe(input.replace(/\r?\n/g, '\r'))
    })
  })

  describe('Edge Cases and Boundary Conditions', () => {
    it('handles edge cases that could break type contracts', () => {
      const edgeCases = [
        '', // empty string
        '\0', // null character
        '\t\r\n\v\f', // various whitespace
        '🎌日本語\n改行', // unicode content
        'very\0long\nstring'.repeat(1000) // large content
      ]

      edgeCases.forEach(input => {
        const content = MessageContentUtils.create(input)
        const processed = MessageContentUtils.preserveNewlines(content)

        // Should maintain type contracts even for edge cases
        expect(typeof content).toBe('string')
        expect(typeof processed).toBe('string')
        expect(processed).not.toContain('\r')
      })
    })

    it('maintains immutability expectations', () => {
      const original = 'test\ncontent'
      const content = MessageContentUtils.create(original)
      const preserved = MessageContentUtils.preserveNewlines(content)
      const raw = MessageContentUtils.raw(content)

      // Original content should not be modified
      expect(raw).toBe(original)

      // Processed content should be new instance
      expect(preserved).toBe(original) // same value
      expect(preserved !== raw).toBe(false) // but strings are primitives
    })
  })
})