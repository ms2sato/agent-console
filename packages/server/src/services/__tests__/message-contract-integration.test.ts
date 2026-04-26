/**
 * Integration tests for message contract enforcement.
 *
 * Tests the complete flow from input to PTY injection with focus on:
 * - Contract violation prevention
 * - Separation of concerns
 * - Issue #660 class bug prevention
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { MessageContentProcessor } from '../message-content-processor'
import { PTYOperationExecutor } from '../pty-operation-executor'
import { MessageContentUtils, SubmitKeystrokeUtils } from '@agent-console/shared'

describe('Message Contract Integration', () => {
  let mockPTYWrite: (data: string) => void
  let capturedWrites: string[]

  beforeEach(() => {
    capturedWrites = []
    mockPTYWrite = (data: string) => {
      capturedWrites.push(data)
    }
  })

  describe('End-to-End Contract Enforcement', () => {
    it('complete flow maintains separation of concerns', () => {
      const input = '\n\ntest content\nwith newlines\n'

      // Step 1: Process input into semantic message content
      const content = MessageContentProcessor.process(input)

      // Step 2: Validate content purity
      expect(() => MessageContentProcessor.validatePurity(content)).not.toThrow()

      // Step 3: Inject with proper separation
      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      // Verify complete separation maintained throughout
      expect(capturedWrites.length).toBe(2)
      expect(capturedWrites[0]).toBe('\n\ntest content\nwith newlines\n')
      expect(capturedWrites[0]).not.toContain('\r')
      expect(capturedWrites[1]).toBe('\r')
    })

    it('prevents dangerous legacy pattern across full stack', () => {
      // Simulate what the old dangerous code would have done
      const input = '\n\nmultiple\nlines'

      // Old dangerous pattern (for comparison):
      // const dangerous = input.replace(/\r?\n/g, '\r')  // ❌

      // New safe pattern:
      const content = MessageContentProcessor.process(input)
      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      // Verify no dangerous conversion happened
      expect(capturedWrites.join('')).not.toBe(input.replace(/\r?\n/g, '\r'))

      // Verify proper separation
      expect(capturedWrites[0]).toBe(input)
      expect(capturedWrites[1]).toBe('\r')
    })
  })

  describe('Contract Violation Detection', () => {
    it('detects contract violations at any stage', () => {
      // Manually create contaminated content (simulating bug)
      const contaminatedContent = 'text\rwith\rsubmit' as any

      // Should be caught by validation
      expect(() => {
        PTYOperationExecutor.injectMessage(contaminatedContent, mockPTYWrite)
      }).toThrow()

      // PTY should not be called when violation detected
      expect(capturedWrites.length).toBe(0)
    })

    it('validates PTY write function', () => {
      const content = MessageContentProcessor.process('test')

      expect(() => {
        PTYOperationExecutor.injectMessage(content, null as any)
      }).toThrow()

      expect(() => {
        PTYOperationExecutor.injectMessage(content, 'not a function' as any)
      }).toThrow()
    })
  })

  describe('Issue #660 Prevention Integration', () => {
    it('prevents exact Issue #660 reproduction', () => {
      // Exact scenario that caused Issue #660
      const problematicInput = '\n\n複数行テキスト入力\n元の問題: 分割される+一部行抹消\n修正後: 1メッセージとして保持されるべき'

      const content = MessageContentProcessor.process(problematicInput)
      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      // Should be sent as exactly one message + one submit
      expect(capturedWrites.length).toBe(2)

      // Content should be preserved intact
      expect(capturedWrites[0]).toBe(problematicInput)

      // No splitting or data loss
      const originalLines = problematicInput.split('\n')
      const sentLines = capturedWrites[0].split('\n')
      expect(sentLines.length).toBe(originalLines.length)
      expect(sentLines).toEqual(originalLines)

      // Submit is separate
      expect(capturedWrites[1]).toBe('\r')
    })

    it('handles all splitting edge cases from Issue #660', () => {
      const edgeCases = [
        '\n',           // single leading newline
        '\n\n',         // double leading newline (original trigger)
        '\n\n\n',       // triple newlines
        'text\n\n',     // trailing double newlines
        '\n\ntext',     // leading double newlines with text
        'a\n\nb\n\nc',  // multiple double newlines
        '\n\n\n\n\n',   // many consecutive newlines
        'テスト\n\n日本語', // unicode with newlines
      ]

      edgeCases.forEach(input => {
        capturedWrites = []

        const content = MessageContentProcessor.process(input)
        PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

        // Each case should result in exactly 2 writes
        expect(capturedWrites.length).toBe(2)

        // Content should be preserved exactly
        expect(capturedWrites[0]).toBe(input)
        expect(capturedWrites[0]).not.toContain('\r')

        // Submit should be separate
        expect(capturedWrites[1]).toBe('\r')
      })
    })

    it('integration with real PTY-like operations', () => {
      // Simulate more realistic PTY-like operations
      let ptyBuffer = ''
      const realisticPTYWrite = (data: string) => {
        ptyBuffer += data
        capturedWrites.push(data)
      }

      const inputs = [
        'simple command',
        'command\nwith\nargs',
        '\n\ncommand with leading newlines',
        'command\n\n\nwith many newlines'
      ]

      inputs.forEach(input => {
        ptyBuffer = ''
        capturedWrites = []

        const content = MessageContentProcessor.process(input)
        PTYOperationExecutor.injectMessage(content, realisticPTYWrite, true)

        // Buffer should contain content + submit
        expect(ptyBuffer).toBe(input + '\r')

        // But they should have been written separately
        expect(capturedWrites).toEqual([input, '\r'])
      })
    })
  })

  describe('Performance and Edge Case Integration', () => {
    it('handles large content without contract violations', () => {
      const largeContent = 'line\n'.repeat(1000) + 'end'

      const content = MessageContentProcessor.process(largeContent)
      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      expect(capturedWrites.length).toBe(2)
      expect(capturedWrites[0]).toBe(largeContent)
      expect(capturedWrites[0]).not.toContain('\r')
      expect(capturedWrites[1]).toBe('\r')
    })

    it('maintains contracts with special characters', () => {
      const specialCases = [
        'with\0null\nchars',
        'with\ttabs\nand\nnewlines',
        'with\vvertical\ftabs',
        'unicode\n🎌\n日本語\n改行',
        'mixed\r\n\nwindows\nlinux'
      ]

      specialCases.forEach(input => {
        capturedWrites = []

        const content = MessageContentProcessor.process(input)
        PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

        // Contracts maintained even with special chars
        expect(capturedWrites[0]).not.toContain('\r')
        expect(capturedWrites[1]).toBe('\r')

        // Content normalized but preserved
        const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        expect(capturedWrites[0]).toBe(normalized)
      })
    })
  })

  describe('Migration and Compatibility', () => {
    it('legacy migration maintains same end result', () => {
      const inputs = [
        'simple text',
        'text\nwith\nnewlines',
        '\n\nleading newlines',
        'windows\r\ntext'
      ]

      inputs.forEach(input => {
        capturedWrites = []

        // Use migration method
        PTYOperationExecutor.migrateLegacyPattern(input, mockPTYWrite)
        const migrationResult = [...capturedWrites]

        capturedWrites = []

        // Use new method
        const content = MessageContentProcessor.process(input)
        PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)
        const newResult = [...capturedWrites]

        // Should produce equivalent results
        expect(newResult).toEqual(migrationResult)
      })
    })

    it('migration handles dangerous legacy inputs safely', () => {
      // Inputs that would have been dangerous with old pattern
      const dangerousInputs = [
        '\n\n', // Direct Issue #660 trigger
        'text\r\nwith\r\ncrlf',
        '\r\n\r\n',
        'mixed\n\r\ncontent'
      ]

      dangerousInputs.forEach(input => {
        capturedWrites = []

        PTYOperationExecutor.migrateLegacyPattern(input, mockPTYWrite)

        // Should safely separate content and submit
        expect(capturedWrites).toHaveLength(2)
        expect(capturedWrites[0]).not.toContain('\r')
        expect(capturedWrites[1]).toBe('\r')
      })
    })
  })

  describe('Full Stack Contract Verification', () => {
    it('verifies complete type safety chain', () => {
      const input = '\n\nfull stack test\nwith newlines'

      // Create with proper types
      const content = MessageContentProcessor.process(input)

      // Verify type contracts
      expect(MessageContentUtils.preserveNewlines(content)).toBe(input)
      expect(SubmitKeystrokeUtils.extract(SubmitKeystrokeUtils.create())).toBe('\r')

      // Execute with separation
      PTYOperationExecutor.injectMessage(content, mockPTYWrite, true)

      // Verify no contamination across the entire flow
      const allWrites = capturedWrites.join('')
      expect(allWrites).toBe(input + '\r')
      expect(capturedWrites[0]).toBe(input)
      expect(capturedWrites[1]).toBe('\r')
    })
  })
})