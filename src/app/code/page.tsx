
"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import {
    Bookmark,
    Check,
    ChevronRight,
    Code2,
    Command,
    FileCode2,
    Fullscreen,
    Keyboard,
    LayoutDashboard,
    Maximize2,
    Minimize2,
    Play,
    RotateCcw,
    Save,
    Settings2,
    Square,
    TerminalSquare,
    TriangleAlert,
    X,
    Zap,
} from "lucide-react";

import { api } from "../../../convex/_generated/api";

import MonacoHost from "@/components/code-editor/problem/MonacoHost";
import ErrorDetailsCard from "@/components/code-editor/problem/ErrorDetailsCard";
import EditorToolbar from "@/components/code-editor/problem/EditorToolbar";
import Terminal, {
    type TerminalSegment,
} from "@/components/code-editor/Terminal";
import BookmarkButton from "@/components/bookmarks/BookmarkButton";
import { ToastStack, type ToastItem, useToasts } from "@/components/ui/Toast";

import { getLanguage } from "@/lib/code-execution/languages";
import type { InteractiveRun } from "@/lib/code-execution/interactive-client";

import type { LanguageId } from "@/lib/code-execution/types";
import {
    parseError,
    makeInternalError,
} from "@/lib/error-parsing";
import type { ParsedError } from "@/lib/error-parsing/types";
import { useEditorSettings } from "@/lib/editor/settings";
import { formatCode } from "@/lib/editor/formatting";
import {
    saveDraft,
    clearDraft,
    timeAgo,
} from "@/lib/editor/drafts";
import {
    applyErrorMarker,
    stageQuickFix,
} from "@/lib/editor/monaco-setup";
import { ConfirmDialog } from "@/components/code-editor/problem/Dialogs";

function storageKey(language: LanguageId): string {
    return `coderush-code-${language}`;
}

function languageName(language: LanguageId): string {
    try {
        return getLanguage(language).label;
    } catch {
        return language;
    }
}

/**
 * Response shape of POST /api/code/execute (see
 * src/app/api/code/execute/route.ts). Also carries `{ error }` on
 * non-2xx responses.
 */
interface ExecuteResponse {
    success: boolean;
    status:
        | "success"
        | "compilation_error"
        | "runtime_error"
        | "timeout"
        | "internal_error";
    stdout: string;
    stderr: string;
    compile_output: string;
    message: string | null;
    output: string;
    error?: string | null;
    executionTime: number;
    memoryUsageKb: number | null;
}

