"use client";

/**
 * Interactive Terminal / console panel.
 *
 * Features:
 * - Displays live stdout/stderr streamed from the SSE connection.
 * - Proper vertical scrolling for long output.
 * - Horizontal scrolling for very long lines.
 * - The entire terminal is clickable and focuses the input.
 * - User can type directly into the terminal.
 * - Enter sends the current line to the running process stdin.
 * - Supports multiple sequential inputs.
 * - Keeps the input focused while the program is running.
 * - Ctrl+D sends EOF.
 * - Stop terminates the current process.
 * - Clear removes terminal output.
 * - Auto-scrolls as new output arrives.
 */

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type FormEvent,
    type KeyboardEvent,
    type MouseEvent,
} from "react";

import type {
    InteractiveRun,
    RunStatus,
} from "@/lib/code-execution/interactive-client";

export interface TerminalProps {
    run: InteractiveRun | null;

    /** Live chunks received from the SSE stream. */
    output: TerminalSegment[];

    /**
     * Execution lifecycle state. Drives the header status pill and the
     * "Program is waiting for input..." hint. Optional — when omitted
     * the terminal falls back to run/no-run indicators.
     */
    status?: RunStatus;

    onClear: () => void;

    /** Called after a line is successfully sent for local terminal echo. */
    onInput?: (line: string) => void;

    /**
     * Called for lines typed while NO program is running. With the
     * single-shot execution flow (HTTP / Piston backend) stdin cannot be
     * streamed to a live process, so the parent collects these lines as
     * stdin for the next Run Code. When provided, the terminal input is
     * enabled even while idle.
     */
    onIdleInput?: (line: string) => void;
}

export interface TerminalSegment {
    kind: "stdout" | "stderr" | "meta";
    text: string;
}

