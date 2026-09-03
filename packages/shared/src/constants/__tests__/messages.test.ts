import { describe, expect, it } from 'bun:test'
import {
  EMBEDDED_AGENT_IMAGE_MIME_TYPES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_FILES,
  MAX_TOTAL_FILE_SIZE,
} from '../messages'

describe('message attachment constants', () => {
  it('MAX_MESSAGE_FILES caps the number of attachments per message', () => {
    expect(MAX_MESSAGE_FILES).toBe(10)
  })

  it('MAX_TOTAL_FILE_SIZE caps the combined attachment size at 10 MB', () => {
    expect(MAX_TOTAL_FILE_SIZE).toBe(10 * 1024 * 1024)
    expect(MAX_TOTAL_FILE_SIZE).toBe(10_485_760)
  })

  it('EMBEDDED_AGENT_IMAGE_MIME_TYPES lists exactly the mime types treated as images', () => {
    expect(EMBEDDED_AGENT_IMAGE_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  })

  it('MAX_IMAGE_ATTACHMENT_BYTES caps a single image attachment at 5 MB', () => {
    expect(MAX_IMAGE_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024)
    expect(MAX_IMAGE_ATTACHMENT_BYTES).toBe(5_242_880)
  })
})
