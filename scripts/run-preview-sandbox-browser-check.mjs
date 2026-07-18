#!/usr/bin/env bun
/**
 * Real-Chromium regression runner for the embedded-agent HTML/SVG preview
 * sanitizer (Issue #1162).
 *
 * `bun:test` in this repo runs on happy-dom, which does NOT faithfully
 * reproduce Chromium's HTML5 foreign-content/RAWTEXT/adoption-agency parsing
 * (confirmed empirically -- see packages/client/src/lib/__tests__/preview-sandbox.test.ts
 * "mXSS regression corpus"). Per the discipline in
 * .claude/rules/os-environment-coupling.md ("verify on the real target, do
 * not fake it in the test env"), this script re-verifies the corpus against
 * a REAL Chromium browser (via Playwright's CDP driver), driving the exact
 * production composition (`<iframe sandbox="">` + `buildPreviewDocument`'s
 * CSP, as wired in PreviewPanel.tsx).
 *
 * This is test infrastructure only:
 *   - Zero production code changes. The production sanitizer
 *     (packages/client/src/lib/preview-sandbox.ts) is read-only imported
 *     (via Bun.build, browser-target bundling) and never modified.
 *   - Zero tokenizer / allowlist implementation. This script does not
 *     attempt to neutralize the known gap (Issue #1162) -- it documents /
 *     regression-guards the CURRENT state.
 *   - Corpus vectors are read from the shared fixture
 *     packages/client/src/lib/__fixtures__/preview-sandbox-corpus.ts, the
 *     same fixture preview-sandbox.test.ts consumes. Do not duplicate
 *     vectors here.
 *
 * What this script checks, per corpus vector (NEUTRALIZED_VECTORS +
 * KNOWN_GAP_VECTOR):
 *
 *   1. PRODUCTION CONTAINMENT (blocking). Builds the exact document
 *      PreviewPanel.tsx would build (sanitize -> buildPreviewDocument) and
 *      loads it into a real `<iframe>` using PreviewPanel.tsx's OWN current
 *      `sandbox` attribute value (read from its source, not hardcoded --
 *      see readProductionIframeAttrs below, so a future weakening of that
 *      attribute is caught here too). Asserts no script execution reaches
 *      observable state: no JS dialog (alert/confirm/prompt) fires, and no
 *      "script executed" console signal appears. This must hold for EVERY
 *      vector, including the known gap -- containment does not depend on
 *      sanitizer completeness (see PR #1164's empirical finding that
 *      sandbox="" alone fully contains the known gap).
 *
 *   2. RE-PARSE NEUTRALIZATION (blocking for NEUTRALIZED_VECTORS only,
 *      informational for KNOWN_GAP_VECTOR). Mirrors
 *      preview-sandbox.test.ts's assertFullyNeutralizedAcrossReparse, but
 *      using real Chromium's DOMParser (via the injected production
 *      bundle) instead of happy-dom's. For NEUTRALIZED_VECTORS this
 *      confirms real Chromium agrees with happy-dom (the actual value this
 *      script adds beyond the existing bun:test coverage). For
 *      KNOWN_GAP_VECTOR this is expected to currently find a survivor
 *      (documents/reproduces the Issue #1162 gap under real Chromium,
 *      automating what was previously a one-off manual Chrome DevTools MCP
 *      session) -- NOT treated as a failure, so a future tokenizer fix does
 *      not have to touch this script to land (see the containment-invariant
 *      test's rationale in preview-sandbox.test.ts for the same principle).
 *
 * Chromium resolution: this script never bundles its own browser. It
 * resolves an existing Chromium/Chrome install via (in order): the
 * PREVIEW_CHECK_CHROMIUM_PATH env var, then common system install paths
 * (Linux google-chrome/chromium, macOS Google Chrome.app, and this repo's
 * documented aarch64 dev-machine path via the snap chromium ELF binary --
 * see the `chrome-mcp-aarch64-setup` skill for why the snap launcher
 * wrapper cannot be used directly). If none is found, exits 2 with setup
 * guidance -- this is an environment problem, not a security finding.
 *
 * Usage:
 *   bun scripts/run-preview-sandbox-browser-check.mjs
 *   PREVIEW_CHECK_CHROMIUM_PATH=/path/to/chrome bun scripts/run-preview-sandbox-browser-check.mjs
 *   bun scripts/run-preview-sandbox-browser-check.mjs --headed   # visible browser, for local debugging
 *
 * Exit codes:
 *   0  all blocking assertions passed
 *   1  one or more blocking assertions failed (containment or neutralization regression)
 *   2  bad usage / environment problem (no Chromium found, harness self-test failed)
 */