export default function Terminal({
    run,
    output,
    status,
    onClear,
    onInput,
    onIdleInput,
}: TerminalProps) {
    const terminalRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const [value, setValue] = useState("");
    const [inputError, setInputError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    /** Stdin entry is allowed while idle when the parent buffers it. */
    const canTypeWhenIdle = Boolean(onIdleInput);

    // Clear terminal input when a run finishes. Uses the "adjust state
    // during render" pattern (React docs) instead of an effect.
    const [previousRun, setPreviousRun] = useState(run);
    if (run !== previousRun) {
        setPreviousRun(run);
        if (!run) {
            setValue("");
            setInputError(null);
            setSending(false);
        }
    }

    /**
     * Focus terminal input.
     */
    const focusTerminal = useCallback(() => {
        if (!run && !canTypeWhenIdle) return;

        requestAnimationFrame(() => {
            inputRef.current?.focus();
        });
    }, [run, canTypeWhenIdle]);

    /**
     * Submit one line to the running process — or, while no program is
     * running, hand it to the parent as stdin for the next Run Code.
     */
    const handleSubmit = useCallback(
        async (e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();

            if (sending) {
                return;
            }

            if (!run) {
                if (!onIdleInput) return;

                const text = value;

                setValue("");
                setInputError(null);

                onIdleInput(text);

                return;
            }

            const text = value;

            setValue("");
            setInputError(null);
            setSending(true);

            try {
                const ok = await run.sendLine(text);

                if (!ok) {
                    setInputError(
                        "Could not send input. The program may have ended.",
                    );

                    setValue(text);
                    return;
                }

                onInput?.(text);
            } catch {
                setInputError(
                    "Could not send input. The program may have ended.",
                );

                setValue(text);
            } finally {
                setSending(false);

                focusTerminal();
            }
        },
        [run, value, sending, onInput, onIdleInput, focusTerminal],
    );

    /**
     * Stop current program.
     */
    const handleStop = useCallback(async () => {
        if (!run) return;

        setValue("");
        setInputError(null);

        await run.stop();

        inputRef.current?.blur();
    }, [run]);

    /**
     * Send EOF.
     */
    const handleEof = useCallback(async () => {
        if (!run) return;

        setValue("");
        setInputError(null);

        const ok = await run.sendEof();

        if (!ok) {
            setInputError(
                "Could not send EOF. The program may have already ended.",
            );
        }

        focusTerminal();
    }, [run, focusTerminal]);

    /**
     * Keyboard shortcuts.
     *
     * Ctrl+D sends EOF.
     */
    const handleKeyDown = useCallback(
        (e: KeyboardEvent<HTMLInputElement>) => {
            if (!run) return;

            if (e.ctrlKey && e.key.toLowerCase() === "d") {
                e.preventDefault();
                void handleEof();
            }
        },
        [run, handleEof],
    );

    /**
     * Clicking terminal focuses input.
     *
     * Buttons and input are excluded.
     */
    const handleTerminalClick = useCallback(
        (e: MouseEvent<HTMLDivElement>) => {
            if (!run && !canTypeWhenIdle) return;

            const target = e.target as HTMLElement;

            if (
                target.closest("button") ||
                target.closest("input") ||
                target.closest("form")
            ) {
                return;
            }

            focusTerminal();
        },
        [run, canTypeWhenIdle, focusTerminal],
    );

    /**
     * Automatically scroll to the latest output.
     *
     * We use scrollTop instead of scrollTo({ behavior: "smooth" })
     * so that rapid output from a running program does not create
     * delayed scrolling animations.
     */
    useEffect(() => {
        const element = scrollRef.current;

        if (!element) return;

        element.scrollTop = element.scrollHeight;
    }, [output]);

    /**
     * Focus terminal when a new run starts.
     */
    useEffect(() => {
        if (run) focusTerminal();
    }, [run, focusTerminal]);

    /**
     * Keep focus after the Run button finishes creating the process.
     */
    useEffect(() => {
        if (!run) return;

        const timer = window.setTimeout(() => {
            inputRef.current?.focus();
        }, 100);

        return () => {
            window.clearTimeout(timer);
        };
    }, [run]);

    const isRunning = Boolean(run);

    /**
     * Waiting-for-input is surfaced from the parent's generic
     * detection (process alive + output-quiet window). While a run is
     * active the input row is always available — the message below it
     * is only a hint, never a gate.
     */
    const waitingForInput = run && status === "waiting_for_input";

    return (
        <div
            ref={terminalRef}
            onClick={handleTerminalClick}
            className={[
                "flex h-[420px] min-h-0 w-full flex-col overflow-hidden rounded-lg",
                "border border-neutral-800 bg-neutral-950",
                "shadow-inner",
            ].join(" ")}
        >
            {/* ====================================================== */}
            {/* TERMINAL HEADER                                         */}
            {/* ====================================================== */}

            <div
                className={[
                    "flex shrink-0 items-center justify-between",
                    "border-b border-neutral-800",
                    "bg-neutral-950 px-4 py-2",
                ].join(" ")}
            >
                <div className="flex items-center gap-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                        Terminal
                    </h2>

                    {run &&
                        (status === "waiting_for_input" ? (
                            <span className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                                Waiting for input
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                                Running
                            </span>
                        ))}
                </div>

                <div className="flex items-center gap-2">
                    {run && (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                void handleEof();
                            }}
                            title="Ctrl+D — send EOF to the running program"
                            className={[
                                "rounded-md border border-sky-500/30",
                                "bg-sky-500/10 px-3 py-1",
                                "text-xs font-medium text-sky-300",
                                "transition-colors hover:bg-sky-500/20",
                            ].join(" ")}
                        >
                            End Input
                        </button>
                    )}

                    {run && (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                void handleStop();
                            }}
                            className={[
                                "rounded-md border border-red-500/30",
                                "bg-red-500/10 px-3 py-1",
                                "text-xs font-medium text-red-400",
                                "transition-colors hover:bg-red-500/20",
                            ].join(" ")}
                        >
                            Stop
                        </button>
                    )}

                    {output.length > 0 && (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onClear();
                            }}
                            className={[
                                "text-xs text-neutral-500",
                                "transition-colors hover:text-neutral-300",
                            ].join(" ")}
                        >
                            Clear
                        </button>
                    )}
                </div>
            </div>

            {/* ====================================================== */}
            {/* TERMINAL OUTPUT                                         */}
            {/* ====================================================== */}

            <div
                ref={scrollRef}
                onClick={handleTerminalClick}
                className={[
                    /*
                     * IMPORTANT:
                     * min-h-0 allows the flex child to shrink.
                     * overflow-y-auto creates the vertical scrollbar.
                     * overflow-x-auto creates horizontal scrolling.
                     */
                    "min-h-0 flex-1",
                    "overflow-x-auto overflow-y-auto",
                    "overscroll-contain",
                    "px-4 py-3",
                    "font-mono text-sm leading-6",
                    run ? "cursor-text" : "cursor-default",
                ].join(" ")}
                style={{
                    scrollbarGutter: "stable",
                }}
            >
                <div
                    className={[
                        "min-w-full",
                        "whitespace-pre",
                        "break-normal",
                    ].join(" ")}
                >
                    {output.length === 0 ? (
                        <p className="whitespace-pre-wrap text-neutral-600">
                            {run
                                ? "Program started. Click here and type your input."
                                : canTypeWhenIdle
                                    ? "Type your program input below (Enter after each line), then press Run Code."
                                    : "Run your code to see live output here."}
                        </p>
                    ) : (
                        output.map((seg, i) => {
                            if (seg.kind === "stderr") {
                                return (
                                    <span
                                        key={`stderr-${i}`}
                                        className="text-red-400"
                                    >
                                        {seg.text}
                                    </span>
                                );
                            }

                            if (seg.kind === "meta") {
                                return (
                                    <span
                                        key={`meta-${i}`}
                                        className="text-neutral-500"
                                    >
                                        {seg.text}
                                    </span>
                                );
                            }

                            return (
                                <span
                                    key={`stdout-${i}`}
                                    className="text-neutral-100"
                                >
                                    {seg.text}
                                </span>
                            );
                        })
                    )}
                </div>
            </div>

            {/* ====================================================== */}
            {/* INTERACTIVE INPUT                                       */}
            {/* ====================================================== */}

            <form
                onSubmit={(e) => void handleSubmit(e)}
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 border-t border-neutral-800 bg-neutral-950"
            >
                {waitingForInput && (
                    <div className="flex items-center gap-2 border-b border-amber-500/10 bg-amber-500/[0.04] px-4 py-1.5">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                        <p className="text-xs font-medium text-amber-300">
                            Program is waiting for input...
                        </p>
                    </div>
                )}

                <div className="flex items-center gap-2 px-4 py-2">
                    <span className="select-none font-mono text-emerald-400">
                        ›
                    </span>

                    <input
                        ref={inputRef}
                        value={value}
                        onChange={(e) => {
                            setValue(e.target.value);
                            setInputError(null);
                        }}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => {
                            e.stopPropagation();
                        }}
                        disabled={(!isRunning && !canTypeWhenIdle) || sending}
                        placeholder={
                            isRunning
                                ? sending
                                    ? "Sending input..."
                                    : waitingForInput
                                        ? "Enter the input the program is asking for..."
                                        : "Type input here and press Enter..."
                                : canTypeWhenIdle
                                    ? "Type program input for the next Run Code (Enter to add)..."
                                    : "Run Code to start the program."
                        }
                        spellCheck={false}
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        className={[
                            "min-w-0 flex-1 bg-transparent px-0 py-1",
                            "font-mono text-sm text-neutral-100",
                            "outline-none",
                            "placeholder:text-neutral-600",
                            "disabled:cursor-not-allowed",
                            "disabled:text-neutral-500",
                        ].join(" ")}
                    />

                    {(isRunning || canTypeWhenIdle) && !sending && (
                        <button
                            type="submit"
                            onClick={(e) => e.stopPropagation()}
                            title="Send this line to the running program's stdin"
                            className={[
                                "shrink-0 rounded-md border border-emerald-500/30",
                                "bg-emerald-500/10 px-3 py-1",
                                "text-xs font-medium text-emerald-300",
                                "transition-colors hover:bg-emerald-500/20",
                                "disabled:cursor-not-allowed disabled:opacity-40",
                            ].join(" ")}
                        >
                            Send Input
                        </button>
                    )}

                    {(isRunning || canTypeWhenIdle) && !sending && (
                        <span className="select-none text-[10px] text-neutral-600">
                            Enter ↵
                        </span>
                    )}
                </div>

                {inputError && (
                    <div className="border-t border-red-500/10 px-4 py-1.5">
                        <p className="text-xs text-red-400">
                            {inputError}
                        </p>
                    </div>
                )}
            </form>
        </div>
    );
}