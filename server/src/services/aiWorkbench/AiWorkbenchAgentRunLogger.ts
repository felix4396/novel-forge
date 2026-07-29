import type { AgentStepType } from "@ai-novel/shared/types/agent";
import { AgentTraceStore } from "../../agents/traceStore";

const WORKBENCH_ROLE_SEQUENCE = ["Planner", "ContextBuilder", "Writer", "Reviewer"] as const;

type WorkbenchRole = typeof WORKBENCH_ROLE_SEQUENCE[number];

interface WorkbenchRunInput {
  novelId?: string | null;
  chapterId?: string | null;
  sessionId: string;
  goal: string;
  metadata?: Record<string, unknown>;
}

interface WorkbenchStepInput {
  runId: string;
  role: WorkbenchRole;
  stepType?: AgentStepType;
  status?: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string | null;
  provider?: string | null;
  model?: string | null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

export class AiWorkbenchAgentRunLogger {
  private readonly store = new AgentTraceStore();

  async startRun(input: WorkbenchRunInput): Promise<string> {
    const run = await this.store.createRun({
      sessionId: input.sessionId,
      goal: input.goal,
      novelId: input.novelId ?? undefined,
      chapterId: input.chapterId ?? undefined,
      entryAgent: "Planner",
      metadataJson: safeJson({
        source: "ai_workbench",
        roles: WORKBENCH_ROLE_SEQUENCE,
        ...input.metadata,
      }),
    });
    await this.store.updateRun(run.id, {
      status: "running",
      startedAt: new Date(),
      currentStep: "Planner",
      currentAgent: "Planner",
    });
    return run.id;
  }

  async markRunning(input: { runId: string; currentStep?: string; currentAgent?: WorkbenchRole }): Promise<void> {
    await this.store.updateRun(input.runId, {
      status: "running",
      currentStep: input.currentStep ?? "Planner",
      currentAgent: input.currentAgent ?? "Planner",
      error: null,
      finishedAt: null,
    });
  }

  async addStep(input: WorkbenchStepInput): Promise<void> {
    await this.store.addStep({
      runId: input.runId,
      agentName: input.role,
      stepType: input.stepType ?? this.defaultStepType(input.role),
      status: input.status ?? "succeeded",
      inputJson: input.input ? safeJson(input.input) : undefined,
      outputJson: input.output ? safeJson(input.output) : undefined,
      error: input.error ?? undefined,
      provider: input.provider ?? undefined,
      model: input.model ?? undefined,
    });
    await this.store.updateRun(input.runId, {
      currentStep: input.role,
      currentAgent: input.role,
    });
  }

  async finishRun(input: { runId: string; status?: "succeeded" | "failed" | "cancelled" | "waiting_approval"; error?: string | null }): Promise<void> {
    await this.store.updateRun(input.runId, {
      status: input.status ?? "succeeded",
      currentStep: input.status === "failed"
        ? "failed"
        : input.status === "waiting_approval"
          ? "waiting_approval"
          : "completed",
      currentAgent: "Reviewer",
      error: input.error ?? null,
      finishedAt: input.status === "waiting_approval" ? null : new Date(),
    });
  }

  private defaultStepType(role: WorkbenchRole): AgentStepType {
    if (role === "Writer") return "write";
    if (role === "Reviewer") return "approval";
    return "reasoning";
  }
}

export const aiWorkbenchAgentRunLogger = new AiWorkbenchAgentRunLogger();
