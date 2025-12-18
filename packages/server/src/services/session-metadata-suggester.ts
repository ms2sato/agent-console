/**
 * Session metadata suggestion service
 *
 * Uses the specified agent in headless mode to suggest branch names
 * and titles based on user's initial prompt and existing branch examples.
 */
import type { AgentDefinition } from '@agent-console/shared';
import { listAllBranches } from '../lib/git.js';
import { expandTemplate, TemplateExpansionError } from '../lib/template.js';

interface SessionMetadataSuggestionRequest {
  prompt: string;
  repositoryPath: string;
  agent: AgentDefinition;
  existingBranches?: string[];
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
  const { prompt, repositoryPath, agent, existingBranches } = request;

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

    // Spawn via shell with the expanded command
    // The prompt is safely passed via environment variable to prevent injection
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd: repositoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ...templateEnv,
        // Ensure we don't inherit any interactive settings
        TERM: 'dumb',
      },
    });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      proc.kill();
    }, 30000);

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        error: `Agent command failed: ${stderr.trim() || `exit code ${exitCode}`}`,
      };
    }

    const result = await new Response(proc.stdout).text();

    // Clean up the result - try to parse as JSON
    const trimmedResult = result.trim();

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
