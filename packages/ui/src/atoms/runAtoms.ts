import { atom } from 'jotai';
import type {
  AgentEvent,
  ApiError,
  Message,
  StopReason,
  ToolCall,
  WorkspaceContext,
} from '@finagent/core';
import { isRuntimeInfraCode } from '@finagent/core';
import type { FinagentClient } from '../client';
import { activeSessionIdAtom, messagesAtomFamily, sessionsAtom } from './sessionAtoms';

/** Live view of the currently executing run, streamed from kernel events. */
export interface RunView {
  runId: string;
  sessionId: string;
  answer: string;
  toolCalls: ToolCall[];
  error?: ApiError;
  /** V8.1 §38: set when the run terminated as a runtime infrastructure failure
   * (Pi process unavailable). The panel shows a dedicated banner instead of a
   * chat message; cleared on the next run. */
  infraError?: ApiError;
  /** Why a budget or runaway guard stopped this run (#17), when it did. */
  stopReason?: StopReason;
  stopDetail?: Record<string, unknown>;
}

/**
 * Summary of the most recent finished run (V9.1 §12). Powers the AgentPanel
 * footer's Trace affordance. `workspaceContext` is captured at startRun for
 * LIVE runs only (the actual context that run started with) — never
 * reconstructed from current atoms for historical runs.
 */
export interface LastRunSummary {
  runId: string;
  sessionId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  toolCount: number;
  workspaceContext?: WorkspaceContext;
  /**
   * Why the run stopped, when a budget or runaway guard cut it short (#17).
   * Present only when the runtime reported one; the footer explains it instead
   * of calling a guard stop an ordinary completion.
   */
  stopReason?: StopReason;
  /** The numbers behind the stop: which budget ran out, which loop fired. */
  stopDetail?: Record<string, unknown>;
}

export const lastRunSummaryAtom = atom<LastRunSummary | null>(null);

export const runViewAtom = atom<RunView | null>(null);

/** The guard code that stands for each stop reason, on the level below. */
const guardCodes: ReadonlyArray<{ reason: StopReason; code: string }> = [
  { reason: 'budget_exhausted', code: 'BUDGET_EXHAUSTED' },
  { reason: 'loop_detected', code: 'LOOP_DETECTED' },
  { reason: 'retry_storm', code: 'RETRY_STORM' },
];

/**
 * The structured stop reason a terminal event carries (#17), or undefined when
 * the run failed for an ordinary reason. Older events only carry the error, so
 * the guard code is read as a fallback.
 */
function stopOf(payload: { error: ApiError; stopReason?: StopReason; stopDetail?: Record<string, unknown> }): {
  stopReason: StopReason;
  stopDetail?: Record<string, unknown>;
} | undefined {
  if (payload.stopReason !== undefined) {
    return { stopReason: payload.stopReason, stopDetail: payload.stopDetail };
  }
  const reason = guardCodes.find((entry) => entry.code === payload.error.code)?.reason;
  if (reason === undefined) return undefined;
  return {
    stopReason: reason,
    stopDetail: parseGuardDetail(payload.error.message),
  };
}

/**
 * One line explaining a guard stop, plus the numbers the runtime attached to it.
 * Returns undefined for ordinary failures, which keep the raw error message.
 * Accepts the structured stop when the event carries one, and falls back to the
 * error code and the message-embedded detail for events emitted before #17.
 */
export function describeGuardStop(
  error: ApiError,
  stop?: { stopReason: StopReason; stopDetail?: Record<string, unknown> }
): string | undefined {
  const reason = stop?.stopReason ?? reasonOfCode(error.code);
  if (reason === undefined) return undefined;
  const detail = stop !== undefined ? stop.stopDetail : parseGuardDetail(error.message);
  return `Stopped early: ${describeStopReason(reason)}${describeGuardDetail(detail)}. The messages above are what it completed.`;
}

/** The stop reason a guard error code stands for on its own. */
function reasonOfCode(code: string): StopReason | undefined {
  return guardCodes.find((entry) => entry.code === code)?.reason;
}

/** The plain-language reason, used when no translation is at hand. */
function describeStopReason(reason: StopReason): string {
  switch (reason) {
    case 'budget_exhausted':
      return 'the run budget was used up';
    case 'loop_detected':
      return 'a repeating loop was detected';
    case 'retry_storm':
      return 'the run retried too often in a row';
    case 'cancelled':
      return 'you cancelled it';
    default:
      return 'it hit a guard';
  }
}