import { chromium } from 'playwright-core';
import { existsSync, readFileSync } from 'fs';
import { NEUTRALIZED_VECTORS, KNOWN_GAP_VECTOR } from '../packages/client/src/lib/__fixtures__/preview-sandbox-corpus.ts';

const PRODUCTION_SANITIZER_PATH = new URL('../packages/client/src/lib/preview-sandbox.ts', import.meta.url).pathname;
const PREVIEW_PANEL_PATH = new URL('../packages/client/src/components/workers/PreviewPanel.tsx', import.meta.url)
  .pathname;

const HEADED = process.argv.includes('--headed');

/**
 * Reads PreviewPanel.tsx's own iframe `sandbox` attribute value directly
 * from source, rather than hardcoding `""` here. This is deliberate: a
 * future PR that weakens the production sandbox composition (e.g. adds
 * `allow-scripts`) changes what this script feeds into the real iframe too,
 * so the containment check below would then actually observe execution
 * instead of silently continuing to assert against a stale, hardcoded
 * value. Read-only -- never writes PreviewPanel.tsx.
 *
 * Caveat verified empirically while building this script: the sandbox
 * attribute is NOT the only containment layer -- buildPreviewDocument's CSP
 * (`default-src 'none'`) independently blocks inline event-handler
 * execution regardless of the iframe's sandbox tokens (confirmed by
 * temporarily weakening this attribute locally to `"allow-scripts
 * allow-modals"` during development: the containment check still passed,
 * because CSP alone was still blocking it). This script cannot exercise a
 * CSP-only regression the same way, since that would require editing
 * preview-sandbox.ts -- forbidden by this Issue's zero-production-code-
 * change constraint. The harness self-test below (checkRawContainment with
 * no sanitizer/CSP involved at all) is what proves the dialog-detection
 * mechanism itself works; this function's value is specifically about the
 * sandbox layer, one of the two independent layers PR #1164 documented.
 */
function readProductionIframeSandboxAttr() {
  const source = readFileSync(PREVIEW_PANEL_PATH, 'utf-8');
  const match = source.match(/<iframe[\s\S]*?\bsandbox="([^"]*)"/);
  if (!match) {
    throw new Error(
      `Could not find an <iframe sandbox="..."> attribute in ${PREVIEW_PANEL_PATH}. ` +
        'This script reads the production sandbox composition directly from source; ' +
        'if PreviewPanel.tsx changed shape, update the regex above (do not hardcode a value).',
    );
  }
  return match[1];
}

function resolveChromiumExecutablePath() {
  const envOverride = process.env.PREVIEW_CHECK_CHROMIUM_PATH;
  if (envOverride) {
    if (!existsSync(envOverride)) {
      throw new Error(`PREVIEW_CHECK_CHROMIUM_PATH=${envOverride} does not exist`);
    }
    return envOverride;
  }
  const candidates = [
    // Linux, GitHub Actions ubuntu-latest hosted runners ship Google Chrome preinstalled.
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    // macOS.
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // aarch64 Linux dev machines without a native Google Chrome build: the
    // snap chromium's underlying ELF binary (bypasses the snap launcher
    // wrapper's cgroup check). See the chrome-mcp-aarch64-setup skill.
    //
    // Deliberately NOT included: /usr/bin/chromium-browser, /usr/bin/chromium.
    // Where only snap chromium is installed, both are thin shell wrappers
    // that re-exec /snap/bin/chromium, which refuses to run outside a snap
    // cgroup context -- the exact failure this skill documents. They spawn
    // "successfully" (no error) but the resulting browser never actually
    // runs, so preferring the ELF path below avoids a silent false pass.
    '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    `Could not find a Chromium/Chrome executable in any of:\n${candidates.map((p) => `  ${p}`).join('\n')}\n` +
      'Set PREVIEW_CHECK_CHROMIUM_PATH to an explicit path, install Google Chrome, or ' +
      "(aarch64 Linux) run `sudo snap install chromium` -- see the chrome-mcp-aarch64-setup skill.",
  );
}

