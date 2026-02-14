/**
 * Repository description generation service
 *
 * Uses the specified agent in headless mode to generate a brief description
 * of a repository based on its README file.
 */
import * as path from 'node:path';
import type { AgentDefinition } from '@agent-console/shared';
import { expandTemplate, TemplateExpansionError } from '../lib/template.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('service:description-generator');

const README_CANDIDATES = ['README.md', 'README', 'README.txt', 'README.rst'];
const README_MAX_LENGTH = 8000;
const TIMEOUT_MS = 30000;

interface RepositoryDescriptionRequest {
  repositoryPath: string;
  agent: AgentDefinition;
}

interface RepositoryDescriptionResponse {
  description?: string;
  error?: string;
}

/**
 * Try to read a README file from the repository.
 * Tries common README filenames in order and returns the first one found.
 */
async function readReadme(repositoryPath: string): Promise<string | null> {
  for (const filename of README_CANDIDATES) {
    const filePath = path.join(repositoryPath, filename);
    try {
      const content = await Bun.file(filePath).text();
      return content;
    } catch {
      // File doesn't exist or can't be read, try next candidate
    }
  }
  return null;
}

/**
 * Build the prompt for the agent to generate a repository description.
 */
function buildDescriptionPrompt(readmeContent: string): string {
  const truncated = readmeContent.length > README_MAX_LENGTH
    ? readmeContent.slice(0, README_MAX_LENGTH) + '\n...(truncated)'
    : readmeContent;

  return `You are a repository description generator. Given the following README content, write a brief description of the repository.

README content:
${truncated}

Rules:
- Write 1-3 sentences (max ~200 characters)
- IMPORTANT: Use the same language as the README (e.g., if the README is in Japanese, write the description in Japanese)
- Output ONLY the description text, nothing else (no quotes, no labels, no markdown)`;
}

/**
 * Generate a repository description using the specified agent in headless mode.
 */
export async function generateRepositoryDescription(
  request: RepositoryDescriptionRequest,
): Promise<RepositoryDescriptionResponse> {
  const { repositoryPath, agent } = request;

  // Check if agent supports headless mode
  if (!agent.capabilities.supportsHeadlessMode) {
    return {
      error: `Agent "${agent.name}" does not support headless mode (headlessTemplate not configured)`,
    };
  }

  // Read README
  const readmeContent = await readReadme(repositoryPath);
  if (!readmeContent) {
    return {
      error: 'No README file found in repository',
    };
  }

  const descriptionPrompt = buildDescriptionPrompt(readmeContent);

  try {
    // Expand the headless template with the description prompt
    const { command, env: templateEnv } = expandTemplate({
      template: agent.headlessTemplate!,
      prompt: descriptionPrompt,
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
    }, TIMEOUT_MS);

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        error: `Agent command failed: ${stderr.trim() || `exit code ${exitCode}`}`,
      };
    }

    const result = await new Response(proc.stdout).text();
    const trimmedResult = result.trim();

    if (!trimmedResult) {
      return {
        error: 'Agent returned empty response',
      };
    }

    logger.info({ repositoryPath }, 'Repository description generated');

    return {
      description: trimmedResult,
    };
  } catch (error) {
    if (error instanceof TemplateExpansionError) {
      return {
        error: `Template expansion failed: ${error.message}`,
      };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      error: `Failed to generate description: ${message}`,
    };
  }
}

export type { RepositoryDescriptionRequest, RepositoryDescriptionResponse };

/**
 * Function type for generateRepositoryDescription (for dependency injection)
 */
export type GenerateRepositoryDescriptionFn = typeof generateRepositoryDescription;
