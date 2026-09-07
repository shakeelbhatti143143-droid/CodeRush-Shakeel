/**
 * Client library for the interactive execution API.
 *
 * The frontend uses this instead of the single-shot execute endpoint:
 * Run Code -> POST /api/code/interactive/start, then opens the SSE
 * stream for live output and POSTs each submitted line to /input.
 *
 * Client-safe (no Node imports).
 */

import type { LanguageId } from "@/lib/code-execution/types";

/**
 * Execution lifecycle states surfaced in the terminal UI.
 *
 * "waiting_for_input" is detected automatically (generic output-quiet
 * heuristic while the process is alive) — the user never has to
 * configure whether their program reads stdin.
 */
export type RunStatus =
    | "idle"
    | "running"
    | "waiting_for_input"
    | "completed"
    | "error"
    | "timeout";

/**
 * While the SSE stream is open, the client pings the server at this
 * interval to prove a live user is attached to the terminal. The
 * server resets the session's idle-reap timer on every ping, so a
 * program blocked on stdin (waiting for the user to type) is never
 * terminated as "idle". Must stay well below
 * INTERACTIVE_LIMITS.maxIdleMs (3 min) so several missed pings on a
 * flaky connection still cannot get a session killed.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

export type InteractiveExitReason =
    | "exit"
    | "timeout"
    | "idle_timeout"
    | "stopped";

export interface InteractiveSessionInfo {
    sessionId: string;
    backend: string;
    startedAt: number;
}

export type InteractiveStreamEvent =
    | { kind: "stdout"; text: string }
    | { kind: "stderr"; text: string }
    | {
          kind: "exit";
          exitCode: number | null;
          signal: string | null;
          reason: InteractiveExitReason;
      }
    | { kind: "error"; message: string }
    | { kind: "closed" };

export class InteractiveRun {
    /** True until the process emits an exit/error event or the stream ends. */
    running = true;

    constructor(
        public readonly sessionId: string,
        public readonly backend: string,
    ) {}

    /**
     * Open the SSE stream and invoke `onEvent` for every event.
     * Resolves after the stream ends (exit, error, or client close).
     *
     * For as long as the stream is open a heartbeat ping is sent to
     * the server, proving a live user sits at this terminal — without
     * it the server could reap a session that is quietly blocked on
     * stdin waiting for the user to finish typing.
     */
    async stream(onEvent: (event: InteractiveStreamEvent) => void): Promise<void> {
        this.startHeartbeat();
        try {
            await this.streamEvents(onEvent);
        } finally {
            this.stopHeartbeat();
        }
    }

    private async streamEvents(
        onEvent: (event: InteractiveStreamEvent) => void,
    ): Promise<void> {
        try {
            const response = await fetch(
                `/api/code/interactive/stream?sessionId=${encodeURIComponent(this.sessionId)}`,
                { cache: "no-store" },
            );

            if (!response.ok || !response.body) {
                this.running = false;
                onEvent({ kind: "error", message: "Failed to open the output stream." });
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });

                    let boundary: number;
                    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                        const block = buffer.slice(0, boundary);
                        buffer = buffer.slice(boundary + 2);
                        this.handleBlock(block, onEvent);
                    }
                }
            } catch {
                // Reader error -> drop out and treat as closed/error below.
            } finally {
                reader.releaseLock();
            }
        } catch {
            this.running = false;
            onEvent({ kind: "error", message: "Lost connection to the execution service." });
            return;
        }

        }

    private handleBlock(
        block: string,
        onEvent: (event: InteractiveStreamEvent) => void,
    ): void {
        if (!block.trim()) return;

        const lines = block.split("\n");
        let event = "";
        let data = "";
        for (const line of lines) {
            if (line.startsWith("event:")) {
                event = line.slice("event:".length).trim();
            } else if (line.startsWith("data:")) {
                data = `${data}${line.slice("data:".length).trimStart()}\n`;
            }
        }
        data = data.replace(/\n$/, "");
        if (event === ":") return;

        switch (event) {
            case "stdout":
                onEvent({ kind: "stdout", text: data });
                break;
            case "stderr":
                onEvent({ kind: "stderr", text: data });
                break;
            case "exit": {
                // Program finished: stop proving liveness so the server
                // can reap the (already-dead) session naturally.
                this.running = false;
                let parsed: Record<string, unknown> = {};
                try {
                    parsed = JSON.parse(data) as Record<string, unknown>;
                } catch {
                    parsed = {};
                }
                onEvent({
                    kind: "exit",
                    exitCode:
                        typeof parsed.exitCode === "number"
                            ? parsed.exitCode
                            : null,
                    signal:
                        typeof parsed.signal === "string" ? parsed.signal : null,
                    reason: (parsed.reason as InteractiveExitReason) ?? "exit",
                });
                break;
            }
            default:
                break;
        }
    }

    // -------------------------------------------------------------
    // Heartbeat — keeps waiting-for-input sessions alive
    // -------------------------------------------------------------

    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (!this.running) {
                this.stopHeartbeat();
                return;
            }
            void this.heartbeat();
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /** Best-effort presence ping; failures are retried on the next tick. */
    private async heartbeat(): Promise<void> {
        try {
            await fetch(
                `/api/code/interactive/heartbeat?sessionId=${encodeURIComponent(this.sessionId)}`,
                { method: "POST" },
            );
        } catch {
            /* transient network hiccup — next tick retries */
        }
    }

    /** Submit one user-typed line to the running program's stdin. */
    async sendLine(line: string): Promise<boolean> {
        try {
            const response = await fetch(
                `/api/code/interactive/input?sessionId=${encodeURIComponent(this.sessionId)}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ line }),
                },
            );
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Half-close the program's stdin (Ctrl+D). Lets programs that read
     * until EOF finish normally; output keeps streaming until exit.
     */
    async sendEof(): Promise<boolean> {
        try {
            const response = await fetch(
                `/api/code/interactive/eof?sessionId=${encodeURIComponent(this.sessionId)}`,
                { method: "POST" },
            );
            return response.ok;
        } catch {
            return false;
        }
    }

    /** Terminate the running program (Stop button / cleanup). */
    async stop(): Promise<void> {
        this.running = false;
        try {
            await fetch(
                `/api/code/interactive/stop?sessionId=${encodeURIComponent(this.sessionId)}`,
                { method: "POST" },
            );
        } catch {
            /* best-effort */
        }
    }
}

/** Start a new interactive session for the given language + code. */
export async function startInteractiveRun(
    language: LanguageId,
    code: string,
): Promise<InteractiveRun> {
    const response = await fetch("/api/code/interactive/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code }),
    });

    if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const message =
            data && typeof data === "object" && "error" in data
                ? String((data as { error: unknown }).error)
                : `Failed to start the program (HTTP ${response.status}).`;
        throw new Error(message);
    }

    const result = (await response.json()) as {
        sessionId: string;
        backend: string;
    };
    return new InteractiveRun(result.sessionId, result.backend);
}