/** Bundles the production sanitizer to a browser-runnable ESM string, then injects a
 * `window.__previewSandbox` handle at the end of the SAME module text (a plain top-level
 * statement referencing the module-scope bindings declared above it -- valid regardless
 * of the bundler's own `export {...}` statement, which is harmless and unused here). This
 * is bundling/injection only: the production file itself is read, never written. */
async function buildInjectableSanitizerSource() {
  const result = await Bun.build({
    entrypoints: [PRODUCTION_SANITIZER_PATH],
    format: 'esm',
    target: 'browser',
  });
  if (!result.success) {
    throw new Error(`Bun.build failed for ${PRODUCTION_SANITIZER_PATH}:\n${result.logs.join('\n')}`);
  }
  const bundleSource = await result.outputs[0].text();
  return `${bundleSource}\nwindow.__previewSandbox = { sanitizePreviewFragment, buildPreviewDocument, PREVIEW_CSP };`;
}

const failures = [];
const infoLines = [];
let passes = 0;

function expect(cond, label, detail) {
  if (cond) {
    console.log(`  OK    ${label}`);
    passes++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    failures.push(label);
  }
}

function info(label, detail) {
  console.log(`  INFO  ${label}${detail ? ` -- ${detail}` : ''}`);
  infoLines.push(label);
}

/**
 * Loads `vector` through the exact production pipeline in a fresh page and
 * reports whether any script execution became observable (JS dialog, or a
 * console message Chromium emits when it actually invoked a blocked API)
 * while the payload sits inside an iframe using `sandboxAttr`.
 */
async function checkContainment(browser, vector, sandboxAttr, injectableSource) {
  const page = await browser.newPage();
  let dialogFired = false;
  const consoleMessages = [];
  page.on('dialog', async (dialog) => {
    dialogFired = true;
    await dialog.dismiss();
  });
  page.on('console', (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));

  try {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ type: 'module', content: injectableSource });

    const blobUrl = await page.evaluate((v) => {
      const sanitized = window.__previewSandbox.sanitizePreviewFragment(v);
      const doc = window.__previewSandbox.buildPreviewDocument(sanitized);
      const blob = new Blob([doc], { type: 'text/html' });
      return URL.createObjectURL(blob);
    }, vector);

    await page.evaluate(
      ({ url, sandboxVal }) => {
        const iframe = document.createElement('iframe');
        iframe.sandbox = sandboxVal;
        iframe.referrerPolicy = 'no-referrer';
        iframe.src = url;
        document.body.appendChild(iframe);
      },
      { url: blobUrl, sandboxVal: sandboxAttr },
    );

    // Generous fixed wait: img onerror fires only after the browser
    // attempts (and fails) to load the bogus resource, which can trail
    // slightly behind the iframe's own load event.
    await page.waitForTimeout(800);
  } finally {
    await page.close();
  }

  return { dialogFired, consoleMessages };
}

/**
 * Harness self-test only: loads `rawHtml` into an iframe WITHOUT routing it
 * through the production sanitizer first (checkContainment always
 * sanitizes, by design -- that's the whole point of the real assertions).
 * Used once, with a deliberately permissive sandbox and a known-firing raw
 * payload, to prove the dialog-detection mechanism itself actually observes
 * execution before trusting it to report "not fired" for the real corpus.
 */
async function checkRawContainment(browser, rawHtml, sandboxAttr) {
  const page = await browser.newPage();
  let dialogFired = false;
  page.on('dialog', async (dialog) => {
    dialogFired = true;
    await dialog.dismiss();
  });
  try {
    await page.setContent('<!doctype html><html><body></body></html>');
    const blobUrl = await page.evaluate((raw) => {
      const blob = new Blob([`<!doctype html><html><body>${raw}</body></html>`], { type: 'text/html' });
      return URL.createObjectURL(blob);
    }, rawHtml);
    await page.evaluate(
      ({ url, sandboxVal }) => {
        const iframe = document.createElement('iframe');
        iframe.sandbox = sandboxVal;
        iframe.src = url;
        document.body.appendChild(iframe);
      },
      { url: blobUrl, sandboxVal: sandboxAttr },
    );
    await page.waitForTimeout(800);
  } finally {
    await page.close();
  }
  return { dialogFired };
}

