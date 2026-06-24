/**
 * Session metadata suggestion service
 *
 * Uses the specified agent in headless mode to suggest branch names
 * and titles based on user's initial prompt and existing branch examples.
 */
import type { AgentDefinition } from '@agent-console/shared';
import { listAllBranches } from '../lib/git.js';
import { expandTemplate, TemplateExpansionError } from '../lib/template.js';
import { runAsUser } from './privilege-elevation.js';

const TIMEOUT_MS = 30000;

interface SessionMetadataSuggestionRequest {
  prompt: string;
  repositoryPath: string;
  agent: AgentDefinition;
  existingBranches?: string[];
  /**
   * The OS username that requested the suggestion. In multi-user mode this is
   * threaded down so the agent's headless command (e.g. `claude -p ...`) runs
   * with the requesting user's PATH and per-user auth credentials via the
   * `runAsUser` privilege-elevation helper. In single-user mode `runAsUser`
   * bypasses elevation regardless of this value; pass the authenticated
   * username (auth middleware always provides one). Mirrors the Issue #835 /
   * PR #842 pattern in `repository-description-generator.ts`. Issue #856.
   */
  requestUser: string | null;
}

interface SessionMetadataSuggestionResponse {
  branch?: string;
  title?: string;
  error?: string;
}

/**
 * Sanitize a branch name to ensure it's valid for git
 */
function sanitizeBranchName(name: string): string | null {
  const lowercased = name.toLowerCase().replace(/\s+/g, '-');

  // Check if already valid
  if (/^[a-z0-9][a-z0-9/-]*[a-z0-9]$|^[a-z0-9]$/.test(lowercased)) {
    return lowercased;
  }

  // Try to sanitize
  const sanitized = lowercased
    .replace(/[^a-z0-9/-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (sanitized && /^[a-z0-9][a-z0-9/-]*[a-z0-9]$|^[a-z0-9]$/.test(sanitized)) {
    return sanitized;
  }

  return sanitized || null;
}

/**
 * Get list of branches from a repository
 */
async function getBranches(repositoryPath: string): Promise<string[]> {
  return listAllBranches(repositoryPath);
}

/**
 * Build the prompt for the agent to suggest session metadata
 */
function buildMetadataSuggestionPrompt(
  userPrompt: string,
  existingBranches: string[],
): string {
  const exampleBranches = existingBranches.length > 0
    ? `Example branches in this repository: ${existingBranches.slice(0, 10).join(', ')}`
    : '';

  const avoidBranchesInstruction = existingBranches.length > 0
    ? `\n- IMPORTANT: Do NOT use any of these existing branch names: ${existingBranches.join(', ')}
- If your first choice conflicts, generate a contextually different name (e.g., use a more specific description, add a distinguishing word, or use a different perspective on the task)`
    : '';

  return `You are a session metadata generator. Given the following task description, suggest a git branch name and a short title for the session.

Task description:
${userPrompt}

${exampleBranches}

Rules for branch name:
- Use lowercase letters, numbers, and hyphens only
- Use a prefix like feat/, fix/, refactor/, chore/, docs/, test/ if the repository uses them
- Keep it concise but descriptive (max 50 characters total)
- No spaces, underscores, or special characters except hyphens and forward slash for prefix${avoidBranchesInstruction}

Rules for title:
- A short, human-readable title describing the task (max 60 characters)
- Use natural language (e.g., "Add dark mode toggle" or "Fix login validation bug")
- IMPORTANT: Use the same language as the task description above (e.g., if the task is in Japanese, write the title in Japanese)

Output your response as valid JSON with exactly this format:
{"branch": "your-branch-name", "title": "Your Title Here"}

Output ONLY the JSON, nothing else:`;
}

/**
 * Suggest session metadata (branch name, title) using the specified agent
 */
export async function suggestSessionMetadata(
  request: SessionMetadataSuggestionRequest
): Promise<SessionMetadataSuggestionResponse> {
  const { prompt, repositoryPath, agent, existingBranches, requestUser } = request;

  // Check if agent supports headless mode
  if (!agent.capabilities.supportsHeadlessMode) {
    return {
      error: `Agent "${agent.name}" does not support headless mode (headlessTemplate not configured)`,
    };
  }

  // Get existing branches if not provided
  const branches = existingBranches ?? await getBranches(repositoryPath);

  const suggestionPrompt = buildMetadataSuggestionPrompt(prompt, branches);

  try {
    // Expand the headless template with the suggestion prompt
    const { command, env: templateEnv } = expandTemplate({
      template: agent.headlessTemplate!,
      prompt: suggestionPrompt,
      cwd: repositoryPath,
    });

    // Route through the privilege-elevation helper so multi-user mode runs the
    // agent's headless command (e.g. `claude -p ...`) as the requesting user --
    // i.e. with that user's PATH and per-user auth credentials. After Issue
    // #851 / PR #852 the prompt is embedded directly into `command` via
    // shellEscape; `templateEnv` carries only template-level env (typically
    // none for headlessTemplate), plus we add TERM=dumb to suppress
    // interactive settings.
    // In single-user mode (or when requestUser equals the server user) the
    // helper bypasses sudo and spawns directly, preserving prior behavior.
    // Issue #856 (mirrors Issue #835 / PR #842 for repository-description-generator).
    const { stdout, stderr, exitCode, timedOut } = await runAsUser({
      username: requestUser,
      command,
      cwd: repositoryPath,
      env: {
        ...templateEnv,
        // Ensure we don't inherit any interactive settings
        TERM: 'dumb',
      },
      timeoutMs: TIMEOUT_MS,
    });

    if (exitCode !== 0) {
      if (timedOut) {
        return {
          error: `Session metadata suggestion timed out after ${TIMEOUT_MS / 1000} seconds`,
        };
      }
      return {
        error: `Agent command failed: ${stderr.trim() || `exit code ${exitCode}`}`,
      };
    }

    // Clean up the result - try to parse as JSON
    const trimmedResult = stdout.trim();

    // Try to extract JSON from the response (in case there's extra text)
    const jsonMatch = trimmedResult.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // JSON extraction failed - let caller handle fallback
      return {
        error: 'Failed to extract JSON from response',
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as { branch?: string; title?: string };

      if (!parsed.branch) {
        return {
          error: 'Failed to generate branch name: missing branch in response',
        };
      }

      const sanitizedBranch = sanitizeBranchName(parsed.branch);
      if (!sanitizedBranch) {
        return {
          error: `Invalid branch name generated: ${parsed.branch}`,
        };
      }

      return {
        branch: sanitizedBranch,
        title: parsed.title?.trim(),
      };
    } catch {
      // JSON parse failed - let caller handle fallback
      return {
        error: 'Failed to parse JSON response',
      };
    }
  } catch (error) {
    if (error instanceof TemplateExpansionError) {
      return {
        error: `Template expansion failed: ${error.message}`,
      };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      error: `Failed to suggest branch name: ${message}`,
    };
  }
}

export { getBranches };
export type { SessionMetadataSuggestionRequest, SessionMetadataSuggestionResponse };

/**
 * Function type for suggestSessionMetadata (for dependency injection)
 */
export type SuggestSessionMetadataFn = typeof suggestSessionMetadata;
