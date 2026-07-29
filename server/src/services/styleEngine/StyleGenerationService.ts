import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { CompiledStylePromptBlocks } from "@ai-novel/shared/types/styleEngine";
import { runTextPrompt } from "../../prompting/core/promptRunner";
import { styleGenerationPrompt } from "../../prompting/prompts/style/style.prompts";
import { StyleRuntimeResolver } from "./StyleRuntimeResolver";

interface TestWriteInput {
  styleProfileId: string;
  mode: "generate" | "rewrite";
  topic?: string;
  sourceText?: string;
  targetLength?: number;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  styleIntensity?: number;
}

export class StyleGenerationService {
  private readonly resolver = new StyleRuntimeResolver();

  async testWrite(input: TestWriteInput): Promise<{
    output: string;
    compiledBlocks: CompiledStylePromptBlocks;
  }> {
    const resolved = await this.resolver.resolve({ styleProfileId: input.styleProfileId });
    if (!resolved.context.compiledBlocks) {
      throw new Error("该写法没有可执行规则。");
    }

    const targetLength = input.targetLength ?? 1200;
    const styleIntensity = Math.max(0.3, Math.min(input.styleIntensity ?? 0.8, 1));
    const intensityInstruction = [
      `风格强度：${Math.round(styleIntensity * 100)}%。`,
      styleIntensity >= 0.85
        ? "请高强度执行 StyleProfile 中的语言、节奏、结构和去 AI 味规则，但不要照搬来源文本的具体表达。"
        : styleIntensity >= 0.6
          ? "请平衡执行 StyleProfile 规则，优先保留剧情可读性和自然表达。"
          : "请低强度参考 StyleProfile，只迁移少量语言倾向和节奏特征。",
    ].join("\n");
    const prompt = input.mode === "rewrite"
      ? `任务：请在不改变事件事实与顺序的前提下改写原文，使其符合当前写法。

${intensityInstruction}

原文：
${input.sourceText ?? ""}`
      : `任务：请围绕以下主题创作一段小说文本，控制在 ${targetLength} 字左右。

${intensityInstruction}

主题：
${input.topic ?? ""}`;

    const result = await runTextPrompt({
      asset: styleGenerationPrompt,
      promptInput: {
        styleBlock: resolved.context.compiledBlocks.style,
        characterBlock: resolved.context.compiledBlocks.character,
        antiAiBlock: resolved.context.compiledBlocks.antiAi,
        selfCheckBlock: resolved.context.compiledBlocks.selfCheck,
        mode: input.mode,
        prompt,
        targetLength,
      },
      options: {
        provider: input.provider ?? "deepseek",
        model: input.model,
        temperature: input.temperature ?? 0.7,
      },
    });

    return {
      output: result.output.trim(),
      compiledBlocks: resolved.context.compiledBlocks,
    };
  }
}
