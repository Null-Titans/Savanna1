import { useCallback, useEffect, useRef, useState } from "react";
import { SupportedLanguage } from "../types/gateway";
import type {
  ToolCallExecutionResult,
  ToolCallRequest,
} from "../context/WebsiteAgentContext";
import {
  getLiveListeningGreeting,
  isGoodbyeCommand,
} from "../utils/voiceCommands";

export type GeminiLiveStatus = "idle" | "connecting" | "connected" | "error";

export interface LiveTranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestampIso: string;
}

export interface UseGeminiLiveOptions {
  onToolCall?: (call: ToolCallRequest) => Promise<ToolCallExecutionResult>;
  getStateSnapshot?: () => Record<string, unknown>;
  onExitCommand?: (spokenText: string) => void;
  onSessionReady?: (greetingText: string) => void;
}

function pcmFloat32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64PcmInt16ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const byteLen = binary.length;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(Math.floor(byteLen / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

export function useGeminiLive(
  language: SupportedLanguage,
  context: string = "career",
  options?: UseGeminiLiveOptions,
) {
  const [status, setStatus] = useState<GeminiLiveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [liveInputDraft, setLiveInputDraft] = useState("");
  const [liveOutputDraft, setLiveOutputDraft] = useState("");
  const [entries, setEntries] = useState<LiveTranscriptEntry[]>([]);

  const statusRef = useRef<GeminiLiveStatus>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const inputAccRef = useRef("");
  const outputAccRef = useRef("");
  const exitTriggeredRef = useRef(false);
  const sessionAttemptIdRef = useRef(0);
  const onToolCallRef = useRef(options?.onToolCall);
  onToolCallRef.current = options?.onToolCall;
  const getStateSnapshotRef = useRef(options?.getStateSnapshot);
  getStateSnapshotRef.current = options?.getStateSnapshot;
  const onExitCommandRef = useRef(options?.onExitCommand);
  onExitCommandRef.current = options?.onExitCommand;
  const onSessionReadyRef = useRef(options?.onSessionReady);
  onSessionReadyRef.current = options?.onSessionReady;

  const updateStatus = useCallback((next: GeminiLiveStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const stopPlaybackQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already stopped source nodes
      }
    }
    activeSourcesRef.current.clear();
    if (outputCtxRef.current) {
      nextStartTimeRef.current = outputCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  const cleanupResources = useCallback(() => {
    sessionAttemptIdRef.current += 1;
    stopPlaybackQueue();

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
        processorRef.current.onaudioprocess = null;
      } catch {
        // Ignore processor cleanup errors
      }
      processorRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (inputCtxRef.current) {
      try {
        void inputCtxRef.current.close();
      } catch {
        // Ignore close errors
      }
      inputCtxRef.current = null;
    }

    if (outputCtxRef.current) {
      try {
        void outputCtxRef.current.close();
      } catch {
        // Ignore close errors
      }
      outputCtxRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        if (
          wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING
        ) {
          wsRef.current.close();
        }
      } catch {
        // Ignore WebSocket close errors
      }
      wsRef.current = null;
    }
  }, [stopPlaybackQueue]);

  useEffect(() => {
    return () => {
      cleanupResources();
    };
  }, [cleanupResources]);

  const scheduleAudioChunk = useCallback((base64Pcm: string) => {
    const outCtx = outputCtxRef.current;
    if (!outCtx) return;
    if (outCtx.state === "suspended") {
      void outCtx.resume().catch(() => {});
    }
    const floatSamples = base64PcmInt16ToFloat32(base64Pcm);
    if (floatSamples.length === 0) return;

    const audioBuffer = outCtx.createBuffer(1, floatSamples.length, 24000);
    audioBuffer.getChannelData(0).set(floatSamples);

    const source = outCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(outCtx.destination);

    const now = outCtx.currentTime;
    const startAt = Math.max(now + 0.02, nextStartTimeRef.current);
    nextStartTimeRef.current = startAt + audioBuffer.duration;

    activeSourcesRef.current.add(source);
    source.onended = () => {
      activeSourcesRef.current.delete(source);
    };
    source.start(startAt);
  }, []);

  const flushAccumulators = useCallback(() => {
    const userText = inputAccRef.current.trim();
    const botText = outputAccRef.current.trim();
    if (userText || botText) {
      setEntries((prev) => {
        const next = [...prev];
        const ts = new Date().toISOString();
        if (userText) {
          next.push({
            id: `live-u-${Date.now()}-${next.length}`,
            role: "user",
            text: userText,
            timestampIso: ts,
          });
        }
        if (botText) {
          next.push({
            id: `live-a-${Date.now()}-${next.length}`,
            role: "assistant",
            text: botText,
            timestampIso: ts,
          });
        }
        return next;
      });
    }
    inputAccRef.current = "";
    outputAccRef.current = "";
    setLiveInputDraft("");
    setLiveOutputDraft("");
  }, []);

  const stopSession = useCallback(() => {
    flushAccumulators();
    cleanupResources();
    updateStatus("idle");
  }, [cleanupResources, flushAccumulators, updateStatus]);

  const syncContext = useCallback((overrideState?: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      statusRef.current !== "connected"
    ) {
      return false;
    }
    const statePayload = overrideState || getStateSnapshotRef.current?.();
    if (!statePayload) return false;
    ws.send(JSON.stringify({ type: "context", state: statePayload }));
    return true;
  }, []);

  const startSession = useCallback(
    async (startOpts?: { greetOnReady?: boolean }): Promise<boolean> => {
      // Prevent duplicate simultaneous sessions when already connecting or active
      if (
        statusRef.current === "connecting" ||
        statusRef.current === "connected"
      ) {
        return false;
      }

      cleanupResources();
      const attemptId = sessionAttemptIdRef.current;
      setErrorMessage(null);
      inputAccRef.current = "";
      outputAccRef.current = "";
      exitTriggeredRef.current = false;
      setLiveInputDraft("");
      setLiveOutputDraft("");
      updateStatus("connecting");

      if (typeof window === "undefined" || typeof WebSocket === "undefined") {
        updateStatus("error");
        setErrorMessage(
          "WebSocket audio streaming is unavailable in this environment.",
        );
        return false;
      }

      if (
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function"
      ) {
        updateStatus("error");
        setErrorMessage(
          "Microphone capture is not supported in this browser. Use text input or browser voice filtering instead.",
        );
        return false;
      }

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) {
        updateStatus("error");
        setErrorMessage("Web Audio API is unavailable in this browser.");
        return false;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (
          attemptId !== sessionAttemptIdRef.current ||
          statusRef.current === "idle"
        ) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        streamRef.current = stream;

        const inputCtx = new AudioCtx({ sampleRate: 16000 });
        const outputCtx = new AudioCtx({ sampleRate: 24000 });
        if (inputCtx.state === "suspended") {
          void inputCtx.resume().catch(() => {});
        }
        if (outputCtx.state === "suspended") {
          void outputCtx.resume().catch(() => {});
        }
        inputCtxRef.current = inputCtx;
        outputCtxRef.current = outputCtx;
        nextStartTimeRef.current = outputCtx.currentTime;

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsBaseUrl = (import.meta.env.VITE_WS_BASE_URL || "")
          .trim()
          .replace(/\/+$/, "");
        const wsOrigin = wsBaseUrl || `${protocol}//${window.location.host}`;

        const wsUrl = `${wsOrigin}/api/speech/live?lang=${encodeURIComponent(
          language,
        )}&context=${encodeURIComponent(context)}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        const source = inputCtx.createMediaStreamSource(stream);
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (ev) => {
          if (
            wsRef.current !== ws ||
            ws.readyState !== WebSocket.OPEN ||
            statusRef.current !== "connected"
          ) {
            return;
          }
          const channel = ev.inputBuffer.getChannelData(0);
          const base64Audio = pcmFloat32ToInt16Base64(channel);
          ws.send(JSON.stringify({ type: "audio", audio: base64Audio }));
        };

        source.connect(processor);
        processor.connect(inputCtx.destination);

        const greetOnReady = startOpts?.greetOnReady ?? true;

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data)) as {
              type?: string;
              data?: string;
              text?: string;
              message?: string;
              calls?: ToolCallRequest[];
            };
            if (msg.type === "ready") {
              updateStatus("connected");
              if (
                getStateSnapshotRef.current &&
                ws.readyState === WebSocket.OPEN
              ) {
                ws.send(
                  JSON.stringify({
                    type: "context",
                    state: getStateSnapshotRef.current(),
                  }),
                );
              }
              if (greetOnReady) {
                const greetingText = getLiveListeningGreeting(language);
                setEntries((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.role === "assistant" && last.text === greetingText)
                    return prev;
                  return [
                    ...prev,
                    {
                      id: `live-greet-${Date.now()}`,
                      role: "assistant",
                      text: greetingText,
                      timestampIso: new Date().toISOString(),
                    },
                  ];
                });
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "greet" }));
                }
                onSessionReadyRef.current?.(greetingText);
              }
            } else if (
              msg.type === "toolCalls" &&
              Array.isArray(msg.calls) &&
              onToolCallRef.current
            ) {
              const runner = onToolCallRef.current;
              void (async () => {
                const functionResponses: Array<{
                  id?: string;
                  name: string;
                  response: Record<string, unknown>;
                }> = [];
                for (const call of msg.calls!) {
                  try {
                    const res = await runner({
                      id: call.id,
                      name: call.name,
                      args: call.args || {},
                    });
                    functionResponses.push({
                      id: call.id,
                      name: call.name,
                      response: res.data,
                    });
                  } catch (err) {
                    functionResponses.push({
                      id: call.id,
                      name: call.name,
                      response: {
                        error:
                          err instanceof Error
                            ? err.message
                            : "Tool execution failed",
                      },
                    });
                  }
                }
                if (
                  ws.readyState === WebSocket.OPEN &&
                  functionResponses.length > 0
                ) {
                  ws.send(
                    JSON.stringify({
                      type: "toolResponses",
                      functionResponses,
                    }),
                  );
                  if (getStateSnapshotRef.current) {
                    ws.send(
                      JSON.stringify({
                        type: "context",
                        state: getStateSnapshotRef.current(),
                      }),
                    );
                  }
                }
              })();
            } else if (msg.type === "audio" && msg.data) {
              scheduleAudioChunk(msg.data);
            } else if (msg.type === "inputTranscript" && msg.text) {
              const combined = `${inputAccRef.current} ${msg.text}`.trim();
              inputAccRef.current = combined;
              setLiveInputDraft(combined);

              if (
                !exitTriggeredRef.current &&
                (isGoodbyeCommand(msg.text) || isGoodbyeCommand(combined))
              ) {
                exitTriggeredRef.current = true;
                stopSession();
                onExitCommandRef.current?.(combined);
              }
            } else if (msg.type === "outputTranscript" && msg.text) {
              outputAccRef.current =
                `${outputAccRef.current} ${msg.text}`.trim();
              setLiveOutputDraft(outputAccRef.current);
            } else if (msg.type === "interrupted") {
              stopPlaybackQueue();
            } else if (msg.type === "turnComplete") {
              flushAccumulators();
            } else if (msg.type === "error") {
              cleanupResources();
              updateStatus("error");
              setErrorMessage(
                msg.message ||
                  "Could not maintain Gemini Live voice connection.",
              );
            }
          } catch {
            // Ignore malformed JSON frames
          }
        };

        ws.onerror = () => {
          if (statusRef.current !== "error") {
            cleanupResources();
            updateStatus("error");
            setErrorMessage(
              "Real-time Live voice connection could not be reached. Please try again or use browser voice filtering.",
            );
          }
        };

        ws.onclose = () => {
          if (
            statusRef.current === "connected" ||
            statusRef.current === "connecting"
          ) {
            flushAccumulators();
            cleanupResources();
            updateStatus("idle");
          }
        };

        return true;
      } catch (err) {
        cleanupResources();
        updateStatus("error");
        const name = (err as Error)?.name || "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setErrorMessage(
            "Microphone permission was denied. Allow microphone access in browser settings and try again.",
          );
        } else {
          setErrorMessage(
            err instanceof Error
              ? err.message
              : "Unable to start real-time voice conversation.",
          );
        }
        return false;
      }
    },
    [
      cleanupResources,
      context,
      flushAccumulators,
      language,
      scheduleAudioChunk,
      stopPlaybackQueue,
      stopSession,
      updateStatus,
    ],
  );

  const sendText = useCallback(
    (text: string) => {
      const cleaned = text.trim();
      const ws = wsRef.current;
      if (!cleaned || !ws || ws.readyState !== WebSocket.OPEN) return false;

      if (isGoodbyeCommand(cleaned)) {
        exitTriggeredRef.current = true;
        setEntries((prev) => [
          ...prev,
          {
            id: `live-u-${Date.now()}-${prev.length}`,
            role: "user",
            text: cleaned,
            timestampIso: new Date().toISOString(),
          },
        ]);
        stopSession();
        onExitCommandRef.current?.(cleaned);
        return true;
      }

      ws.send(JSON.stringify({ type: "text", text: cleaned }));
      setEntries((prev) => [
        ...prev,
        {
          id: `live-u-${Date.now()}-${prev.length}`,
          role: "user",
          text: cleaned,
          timestampIso: new Date().toISOString(),
        },
      ]);
      return true;
    },
    [stopSession],
  );

  const clearEntries = useCallback(() => {
    setEntries([]);
    setLiveInputDraft("");
    setLiveOutputDraft("");
  }, []);

  return {
    status,
    errorMessage,
    liveInputDraft,
    liveOutputDraft,
    entries,
    startSession,
    stopSession,
    sendText,
    syncContext,
    clearEntries,
  };
}