/** Real-Chromium counterpart of preview-sandbox.test.ts's assertFullyNeutralizedAcrossReparse. */
async function checkReparseNeutralization(browser, vector, injectableSource) {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ type: 'module', content: injectableSource });
    return await page.evaluate((v) => {
      const firstPass = window.__previewSandbox.sanitizePreviewFragment(v);
      const reparsed = new DOMParser().parseFromString(firstPass, 'text/html');
      const hasScript = reparsed.querySelectorAll('script').length > 0;
      const hasOnAttr = Array.from(reparsed.querySelectorAll('*')).some((el) =>
        Array.from(el.attributes).some((attr) => attr.name.toLowerCase().startsWith('on')),
      );
      return { hasScript, hasOnAttr };
    }, vector);
  } finally {
    await page.close();
  }
}

async function main() {
  process.chdir(new URL('..', import.meta.url).pathname);

  const executablePath = resolveChromiumExecutablePath();
  console.log(`==> using Chromium executable: ${executablePath}`);

  const sandboxAttr = readProductionIframeSandboxAttr();
  console.log(`==> production iframe sandbox attribute (read from PreviewPanel.tsx): "${sandboxAttr}"`);

  const injectableSource = await buildInjectableSanitizerSource();

  const browser = await chromium.launch({
    executablePath,
    headless: !HEADED,
    // Chromium's OWN process-level OS sandbox (unrelated to the HTML5
    // iframe `sandbox` attribute under test). Disabled for portability
    // across CI/containerized/root environments, as is standard practice
    // for headless Chromium automation. Verified empirically that this
    // flag does not weaken the iframe sandbox boundary this script asserts
    // on (see the harness self-test below, which exercises that boundary
    // with this exact launch config).
    args: ['--no-sandbox'],
  });

  try {
    console.log('\n==> harness self-test (confirms dialog-detection actually observes execution)');
    const selfTestPayload = '<img src=x onerror=alert(1)>';
    const selfTest = await checkRawContainment(browser, selfTestPayload, 'allow-scripts allow-modals');
    if (!selfTest.dialogFired) {
      console.error(
        '  FAIL  self-test: a permissive sandbox ("allow-scripts allow-modals") did not produce an ' +
          'observable dialog for a known-firing raw payload. The detection mechanism itself is broken -- ' +
          'aborting without reporting corpus results (they would be unreliable).',
      );
      process.exit(2);
    }
    console.log('  OK    self-test: permissive sandbox correctly observed execution');

    const allVectors = [...NEUTRALIZED_VECTORS, KNOWN_GAP_VECTOR];

    console.log(`\n==> production containment check (iframe sandbox="${sandboxAttr}"), ${allVectors.length} vectors`);
    for (const { name, vector } of allVectors) {
      const result = await checkContainment(browser, vector, sandboxAttr, injectableSource);
      expect(
        !result.dialogFired,
        `contained: ${name}`,
        result.dialogFired ? 'a JS dialog fired -- script executed despite the production sandbox' : undefined,
      );
      const blockedMsg = result.consoleMessages.find((m) => /sandboxed|blocked script execution/i.test(m));
      if (blockedMsg) info(`  browser confirmed the block: ${blockedMsg}`);
    }

    console.log(`\n==> re-parse neutralization check (real Chromium DOMParser), ${NEUTRALIZED_VECTORS.length} vectors`);
    for (const { name, vector } of NEUTRALIZED_VECTORS) {
      const { hasScript, hasOnAttr } = await checkReparseNeutralization(browser, vector, injectableSource);
      expect(!hasScript && !hasOnAttr, `neutralized: ${name}`, hasScript || hasOnAttr ? 'survivor found on re-parse' : undefined);
    }

    console.log('\n==> re-parse check on known gap vector (Issue #1162, informational -- not a blocking gate)');
    const gapResult = await checkReparseNeutralization(browser, KNOWN_GAP_VECTOR.vector, injectableSource);
    if (gapResult.hasScript || gapResult.hasOnAttr) {
      info(
        `known gap reproduced under real Chromium: ${KNOWN_GAP_VECTOR.name}`,
        'sanitize -> re-parse still yields a live script/on* survivor, matching Issue #1162',
      );
    } else {
      info(
        `known gap did NOT reproduce this run: ${KNOWN_GAP_VECTOR.name}`,
        'the vector was fully neutralized -- if this is consistent across runs, the gap may have closed; verify against Issue #1162 before assuming so',
      );
    }
  } finally {
    await browser.close();
  }

  console.log();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`PASSED: ${passes} assertion(s) passed (${infoLines.length} informational note(s), see INFO lines above)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`PROBE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
