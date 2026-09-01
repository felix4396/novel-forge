import os from "node:os";
import { NovelSideEffectJobService, novelSideEffectJobService } from "./NovelSideEffectJobService";
import {
  NovelSideEffectJobHandlers,
  UnsupportedNovelSideEffectPayloadError,
} from "./NovelSideEffectJobHandlers";

export interface NovelSideEffectWorkerOptions {
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
}

export class NovelSideEffectWorker {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly pollMs: number;

  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;

  constructor(
    private readonly jobService: NovelSideEffectJobService = novelSideEffectJobService,
    private readonly handlers: NovelSideEffectJobHandlers = new NovelSideEffectJobHandlers(),
    options: NovelSideEffectWorkerOptions = {},
  ) {
    this.workerId = options.workerId
      ?? `novel-side-effect-${os.hostname()}-${process.pid}`;
    this.leaseMs = options.leaseMs ?? 120_000;
    this.pollMs = options.pollMs ?? 5_000;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.jobService.recoverExpiredRunningJobs().catch((error) => {
      console.warn("[novel-side-effect-worker] failed to recover expired jobs", error);
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.isTicking) {
      return;
    }
    this.isTicking = true;
    try {
      const job = await this.jobService.leaseNext({
        workerId: this.workerId,
        leaseMs: this.leaseMs,
      });
      if (!job) {
        return;
      }
      try {
        await this.handlers.execute(job);
        await this.jobService.markSucceeded(job);
      } catch (error) {
        const forceDead = error instanceof UnsupportedNovelSideEffectPayloadError;
        await this.jobService.markFailedOrDead(job, error, { forceDead });
      }
    } finally {
      this.isTicking = false;
    }
  }
}

export const novelSideEffectWorker = new NovelSideEffectWorker();