/** The detail JSON the kernel appends to a guard stop message, when it parses. */
function parseGuardDetail(message: string): Record<string, unknown> | undefined {
  const start = message.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(message.slice(start)) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Render the two shapes a guard detail takes: a budget key, or a repeated signal. */
export function describeGuardDetail(detail: Record<string, unknown> | undefined): string {
  if (detail === undefined) return '';
  if (typeof detail.key === 'string') {
    return ` (${detail.key} ${String(detail.used)}/${String(detail.limit)})`;
  }
  if (typeof detail.tool === 'string' && typeof detail.count === 'number') {
    return ` (${detail.tool} repeated ${detail.count}×)`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Agent event reducer: the kernel is the source of truth; the atoms below are
// pure projections of the `agent:event` stream.
// ---------------------------------------------------------------------------

export const applyAgentEventAtom = atom(
  null,
  (get, set, event: AgentEvent) => {
    const sessionId = event.sessionId;

    // Research/thesis/portfolio synthesis uses the same kernel event bus as
    // the visible copilot. Only project events for the active conversation
    // into the chat UI; internal throwaway sessions must stay silent.
    if (get(activeSessionIdAtom) !== sessionId) return;

    const messages = messagesAtomFamily(sessionId);

    if (event.type === 'run_started') {
      // Kernel persists the user message; surface it in the UI here.
      set(messages, [...get(messages), event.payload.userMessage]);
      set(sessionsAtom, (sessions) => sessions.map((session) =>
        session.id === sessionId ? { ...session, status: 'running' as const, messageCount: session.messageCount + 1 } : session
      ));
      set(runViewAtom, {
        runId: event.runId,
        sessionId,
        answer: '',
        toolCalls: [],
        infraError: undefined,
      });
      set(lastRunSummaryAtom, {
        runId: event.runId,
        sessionId,
        status: 'running',
        startedAt: event.payload.run.startedAt,
        toolCount: 0,
        // Preserve the live context captured by the AgentPanel at startRun.
        workspaceContext: get(lastRunSummaryAtom)?.workspaceContext,
      });
      return;
    }

    const run = get(runViewAtom);
    if (!run || run.runId !== event.runId || run.sessionId !== sessionId) return;

    if (event.type === 'message_delta') {
      set(runViewAtom, { ...run, answer: event.payload.answer });
      return;
    }

    if (event.type === 'tool_started') {
      set(runViewAtom, {
        ...run,
        toolCalls: [...run.toolCalls.filter((toolCall) => toolCall.id !== event.payload.toolCall.id), event.payload.toolCall],
      });
      return;
    }

    if (event.type === 'tool_completed') {
      set(runViewAtom, {
        ...run,
        toolCalls: run.toolCalls.map((toolCall) =>
          toolCall.id === event.payload.toolCall.id ? event.payload.toolCall : toolCall
        ),
      });
      return;
    }

    if (event.type === 'message_started') {
      return;
    }

    if (event.type === 'message_completed') {
      set(runViewAtom, { ...run, answer: event.payload.answer });
      return;
    }

    // Terminal events: finalize the assistant message and clear the run view.
    if (event.type === 'run_completed') {
      const assistantMessage: Message = {
        id: `assistant-${event.runId}`,
        role: 'assistant',
        content: event.payload.answer,
        timestamp: event.timestamp,
        toolCalls: event.payload.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          toolName: toolCall.toolName,
          args: toolCall.args,
          startedAt: toolCall.startedAt,
          completedAt: toolCall.completedAt,
          status: toolCall.status === 'error' ? 'error' : 'success',
          result: toolCall.result,
          error: toolCall.error,
        })),
      };
      set(messages, [...get(messages), assistantMessage]);
      set(sessionsAtom, (sessions) => sessions.map((session) =>
        session.id === sessionId ? { ...session, status: 'idle' as const, messageCount: session.messageCount + 1 } : session
      ));
      set(lastRunSummaryAtom, (previous) => ({
        runId: event.runId,
        sessionId,
        status: 'completed',
        startedAt: previous?.startedAt ?? event.timestamp,
        completedAt: event.timestamp,
        toolCount: event.payload.toolCalls.length,
        workspaceContext: previous?.workspaceContext,
      }));
      set(runViewAtom, null);
      return;
    }

    if (event.type === 'run_failed') {
      const cancelled = event.payload.error.code === 'RUN_CANCELLED';
      const stop = stopOf(event.payload);
      set(sessionsAtom, (sessions) => sessions.map((session) =>
        session.id === sessionId ? { ...session, status: 'idle' as const } : session
      ));

      // V8.1 §38–39: infrastructure failure (Pi process failed to start/stay
      // up) is not an answer — no assistant message, keep runView so the panel
      // renders a dedicated runtime banner with Retry + Diagnostics. Real
      // failures (tool errors, task failures) keep the existing message flow.
      const error = event.payload.error;
      if (isRuntimeInfraCode(error.code)) {
        set(lastRunSummaryAtom, (previous) => ({
          runId: event.runId,
          sessionId,
          status: 'failed',
          startedAt: previous?.startedAt ?? event.timestamp,
          completedAt: event.timestamp,
          toolCount: run.toolCalls.length,
          workspaceContext: previous?.workspaceContext,
        }));
        set(runViewAtom, { ...run, infraError: error, ...stop });
        return;
      }

      const guardStop = describeGuardStop(error, stop);
      const assistantMessage: Message = {
        id: `assistant-${event.runId}`,
        role: 'assistant',
        content:
          guardStop !== undefined
            ? [run.answer, guardStop].filter((part) => part !== '').join('\n\n')
            : cancelled
              ? (run.answer || '(run stopped)')
              : `Error: ${error.message}`,
        timestamp: event.timestamp,
        toolCalls: run.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          toolName: toolCall.toolName,
          args: toolCall.args,
          startedAt: toolCall.startedAt,
          completedAt: toolCall.completedAt,
          status: toolCall.status === 'error' ? 'error' : 'success',
          result: toolCall.result,
          error: toolCall.error,
        })),
      };
      set(messages, [...get(messages), assistantMessage]);
      set(sessionsAtom, (sessions) => sessions.map((session) =>
        session.id === sessionId
          ? { ...session, status: 'idle' as const, messageCount: session.messageCount + 1 }
          : session
      ));
      set(lastRunSummaryAtom, (previous) => ({
        runId: event.runId,
        sessionId,
        status: cancelled ? 'cancelled' : 'failed',
        startedAt: previous?.startedAt ?? event.timestamp,
        completedAt: event.timestamp,
        toolCount: run.toolCalls.length,
        workspaceContext: previous?.workspaceContext,
        ...stop,
      }));
      set(runViewAtom, null);
      return;
    }
  }
);

export const cancelRunAtom = atom(
  null,
  async (_get, set, client: FinagentClient) => {
    const run = _get(runViewAtom);
    const sessionId = _get(activeSessionIdAtom);
    if (!run || !sessionId) return;
    await client.kernel.cancelRun(sessionId, run.runId);
  }
);