export default function CodePage() {
    const { push, toasts: customToasts } = useToasts();

    const {
        settings,
        update: updateSettings,
        reset: resetSettings,
    } = useEditorSettings();

    const [language, setLanguage] =
        useState<LanguageId>("javascript");

    const [codeByLang, setCodeByLang] =
        useState<Record<string, string>>({});

    const [hydrated, setHydrated] = useState(false);

    const [run, setRun] =
        useState<InteractiveRun | null>(null);

    const [output, setOutput] =
        useState<TerminalSegment[]>([]);

    const [parsedError, setParsedError] =
        useState<ParsedError | null>(null);

    const [activeTab, setActiveTab] =
        useState<"terminal" | "error">("terminal");

    const [draftState, setDraftState] =
        useState<"idle" | "dirty" | "saving" | "saved">("idle");

    const [savedAtLabel, setSavedAtLabel] =
        useState<string | null>(null);

    const [draftSavedAt, setDraftSavedAt] =
        useState<number | null>(null);

    const [resetOpen, setResetOpen] =
        useState(false);

    const [fullscreen, setFullscreen] =
        useState(false);

    const [sidebarOpen, setSidebarOpen] =
        useState(true);

    const [legacyToasts, setLegacyToasts] =
        useState<ToastItem[]>([]);

    const toastSeq = useRef(0);

    const convex = useConvex();

    const runRef =
        useRef<InteractiveRun | null>(null);

    const runFnRef =
        useRef<() => void>(() => { });

    /**
     * Stdin collected from the terminal input before running. With the
     * single-shot execution flow (HTTP / Piston backend) a program's
     * stdin cannot be streamed live, so every line typed into the
     * terminal before pressing Run Code is buffered here and submitted
     * with the execution request. The interactive (local Docker)
     * backend still streams lines live and does not consume this.
     */
    const stdinBufferRef = useRef("");

    /** True while a single-shot /api/code/execute request is in flight. */
    const [executing, setExecuting] = useState(false);
    const executingRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);

    const logSequenceRef =
        useRef(0);

    const editorRef =
        useRef<
            import("monaco-editor").editor.IStandaloneCodeEditor | null
        >(null);

    const monacoRef =
        useRef<typeof import("monaco-editor") | null>(null);

    const bindInstances = useCallback(
        (
            editor:
                | import("monaco-editor").editor.IStandaloneCodeEditor
                | null,
            monaco:
                | typeof import("monaco-editor")
                | null,
        ) => {
            editorRef.current = editor;
            monacoRef.current = monaco;
        },
        [],
    );

    /* ------------------------------------------------------------
       Legacy Toast Listener
    ------------------------------------------------------------ */

    useEffect(() => {
        function onToast(event: Event) {
            const detail =
                (event as CustomEvent).detail as
                | {
                    message: string;
                    kind: ToastItem["kind"];
                }
                | undefined;

            if (!detail) return;

            const id = ++toastSeq.current;

            setLegacyToasts((prev) => [
                ...prev,
                {
                    id,
                    ...detail,
                },
            ]);

            window.setTimeout(() => {
                setLegacyToasts((prev) =>
                    prev.filter((toast) => toast.id !== id),
                );
            }, 3000);
        }

        window.addEventListener(
            "coderush:toast",
            onToast,
        );

        return () =>
            window.removeEventListener(
                "coderush:toast",
                onToast,
            );
    }, []);

    /* ------------------------------------------------------------
       Open Bookmark
    ------------------------------------------------------------ */

    useEffect(() => {
        const params = new URLSearchParams(
            window.location.search,
        );

        const snippetId = params.get("snippet");

        if (!snippetId) return;

        let cancelled = false;

        convex
            .query(api.bookmarks.getBookmark, {
                id: snippetId as never,
            })
            .then((bookmark) => {
                if (cancelled || !bookmark) return;

                setLanguage(
                    bookmark.language as LanguageId,
                );

                setCodeByLang((prev) => ({
                    ...prev,
                    [bookmark.language]:
                        bookmark.code,
                }));

                setHydrated(true);
            })
            .catch(() => { });

        return () => {
            cancelled = true;
        };
    }, [convex]);

    /* ------------------------------------------------------------
       Restore Local Drafts
    ------------------------------------------------------------ */

    useEffect(() => {
        try {
            const drafts: Record<string, string> = {};

            for (const key of Object.keys(
                localStorage,
            )) {
                if (
                    key.startsWith(
                        "coderush-code-",
                    )
                ) {
                    const lang = key.replace(
                        "coderush-code-",
                        "",
                    );

                    drafts[lang] =
                        localStorage.getItem(key) ?? "";
                }
            }

            setCodeByLang(drafts);
        } finally {
            setHydrated(true);
        }
    }, []);

    const code = hydrated
        ? codeByLang[language] ??
        getLanguage(language).starterCode
        : "";

    const setCode = useCallback(
        (value: string) => {
            setCodeByLang((prev) => ({
                ...prev,
                [language]: value,
            }));

            setDraftState("dirty");
        },
        [language],
    );

    /* ------------------------------------------------------------
       Autosave
    ------------------------------------------------------------ */

    useEffect(() => {
        if (!hydrated) return;

        localStorage.setItem(
            storageKey(language),
            codeByLang[language] ?? "",
        );

        const timer = window.setTimeout(() => {
            setDraftState("saving");

            const savedAt = saveDraft({
                code: codeByLang[language] ?? "",
                language,
                problemSlug: "workspace",
            });

            if (savedAt !== null) {
                setDraftSavedAt(savedAt);
                setDraftState("saved");
                setSavedAtLabel(timeAgo(savedAt));
            } else {
                setDraftState("dirty");
            }
        }, 1200);

        return () =>
            window.clearTimeout(timer);
    }, [
        codeByLang,
        language,
        hydrated,
    ]);

    useEffect(() => {
        if (
            draftState !== "saved" ||
            draftSavedAt === null
        ) {
            return;
        }

        const timer = window.setInterval(
            () =>
                setSavedAtLabel(
                    timeAgo(draftSavedAt),
                ),
            30000,
        );

        return () =>
            window.clearInterval(timer);
    }, [draftState, draftSavedAt]);

    useEffect(() => {
        runRef.current = run;
    }, [run]);

    const appendOutput = useCallback(
        (segments: TerminalSegment[]) => {
            setOutput((prev) => [
                ...prev,
                ...segments,
            ]);
        },
        [],
    );

    const running = run !== null || executing;

    /* ------------------------------------------------------------
       Save Execution Logs
    ------------------------------------------------------------ */

    const saveExecutionLog = useCallback(
        async (
            executionId: string,
            type:
                | "stdout"
                | "stderr"
                | "stdin"
                | "system",
            data: string,
        ) => {
            try {
                const execution =
                    await convex.query(
                        api.executions.getExecution,
                        {
                            executionId,
                        },
                    );

                if (!execution) return;

                await convex.mutation(
                    api.executionLogs.addLog,
                    {
                        executionId:
                            execution._id,
                        type,
                        data,
                        sequence:
                            logSequenceRef.current++,
                        timestamp: Date.now(),
                    },
                );
            } catch (error) {
                console.error(
                    "[CodeRush] Failed to save execution log:",
                    error,
                );
            }
        },
        [convex],
    );

    /**
     * NOTE: leaderboard/XP recording for the normal Run Code flow happens
     * SERVER-SIDE inside POST /api/code/execute (it calls
     * api.leaderboard.recordCodeExecution with the client-supplied
     * executionId), so no client-side recordSubmission is needed here.
     */

    /* ------------------------------------------------------------
       Stop
    ------------------------------------------------------------ */

    const stopAndClear = useCallback(() => {
        const current = runRef.current;

        runRef.current = null;

        setRun(null);

        if (current) {
            void current.stop();
        }

        // Single-shot execution in flight — abort the HTTP request.
        // The in-flight handleRun() detects the abort, records the run
        // as "stopped" and resets the executing state.
        if (executingRef.current) {
            abortRef.current?.abort();
        }
    }, []);

    /* ------------------------------------------------------------
       Language Change
    ------------------------------------------------------------ */

    const handleLanguageChange =
        useCallback(
            (next: LanguageId) => {
                setLanguage(next);

                stopAndClear();

                setOutput([]);

                setParsedError(null);

                setActiveTab("terminal");
            },
            [stopAndClear],
        );

    /* ------------------------------------------------------------
       Reset
    ------------------------------------------------------------ */

    const handleReset = useCallback(() => {
        stopAndClear();

        setCode(
            getLanguage(language).starterCode,
        );

        clearDraft("workspace", language);

        setOutput([]);

        setParsedError(null);

        setActiveTab("terminal");

        push(
            "Code reset to template",
            "info",
        );
    }, [
        language,
        setCode,
        stopAndClear,
        push,
    ]);

    /* ------------------------------------------------------------
       Format
    ------------------------------------------------------------ */

    const handleFormat = useCallback(() => {
        const formatted = formatCode(
            code,
            language as never,
            settings.tabSize,
        );

        setCode(formatted);

        push(
            "Code formatted",
            "info",
        );
    }, [
        code,
        language,
        settings.tabSize,
        setCode,
        push,
    ]);

    /* ------------------------------------------------------------
       Comment
    ------------------------------------------------------------ */

    const toggleComment = useCallback(() => {
        editorRef.current
            ?.getAction(
                "editor.action.commentLine",
            )
            ?.run();
    }, []);

    /* ------------------------------------------------------------
       Go To Error
    ------------------------------------------------------------ */

    const goToErrorLine = useCallback(
        (line: number) => {
            const editor =
                editorRef.current;

            if (!editor) return;

            editor.revealLineInCenter(line);

            editor.setPosition({
                lineNumber: line,
                column: 1,
            });

            editor.focus();
        },
        [],
    );

    /* ------------------------------------------------------------
       Quick Fix
    ------------------------------------------------------------ */

    const applyQuickFix = useCallback(() => {
        const qf = parsedError?.quickFix;

        const editor =
            editorRef.current;

        const monaco =
            monacoRef.current;

        if (
            !qf ||
            !editor ||
            !monaco
        ) {
            return;
        }

        const model =
            editor.getModel();

        if (!model) return;

        const col =
            qf.kind === "insert-text" &&
                qf.column >= 1e9
                ? model.getLineMaxColumn(
                    qf.line,
                )
                : qf.column;

        editor.executeEdits(
            "coderush-quickfix",
            [
                {
                    range: new monaco.Range(
                        qf.line,
                        col,
                        qf.line,
                        qf.kind ===
                            "replace-line"
                            ? model.getLineMaxColumn(
                                qf.line,
                            )
                            : col,
                    ),
                    text:
                        qf.kind ===
                            "replace-line"
                            ? `${qf.text}\n`
                            : qf.text,
                },
            ],
        );

        applyErrorMarker(
            monaco,
            model,
            null,
        );

        stageQuickFix(
            model,
            {
                ...parsedError!,
                quickFix: undefined,
            },
            language,
        );

        push(
            "Quick fix applied",
            "success",
        );
    }, [
        parsedError,
        language,
        push,
    ]);

    /* ------------------------------------------------------------
       Run Code
    ------------------------------------------------------------ */

    const handleRun = useCallback(
        async () => {
            if (
                runRef.current ||
                executingRef.current ||
                code.trim().length === 0
            ) {
                return;
            }

            setOutput([]);

            setParsedError(null);

            setActiveTab("terminal");

            runRef.current = null;

            setRun(null);

            const sessionCode = code;

            const sessionLanguage =
                language;

            const startedAtMs =
                Date.now();

            /**
             * Client-side correlation id. /api/code/execute uses it to
             * attach the Convex execution record, execution logs and XP
             * award to this run (mirrors the old interactive sessionId).
             */
            const executionId =
                typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `exec-${startedAtMs}-${Math.random()
                        .toString(36)
                        .slice(2)}`;

            /**
             * Stdin typed into the terminal before running. Lines typed
             * DURING the run are buffered for the next run — a single-shot
             * request cannot receive stdin after it has been submitted.
             */
            const stdinSnapshot =
                stdinBufferRef.current;

            let stdoutCollector = "";

            let stderrCollector = "";

            executingRef.current = true;

            setExecuting(true);

            const controller =
                new AbortController();

            abortRef.current = controller;

            try {
                await convex.mutation(
                    api.executions.createExecution,
                    {
                        executionId,
                        language:
                            sessionLanguage,
                    },
                );

                /**
                 * Normal Run Code flow: single-shot execution through
                 * /api/code/execute -> executeCode() -> HttpBackend ->
                 * self-hosted Piston (EXECUTION_SERVICE_URL, i.e.
                 * .../api/v2/execute). The interactive session APIs remain
                 * available for local Docker runs but are intentionally
                 * NOT used on this path.
                 */
                const response =
                    await fetch(
                        "/api/code/execute",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json",
                            },
                            body:
                                JSON.stringify(
                                    {
                                        language:
                                            sessionLanguage,
                                        code: sessionCode,
                                        stdin:
                                            stdinSnapshot,
                                        executionId,
                                    },
                                ),
                            signal:
                                controller.signal,
                        },
                    );

                const data =
                    (await response
                        .json()
                        .catch(
                            () => null,
                        )) as
                        | ExecuteResponse
                        | null;

                if (
                    !response.ok ||
                    !data
                ) {
                    const message =
                        data &&
                        typeof data.error ===
                            "string"
                            ? data.error
                            : `Execution failed (HTTP ${response.status}).`;

                    throw new Error(
                        message,
                    );
                }

                const stdoutText =
                    data.stdout ??
                    data.output ??
                    "";

                const stderrText =
                    data.stderr ?? "";

                const compileText =
                    data.compile_output ??
                    "";

                const executionTimeMs =
                    typeof data.executionTime ===
                    "number"
                        ? data.executionTime
                        : Math.max(
                            0,
                            Date.now() -
                                startedAtMs,
                        );

                if (stdoutText) {
                    stdoutCollector +=
                        stdoutText;

                    appendOutput([
                        {
                            kind: "stdout",
                            text: stdoutText,
                        },
                    ]);
                }

                if (stderrText) {
                    stderrCollector +=
                        stderrText;

                    appendOutput([
                        {
                            kind: "stderr",
                            text: stderrText,
                        },
                    ]);
                }

                if (compileText) {
                    stderrCollector +=
                        compileText;

                    appendOutput([
                        {
                            kind: "stderr",
                            text: compileText,
                        },
                    ]);
                }

                const status =
                    data.status;

                const success =
                    status === "success";

                const metaLabel =
                    status === "success"
                        ? "Program finished."
                        : status ===
                            "compilation_error"
                            ? "Compilation failed."
                            : status === "timeout"
                                ? "Program reached the time limit and was terminated."
                                : "Program finished with an error.";

                appendOutput([
                    {
                        kind: "meta",
                        text: `\n[${metaLabel}]\n`,
                    },
                ]);

                void convex
                    .mutation(
                        api.executions.updateExecution,
                        {
                            executionId,
                            status,
                            completedAt:
                                Date.now(),
                            exitCode: success
                                ? 0
                                : 1,
                            executionTime:
                                executionTimeMs,
                            errorMessage:
                                success
                                    ? undefined
                                    : data.message ??
                                        data.error ??
                                        undefined,
                        },
                    )
                    .catch(() => { });

                if (success) {
                    setParsedError(null);

                    push(
                        "✓ Program completed successfully",
                        "success",
                    );
                } else {
                    const parsed =
                        parseError({
                            language:
                                sessionLanguage,
                            stderr:
                                stderrCollector ||
                                null,
                            stdout:
                                stdoutCollector,
                            exitCode: 1,
                        }) ||
                        makeInternalError(
                            data.message ??
                                data.error ??
                                metaLabel,
                        );

                    setParsedError(parsed);

                    setActiveTab("error");

                    push(
                        `Error detected: ${parsed.title}`,
                        "error",
                    );
                }
            } catch (err) {
                runRef.current = null;

                setRun(null);

                // User pressed Stop while the request was in flight.
                if (
                    controller.signal.aborted
                ) {
                    appendOutput([
                        {
                            kind: "meta",
                            text: "\n[Program stopped.]\n",
                        },
                    ]);

                    void convex
                        .mutation(
                            api.executions.updateExecution,
                            {
                                executionId,
                                status: "stopped",
                                completedAt:
                                    Date.now(),
                                executionTime:
                                    Math.max(
                                        0,
                                        Date.now() -
                                            startedAtMs,
                                    ),
                            },
                        )
                        .catch(() => { });

                    return;
                }

                const msg =
                    err instanceof Error
                        ? err.message
                        : String(err);

                appendOutput([
                    {
                        kind: "stderr",
                        text: `\n[Failed to execute: ${msg}]\n`,
                    },
                ]);

                void convex
                    .mutation(
                        api.executions.updateExecution,
                        {
                            executionId,
                            status: "internal_error",
                            completedAt:
                                Date.now(),
                            errorMessage: msg,
                            executionTime:
                                Math.max(
                                    0,
                                    Date.now() -
                                        startedAtMs,
                                ),
                        },
                    )
                    .catch(() => { });

                const parsed =
                    makeInternalError(msg);

                setParsedError(parsed);

                setActiveTab("error");

                push(
                    "Could not execute code.",
                    "error",
                );
            } finally {
                executingRef.current = false;

                setExecuting(false);

                abortRef.current = null;
            }
        },
        [
            code,
            language,
            convex,
            appendOutput,
            push,
        ],
    );

    useEffect(() => {
        runFnRef.current =
            handleRun;
    }, [handleRun]);

    /* ------------------------------------------------------------
       Keyboard Shortcuts
    ------------------------------------------------------------ */

    useEffect(() => {
        function onKey(
            e: KeyboardEvent,
        ) {
            const mod =
                e.ctrlKey ||
                e.metaKey;

            if (e.key === "F11") {
                e.preventDefault();

                setFullscreen(
                    (value) => !value,
                );

                return;
            }

            if (
                e.key === "Escape" &&
                fullscreen
            ) {
                setFullscreen(false);

                return;
            }

            if (!mod) return;

            if (e.key === "Enter") {
                e.preventDefault();

                void handleRun();

                return;
            }

            if (
                e.shiftKey &&
                e.altKey &&
                e.key.toLowerCase() ===
                "f"
            ) {
                e.preventDefault();

                handleFormat();

                return;
            }

            if (
                e.key.toLowerCase() ===
                "s"
            ) {
                e.preventDefault();

                const savedAt =
                    saveDraft({
                        code,
                        language,
                        problemSlug:
                            "workspace",
                    });

                if (
                    savedAt !== null
                ) {
                    setDraftSavedAt(
                        savedAt,
                    );

                    setDraftState(
                        "saved",
                    );

                    setSavedAtLabel(
                        timeAgo(
                            savedAt,
                        ),
                    );

                    push(
                        "✓ Draft saved",
                        "success",
                    );
                }
            }
        }

        window.addEventListener(
            "keydown",
            onKey,
        );

        return () =>
            window.removeEventListener(
                "keydown",
                onKey,
            );
    }, [
        handleRun,
        handleFormat,
        fullscreen,
        code,
        language,
        push,
    ]);

    /* ------------------------------------------------------------
       Terminal Input
    ------------------------------------------------------------ */

    const handleInputSent =
        useCallback(
            (line: string) => {
                const current =
                    runRef.current;

                if (current) {
                    // Live interactive session (local Docker backend):
                    // stream the line straight into the program's stdin.
                    appendOutput([
                        {
                            kind: "stdout",
                            text:
                                line + "\n",
                        },
                    ]);

                    void saveExecutionLog(
                        current.sessionId,
                        "stdin",
                        line,
                    );
                } else {
                    // Single-shot execution (HTTP / Piston backend):
                    // buffer the line as stdin for the next Run Code.
                    stdinBufferRef.current +=
                        line + "\n";

                    appendOutput([
                        {
                            kind: "meta",
                            text:
                                line + "\n",
                        },
                    ]);
                }
            },
            [
                appendOutput,
                saveExecutionLog,
            ],
        );

    /* ------------------------------------------------------------
       Save Draft
    ------------------------------------------------------------ */

    const saveCurrentDraft =
        useCallback(() => {
            const savedAt =
                saveDraft({
                    code,
                    language,
                    problemSlug:
                        "workspace",
                });

            if (
                savedAt !== null
            ) {
                setDraftSavedAt(
                    savedAt,
                );

                setDraftState(
                    "saved",
                );

                setSavedAtLabel(
                    timeAgo(
                        savedAt,
                    ),
                );

                push(
                    "✓ Draft saved",
                    "success",
                );
            }
        }, [
            code,
            language,
            push,
        ]);

    return (
        <div
            data-theme={
                settings.theme
            }
            className={
                fullscreen
                    ? "fixed inset-0 z-[70] flex flex-col overflow-hidden bg-black text-white"
                    : "flex h-screen flex-col overflow-hidden bg-black text-white"
            }
        >
            {/* =====================================================
                PREMIUM TOP BAR
            ===================================================== */}

            {!fullscreen && (
                <header className="relative z-30 flex h-[58px] shrink-0 items-center border-b border-white/[0.07] bg-[#050505]/95 px-3 backdrop-blur-xl sm:px-5">
                    <div className="flex min-w-0 items-center gap-3">
                        <Link
                            href="/dashboard"
                            className="group flex items-center gap-2"
                        >
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] transition group-hover:border-white/20 group-hover:bg-white/[0.1]">
                                <Code2
                                    size={17}
                                    className="text-white"
                                />
                            </div>

                            <div className="hidden sm:block">
                                <div className="text-[14px] font-bold tracking-tight">
                                    CodeRush
                                </div>

                                <div className="text-[9px] uppercase tracking-[0.18em] text-white/30">
                                    Code Workspace
                                </div>
                            </div>
                        </Link>

                        <div className="mx-1 hidden h-5 w-px bg-white/10 sm:block" />

                        <div className="hidden items-center gap-1.5 text-[11px] text-white/35 sm:flex">
                            <span>
                                Workspace
                            </span>
                            <ChevronRight
                                size={12}
                            />
                            <span className="text-white/70">
                                {languageName(
                                    language,
                                )}
                            </span>
                        </div>
                    </div>

                    <div className="ml-auto flex items-center gap-1.5">
                        <div className="mr-2 hidden items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-[10px] text-white/35 md:flex">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            Sandbox Ready
                        </div>

                        <Link
                            href="/leaderboard"
                            className="hidden h-8 items-center gap-2 rounded-lg border border-white/[0.07] px-3 text-[11px] font-medium text-white/55 transition hover:border-white/15 hover:bg-white/[0.05] hover:text-white sm:flex"
                        >
                            <Zap
                                size={13}
                            />
                            Leaderboard
                        </Link>

                        <Link
                            href="/problems"
                            className="hidden h-8 items-center gap-2 rounded-lg border border-white/[0.07] px-3 text-[11px] font-medium text-white/55 transition hover:border-white/15 hover:bg-white/[0.05] hover:text-white md:flex"
                        >
                            <FileCode2
                                size={13}
                            />
                            Problems
                        </Link>

                        <Link
                            href="/dashboard"
                            className="flex h-8 items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.04] px-3 text-[11px] font-medium text-white/65 transition hover:border-white/15 hover:bg-white/[0.08] hover:text-white"
                        >
                            <LayoutDashboard
                                size={13}
                            />
                            <span className="hidden sm:inline">
                                Dashboard
                            </span>
                        </Link>
                    </div>
                </header>
            )}

            {/* =====================================================
                MAIN WORKSPACE
            ===================================================== */}

            <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#050505]">
                {/* Subtle grid */}
                <div
                    className="pointer-events-none absolute inset-0 opacity-[0.025]"
                    style={{
                        backgroundImage:
                            "linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)",
                        backgroundSize:
                            "32px 32px",
                    }}
                />

                <div className="relative flex min-h-0 flex-1 flex-col p-2 sm:p-3">
                    {/* =================================================
                        EDITOR + SIDEBAR
                    ================================================= */}

                    <div className="flex min-h-0 flex-1 gap-2.5">
                        {/* EDITOR PANEL */}

                        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#0a0a0a] shadow-[0_20px_80px_rgba(0,0,0,.45)]">
                            {/* Editor top strip */}

                            <div className="flex h-11 shrink-0 items-center border-b border-white/[0.07] bg-[#0d0d0d]">
                                <div className="flex h-full items-center">
                                    <div className="flex h-full items-center gap-2 border-r border-white/[0.06] bg-white/[0.025] px-4">
                                        <FileCode2
                                            size={14}
                                            className="text-white/45"
                                        />

                                        <span className="max-w-[150px] truncate text-[11px] font-medium text-white/75">
                                            main.
                                            {language ===
                                                "cpp"
                                                ? "cpp"
                                                : language ===
                                                    "python"
                                                    ? "py"
                                                    : language ===
                                                        "java"
                                                        ? "java"
                                                        : "js"}
                                        </span>

                                        {draftState ===
                                            "dirty" && (
                                                <span
                                                    className="h-1.5 w-1.5 rounded-full bg-white/60"
                                                    title="Unsaved changes"
                                                />
                                            )}

                                        {draftState ===
                                            "saved" && (
                                                <Check
                                                    size={
                                                        12
                                                    }
                                                    className="text-emerald-400"
                                                />
                                            )}
                                    </div>
                                </div>

                                <div className="ml-auto flex items-center gap-1 px-2">
                                    {savedAtLabel && (
                                        <span className="mr-2 hidden text-[10px] text-white/25 sm:block">
                                            Saved{" "}
                                            {
                                                savedAtLabel
                                            }
                                        </span>
                                    )}

                                    <button
                                        type="button"
                                        onClick={
                                            saveCurrentDraft
                                        }
                                        disabled={
                                            running
                                        }
                                        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] text-white/40 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-30"
                                        title="Save Draft (Ctrl+S)"
                                    >
                                        <Save
                                            size={
                                                12
                                            }
                                        />
                                        <span className="hidden sm:inline">
                                            Save
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSidebarOpen(
                                                (v) =>
                                                    !v,
                                            )
                                        }
                                        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] text-white/40 transition hover:bg-white/[0.06] hover:text-white"
                                    >
                                        <Settings2
                                            size={
                                                12
                                            }
                                        />
                                        <span className="hidden sm:inline">
                                            Panel
                                        </span>
                                    </button>
                                </div>
                            </div>

                            {/* Existing Toolbar */}

                            <div className="shrink-0 border-b border-white/[0.06] bg-[#0b0b0b]">
                                <EditorToolbar
                                    language={
                                        language
                                    }
                                    onLanguageChange={
                                        handleLanguageChange
                                    }
                                    running={
                                        running
                                    }
                                    draftState={
                                        draftState
                                    }
                                    savedAtLabel={
                                        savedAtLabel
                                    }
                                    onSaveDraft={
                                        saveCurrentDraft
                                    }
                                    onFormat={
                                        handleFormat
                                    }
                                    fullscreen={
                                        fullscreen
                                    }
                                    onToggleFullscreen={() =>
                                        setFullscreen(
                                            (v) =>
                                                !v,
                                        )
                                    }
                                    settings={
                                        settings
                                    }
                                    updateSettings={
                                        updateSettings
                                    }
                                    resetSettings={
                                        resetSettings
                                    }
                                />
                            </div>

                            {/* Monaco */}

                            <div className="relative min-h-0 flex-1 bg-[#080808]">
                                <MonacoHost
                                    language={
                                        language
                                    }
                                    value={
                                        code
                                    }
                                    onChange={
                                        setCode
                                    }
                                    settings={
                                        settings
                                    }
                                    error={
                                        parsedError
                                    }
                                    onFormat={
                                        handleFormat
                                    }
                                    onToggleComment={
                                        toggleComment
                                    }
                                    bindInstances={
                                        bindInstances
                                    }
                                />
                            </div>

                            {/* Bottom Editor Actions */}

                            <div className="flex min-h-[52px] shrink-0 items-center justify-between border-t border-white/[0.07] bg-[#0b0b0b] px-3 sm:px-4">
                                <div className="flex items-center gap-2">
                                    {running ? (
                                        <button
                                            type="button"
                                            onClick={
                                                stopAndClear
                                            }
                                            className="group flex h-8 items-center gap-2 rounded-lg bg-white px-3.5 text-[11px] font-bold text-black transition hover:bg-white/90"
                                        >
                                            <span className="flex h-4 w-4 items-center justify-center rounded bg-black/10">
                                                <Square
                                                    size={
                                                        8
                                                    }
                                                    fill="currentColor"
                                                />
                                            </span>

                                            Stop
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void handleRun()
                                            }
                                            disabled={
                                                !hydrated ||
                                                code.trim()
                                                    .length ===
                                                0
                                            }
                                            title="Run Code (Ctrl+Enter)"
                                            className="group flex h-8 items-center gap-2 rounded-lg bg-white px-3.5 text-[11px] font-bold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/25"
                                        >
                                            <Play
                                                size={
                                                    11
                                                }
                                                fill="currentColor"
                                            />
                                            Run Code
                                        </button>
                                    )}

                                    <button
                                        type="button"
                                        onClick={() =>
                                            setResetOpen(
                                                true,
                                            )
                                        }
                                        disabled={
                                            running
                                        }
                                        className="flex h-8 items-center gap-2 rounded-lg border border-white/[0.08] px-3 text-[10px] font-medium text-white/45 transition hover:border-white/15 hover:bg-white/[0.04] hover:text-white disabled:opacity-25"
                                    >
                                        <RotateCcw
                                            size={
                                                12
                                            }
                                        />
                                        <span className="hidden sm:inline">
                                            Reset
                                        </span>
                                    </button>
                                </div>

                                <div className="flex items-center gap-3">
                                    {parsedError && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setActiveTab(
                                                    "error",
                                                )
                                            }
                                            className="flex max-w-[220px] items-center gap-1.5 truncate text-[10px] font-medium text-red-400 transition hover:text-red-300"
                                        >
                                            <TriangleAlert
                                                size={
                                                    12
                                                }
                                            />

                                            <span className="truncate">
                                                {
                                                    parsedError.title
                                                }
                                            </span>

                                            {parsedError.line !==
                                                null && (
                                                    <span className="shrink-0 text-white/25">
                                                        L
                                                        {
                                                            parsedError.line
                                                        }
                                                    </span>
                                                )}
                                        </button>
                                    )}

                                    <span className="hidden items-center gap-1 text-[9px] text-white/20 lg:flex">
                                        <Command
                                            size={
                                                10
                                            }
                                        />
                                        Enter
                                    </span>
                                </div>
                            </div>
                        </section>

                        {/* =================================================
                            RIGHT SIDEBAR
                        ================================================= */}

                        {sidebarOpen && (
                            <aside className="hidden w-[270px] shrink-0 flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#0a0a0a] lg:flex">
                                <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/[0.07] px-4">
                                    <div className="flex items-center gap-2">
                                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.06]">
                                            <Keyboard
                                                size={
                                                    12
                                                }
                                                className="text-white/50"
                                            />
                                        </div>

                                        <span className="text-[11px] font-semibold text-white/70">
                                            Workspace
                                        </span>
                                    </div>

                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSidebarOpen(
                                                false,
                                            )
                                        }
                                        className="text-white/25 transition hover:text-white"
                                    >
                                        <X
                                            size={
                                                14
                                            }
                                        />
                                    </button>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                                    {/* Status */}

                                    <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[9px] uppercase tracking-[0.16em] text-white/30">
                                                Runtime
                                            </span>

                                            <span className="flex items-center gap-1.5 text-[9px] text-emerald-400">
                                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                                Online
                                            </span>
                                        </div>

                                        <div className="mt-3 flex items-center gap-3">
                                            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/[0.07] bg-black">
                                                <Code2
                                                    size={
                                                        16
                                                    }
                                                    className="text-white/60"
                                                />
                                            </div>

                                            <div>
                                                <p className="text-[11px] font-semibold text-white/75">
                                                    {languageName(
                                                        language,
                                                    )}
                                                </p>

                                                <p className="mt-0.5 text-[9px] text-white/25">
                                                    Isolated
                                                    sandbox
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Shortcuts */}

                                    <div className="mt-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
                                        <div className="mb-3 flex items-center gap-2">
                                            <Keyboard
                                                size={
                                                    13
                                                }
                                                className="text-white/35"
                                            />

                                            <span className="text-[10px] font-semibold text-white/55">
                                                Keyboard
                                                Shortcuts
                                            </span>
                                        </div>

                                        <div className="space-y-2">
                                            {[
                                                [
                                                    "Run Code",
                                                    "Ctrl + Enter",
                                                ],
                                                [
                                                    "Format",
                                                    "Shift + Alt + F",
                                                ],
                                                [
                                                    "Save",
                                                    "Ctrl + S",
                                                ],
                                                [
                                                    "Comment",
                                                    "Ctrl + /",
                                                ],
                                                [
                                                    "Fullscreen",
                                                    "F11",
                                                ],
                                            ].map(
                                                ([
                                                    label,
                                                    key,
                                                ]) => (
                                                    <div
                                                        key={
                                                            label
                                                        }
                                                        className="flex items-center justify-between"
                                                    >
                                                        <span className="text-[9px] text-white/35">
                                                            {
                                                                label
                                                            }
                                                        </span>

                                                        <kbd className="rounded border border-white/[0.07] bg-black px-1.5 py-1 font-mono text-[8px] text-white/40">
                                                            {
                                                                key
                                                            }
                                                        </kbd>
                                                    </div>
                                                ),
                                            )}
                                        </div>
                                    </div>

                                    {/* Navigation */}

                                    <div className="mt-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
                                        <div className="mb-3 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/25">
                                            Quick Access
                                        </div>

                                        <div className="space-y-1">
                                            <Link
                                                href="/problems"
                                                className="flex items-center gap-2 rounded-md px-2 py-2 text-[10px] text-white/40 transition hover:bg-white/[0.05] hover:text-white"
                                            >
                                                <FileCode2
                                                    size={
                                                        12
                                                    }
                                                />
                                                Problem
                                                Arena
                                            </Link>

                                            <Link
                                                href="/leaderboard"
                                                className="flex items-center gap-2 rounded-md px-2 py-2 text-[10px] text-white/40 transition hover:bg-white/[0.05] hover:text-white"
                                            >
                                                <Zap
                                                    size={
                                                        12
                                                    }
                                                />
                                                Leaderboard
                                            </Link>

                                            <Link
                                                href="/bookmarks"
                                                className="flex items-center gap-2 rounded-md px-2 py-2 text-[10px] text-white/40 transition hover:bg-white/[0.05] hover:text-white"
                                            >
                                                <Bookmark
                                                    size={
                                                        12
                                                    }
                                                />
                                                My Bookmarks
                                            </Link>
                                        </div>
                                    </div>

                                    {/* Challenge */}

                                    <div className="mt-3 rounded-lg border border-white/[0.07] bg-gradient-to-br from-white/[0.05] to-transparent p-3">
                                        <div className="flex items-center gap-2">
                                            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-white/[0.08]">
                                                <Zap
                                                    size={
                                                        12
                                                    }
                                                    className="text-white/60"
                                                />
                                            </div>

                                            <span className="text-[10px] font-semibold text-white/60">
                                                Ready to
                                                practice?
                                            </span>
                                        </div>

                                        <p className="mt-2 text-[9px] leading-relaxed text-white/25">
                                            Solve
                                            coding
                                            problems
                                            with
                                            automated
                                            judging
                                            and
                                            execution
                                            analytics.
                                        </p>

                                        <Link
                                            href="/problems"
                                            className="mt-3 inline-flex items-center gap-1 text-[9px] font-semibold text-white/55 transition hover:text-white"
                                        >
                                            Explore
                                            Problems
                                            <ChevronRight
                                                size={
                                                    10
                                                }
                                            />
                                        </Link>
                                    </div>
                                </div>
                            </aside>
                        )}
                    </div>

                    {/* =================================================
                        TERMINAL / DIAGNOSTICS
                    ================================================= */}

                    <div className="mt-2.5 flex h-[30vh] min-h-[170px] max-h-[360px] shrink-0 flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#080808] shadow-[0_20px_60px_rgba(0,0,0,.35)]">
                        {/* Terminal Header */}

                        <div className="flex h-10 shrink-0 items-center border-b border-white/[0.07] bg-[#0c0c0c] px-2">
                            <button
                                type="button"
                                onClick={() =>
                                    setActiveTab(
                                        "terminal",
                                    )
                                }
                                className={`relative flex h-full items-center gap-2 px-3 text-[10px] font-semibold transition ${activeTab ===
                                        "terminal"
                                        ? "text-white"
                                        : "text-white/30 hover:text-white/60"
                                    }`}
                            >
                                <TerminalSquare
                                    size={
                                        13
                                    }
                                />
                                Terminal

                                {activeTab ===
                                    "terminal" && (
                                        <span className="absolute bottom-0 left-3 right-3 h-px bg-white" />
                                    )}
                            </button>

                            <button
                                type="button"
                                onClick={() =>
                                    setActiveTab(
                                        "error",
                                    )
                                }
                                className={`relative flex h-full items-center gap-2 px-3 text-[10px] font-semibold transition ${activeTab ===
                                        "error"
                                        ? "text-white"
                                        : "text-white/30 hover:text-white/60"
                                    }`}
                            >
                                <TriangleAlert
                                    size={
                                        13
                                    }
                                />
                                Diagnostics

                                {parsedError && (
                                    <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                                )}

                                {activeTab ===
                                    "error" && (
                                        <span className="absolute bottom-0 left-3 right-3 h-px bg-white" />
                                    )}
                            </button>

                            <div className="ml-auto flex items-center gap-1.5 pr-2">
                                {activeTab ===
                                    "terminal" &&
                                    output.length >
                                    0 && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setOutput(
                                                    [],
                                                )
                                            }
                                            className="rounded-md px-2 py-1 text-[9px] text-white/25 transition hover:bg-white/[0.05] hover:text-white/60"
                                        >
                                            Clear
                                        </button>
                                    )}

                                <span className="hidden h-4 w-px bg-white/[0.07] sm:block" />

                                <button
                                    type="button"
                                    onClick={() =>
                                        setFullscreen(
                                            (v) =>
                                                !v,
                                        )
                                    }
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-white/25 transition hover:bg-white/[0.05] hover:text-white"
                                    title="Fullscreen"
                                >
                                    {fullscreen ? (
                                        <Minimize2
                                            size={
                                                13
                                            }
                                        />
                                    ) : (
                                        <Maximize2
                                            size={
                                                13
                                            }
                                        />
                                    )}
                                </button>
                            </div>
                        </div>

                        {/* Terminal Content */}

                        <div className="min-h-0 flex-1 overflow-y-auto bg-[#050505] p-2">
                            {activeTab ===
                                "terminal" && (
                                    <Terminal
                                        run={run}
                                        output={
                                            output
                                        }
                                        onClear={() =>
                                            setOutput(
                                                [],
                                            )
                                        }
                                        onInput={
                                            handleInputSent
                                        }
                                        onIdleInput={
                                            handleInputSent
                                        }
                                    />
                                )}

                            {activeTab ===
                                "error" && (
                                    <div className="h-full p-2">
                                        {parsedError ? (
                                            <ErrorDetailsCard
                                                error={
                                                    parsedError
                                                }
                                                problemTitle="Interactive Workspace"
                                                onGoToError={
                                                    parsedError.line !==
                                                        null
                                                        ? () =>
                                                            goToErrorLine(
                                                                parsedError.line as number,
                                                            )
                                                        : undefined
                                                }
                                                onApplyQuickFix={
                                                    parsedError.quickFix
                                                        ? applyQuickFix
                                                        : undefined
                                                }
                                            />
                                        ) : (
                                            <div className="flex h-full flex-col items-center justify-center text-center">
                                                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/[0.06]">
                                                    <Check
                                                        size={
                                                            16
                                                        }
                                                        className="text-emerald-400"
                                                    />
                                                </div>

                                                <p className="mt-3 text-[11px] font-medium text-white/55">
                                                    No errors
                                                    detected
                                                </p>

                                                <p className="mt-1 max-w-sm text-[9px] leading-relaxed text-white/20">
                                                    Run your
                                                    program
                                                    and
                                                    structured
                                                    syntax
                                                    or
                                                    runtime
                                                    diagnostics
                                                    will
                                                    appear
                                                    here.
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                )}
                        </div>
                    </div>
                </div>
            </main>

            {/* =====================================================
                RESET DIALOG
            ===================================================== */}

            <ConfirmDialog
                open={resetOpen}
                title="Reset your code?"
                body="This will replace your current code with the default template for this language."
                confirmLabel="Reset"
                destructive
                onConfirm={() => {
                    handleReset();
                    setResetOpen(
                        false,
                    );
                }}
                onCancel={() =>
                    setResetOpen(
                        false,
                    )
                }
            />

            {/* =====================================================
                TOASTS
            ===================================================== */}

            <ToastStack
                toasts={[
                    ...customToasts,
                    ...legacyToasts,
                ]}
            />
        </div>
    );
}
