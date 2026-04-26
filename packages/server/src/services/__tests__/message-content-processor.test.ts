import { describe, it, expect } from 'bun:test'
import { MessageContentProcessor } from '../message-content-processor'
import { MessageContentUtils } from '@agent-console/shared'

describe('MessageContentProcessor', () => {
  describe('process()', () => {
    it('creates MessageContent from raw input', () => {
      const input = 'test content\nwith newlines'
      const result = MessageContentProcessor.process(input)

      expect(result).toBeDefined()
      expect(typeof result).toBe('string') // branded type
    })

    it('normalizes input content with proper newlines', () => {
      const testCases = [
        { input: 'simple text', expected: 'simple text' },
        { input: 'text\nwith\nnewlines', expected: 'text\nwith\nnewlines' },
        { input: '\n\nleading newlines', expected: '\n\nleading newlines' },
        { input: 'trailing newlines\n\n', expected: 'trailing newlines\n\n' },
        { input: '\n\nmixed\n\ncontent\n', expected: '\n\nmixed\n\ncontent\n' },
        { input: '', expected: '' },
        { input: '\n', expected: '\n' },
        { input: '\r\n', expected: '\n' }, // Windows-style normalized
        { input: 'text\r\nwith\r\ncrlf', expected: 'text\nwith\ncrlf' } // CRLF normalized
      ]

      testCases.forEach(({ input, expected }) => {
        const result = MessageContentProcessor.process(input)
        expect(MessageContentUtils.raw(result)).toBe(expected)
      })
    })
  })

  describe('extractContent()', () => {
    it('normalizes newlines to soft newlines (\\n)', () => {
      const testCases = [
        { input: 'text\nwith\nnewlines', expected: 'text\nwith\nnewlines' },
        { input: 'text\r\nwith\r\ncrlf', expected: 'text\nwith\ncrlf' },
        { input: 'text\rwith\rcarriage', expected: 'text\nwith\ncarriage' },
        { input: '\n\n\n', expected: '\n\n\n' },
        { input: '\r\n\r\n', expected: '\n\n' },
        { input: '', expected: '' }
      ]

      testCases.forEach(({ input, expected }) => {
        const content = MessageContentProcessor.process(input)
        const result = MessageContentProcessor.extractContent(content)
        expect(result).toBe(expected)
      })
    })

    it('preserves newline count and structure', () => {
      const testCases = [
        '\n\nmulti\nline\ntext\n',
        '\n\n\n\n', // only newlines
        'start\n\n\nend',
        'single\nline'
      ]

      testCases.forEach(input => {
        const content = MessageContentProcessor.process(input)
        const result = MessageContentProcessor.extractContent(content)

        // Count newlines should be preserved
        const originalCount = input.split('\n').length
        const resultCount = result.split('\n').length
        expect(resultCount).toBe(originalCount)
      })
    })
  })

  describe('validatePurity()', () => {
    it('passes validation for pure content (no submit operations)', () => {
      const pureContents = [
        'simple text',
        'text\nwith\nnewlines',
        '\n\n\n',
        'symbols !@#$%^&*()',
        '', // empty string
        'unicode content 日本語'
      ]

      pureContents.forEach(input => {
        const content = MessageContentProcessor.process(input)
        expect(() => MessageContentProcessor.validatePurity(content)).not.toThrow()
      })
    })

    it('throws error for content containing submit operations (\\r)', () => {
      const contaminatedContents = [
        'text\rwith\rsubmit',
        'text\r\nwith\rcrlf',
        '\r',
        'start\rmiddle\rend',
        'text\n\rcontaminated' // mixed newlines and submit
      ]

      contaminatedContents.forEach(input => {
        // Manually create contaminated content (bypassing normal processing)
        const contaminatedContent = input as any

        expect(() => MessageContentProcessor.validatePurity(contaminatedContent)).toThrow()
      })
    })
  })

  describe('shouldProcess()', () => {
    it('returns true for non-empty content', () => {
      const nonEmptyContents = [
        'text',
        'text\nwith\nnewlines',
        '\n\n\n', // newlines only
        '\n text \n', // whitespace with content
        '0', // zero character
        'false' // string 'false'
      ]

      nonEmptyContents.forEach(input => {
        const content = MessageContentProcessor.process(input)
        expect(MessageContentProcessor.shouldProcess(content)).toBe(true)
      })
    })

    it('returns false for empty or whitespace-only content', () => {
      const emptyContents = [
        '',
        ' ', // single space
        '   ', // spaces only
        '\t\t', // tabs only
        ' \t \n ', // mixed whitespace
        '\n\n  \n' // newlines and spaces
      ]

      emptyContents.forEach(input => {
        const content = MessageContentProcessor.process(input)
        expect(MessageContentProcessor.shouldProcess(content)).toBe(false)
      })
    })
  })

  describe('Issue #660 Prevention', () => {
    it('prevents conversion of newlines to submit operations', () => {
      // Exact case that caused Issue #660
      const problematicInput = '\n\ntest content\nwith multiple lines\n'
      const content = MessageContentProcessor.process(problematicInput)
      const result = MessageContentProcessor.extractContent(content)

      // Should NOT contain submit keystrokes
      expect(result).not.toContain('\r')

      // Should preserve all newlines as content
      expect(result.split('\n').length).toBe(problematicInput.split('\n').length)

      // Content should be preserved exactly (after normalization)
      expect(result).toBe(problematicInput)
    })

    it('handles edge cases that could trigger splitting', () => {
      const edgeCases = [
        '\n', // single leading newline
        '\n\n', // double leading newline (original trigger)
        '\n\n\n', // triple newlines
        'text\n\ntext', // newlines between content
        'text\n\ntext\n\n', // mixed patterns
        '\n\nstart\nmiddle\n\nend\n' // complex pattern
      ]

      edgeCases.forEach(input => {
        const content = MessageContentProcessor.process(input)
        const result = MessageContentProcessor.extractContent(content)

        // Critical: no submit operations
        expect(result).not.toContain('\r')

        // Structure preservation
        expect(result.split('\n').length).toBe(input.split('\n').length)
      })
    })
  })
})