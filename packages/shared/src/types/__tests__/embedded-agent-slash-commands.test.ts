import { describe, it, expect } from 'bun:test';
import {
  matchSlashCommand,
  matchSlashCommandInList,
  EMBEDDED_AGENT_SLASH_COMMANDS,
} from '../embedded-agent-slash-commands';

describe('matchSlashCommandInList (#1572)', () => {
  const commands = [
    { name: '/compact', description: 'Compact this conversation now' },
    { name: '/cost', description: 'Show current usage' },
  ];

  it('returns the matching entry for an exact match', () => {
    expect(matchSlashCommandInList(commands, '/compact')).toEqual(commands[0]);
  });

  it('matches by first token: trailing arguments are ignored (Architect ruling, #1584 -- no argument grammar declared)', () => {
    expect(matchSlashCommandInList(commands, '/compact extra args')).toEqual(commands[0]);
  });

  it('does NOT match a different word that merely shares a prefix (first-token equality, not startsWith)', () => {
    expect(matchSlashCommandInList(commands, '/compactx')).toBeNull();
  });

  it('returns null for a command name not in the list', () => {
    expect(matchSlashCommandInList(commands, '/unknown')).toBeNull();
  });

  it('trims leading/trailing whitespace before comparing', () => {
    expect(matchSlashCommandInList(commands, '  /cost  ')).toEqual(commands[1]);
  });

  it('trims whitespace even when trailing arguments are also present', () => {
    expect(matchSlashCommandInList(commands, '  /compact extra  ')).toEqual(commands[0]);
  });

  it('returns null for an empty list', () => {
    expect(matchSlashCommandInList([], '/compact')).toBeNull();
  });
});

describe('matchSlashCommand (#1572)', () => {
  it('delegates to the engine-keyed table in EMBEDDED_AGENT_SLASH_COMMANDS', () => {
    expect(matchSlashCommand('claude-sdk', '/compact')).toEqual(EMBEDDED_AGENT_SLASH_COMMANDS['claude-sdk'][0]);
    expect(matchSlashCommand('openai-api', '/compact')).toEqual(EMBEDDED_AGENT_SLASH_COMMANDS['openai-api'][0]);
  });

  it('returns null when the engine does not honour the command', () => {
    // '/cost' is only in the claude-sdk table, not openai-api's.
    expect(matchSlashCommand('openai-api', '/cost')).toBeNull();
  });

  it('matches trailing-args text by first token when the base name is known for that engine', () => {
    expect(matchSlashCommand('claude-sdk', '/compact extra')).toEqual(EMBEDDED_AGENT_SLASH_COMMANDS['claude-sdk'][0]);
  });

  it('does NOT match a prefix-sharing word (first-token equality, not startsWith)', () => {
    expect(matchSlashCommand('claude-sdk', '/compactx')).toBeNull();
  });
});
