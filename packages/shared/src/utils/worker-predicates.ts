import type { AgentWorker, TerminalWorker, EmbeddedAgentWorker, Worker } from '../schemas/app-server-message.js';

/**
 * Workers backed by a PTY: can receive raw injected input / [internal:*]
 * notifications written directly to a terminal. This predicate is about the
 * DELIVERY MECHANISM (a PTY write), not about which worker kinds are
 * eligible to be a notification target -- see {@link canReceiveNotifications}
 * for that. After the notification delivery seam (SessionManager.
 * deliverWorkerNotification) was introduced, this predicate has two
 * remaining production consumers outside its own definition: that seam's
 * own internal PTY-vs-embedded branch, and send_session_message's
 * explicit-target guard in mcp-server.ts (which combines it with
 * {@link canReceiveSessionMessages} so terminal workers stay valid explicit
 * targets).
 */
export function isPtyBackedWorker(w: Worker): w is AgentWorker | TerminalWorker {
  return w.type === 'agent' || w.type === 'terminal';
}

/**
 * Workers that can be the target of send_session_message in the current
 * implementation. Terminal workers are intentionally excluded (a pre-existing,
 * unrelated asymmetry -- out of scope here). Embedded-agent workers can
 * receive session messages despite having no PTY: delivery routes through
 * EmbeddedAgentWorkerService.sendUserMessage rather than a PTY write, so
 * they are NOT PTY-backed (see isPtyBackedWorker above) but ARE a valid
 * send_session_message target.
 */
export function canReceiveSessionMessages(w: Worker): w is AgentWorker | EmbeddedAgentWorker {
  return w.type === 'agent' || w.type === 'embedded-agent';
}

/**
 * Workers that can be the target of a `create_timer` / `create_conditional_wakeup`
 * notification (delivered via SessionManager.deliverWorkerNotification).
 * Broader than {@link isPtyBackedWorker}: an embedded-agent worker has no
 * PTY at all, but the delivery seam routes to it through
 * EmbeddedAgentWorkerService.sendSystemNotification instead of a PTY write,
 * so it is eligible here even though isPtyBackedWorker(w) is false for it.
 * git-diff workers remain excluded -- they represent no running process.
 */
export function canReceiveNotifications(w: Worker): w is AgentWorker | TerminalWorker | EmbeddedAgentWorker {
  return w.type === 'agent' || w.type === 'terminal' || w.type === 'embedded-agent';
}
