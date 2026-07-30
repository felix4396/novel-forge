import { referenceLibraryService } from "./ReferenceLibraryService";

export class ReferenceLibraryWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;

  async start(): Promise<void> {
    await referenceLibraryService.recoverInterruptedJobs();
    void referenceLibraryService.reconcileLegacyBooks().catch((error) => {
      console.warn("[reference-library] legacy reconciliation failed", error);
    });
    this.schedule(100);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.busy) return this.schedule(500);
    this.busy = true;
    try {
      const downloaded = await referenceLibraryService.claimAndRunDownloadJob();
      const searched = downloaded ? false : await referenceLibraryService.claimAndRunSearchJob();
      this.schedule(downloaded || searched ? 100 : 1_500);
    } catch (error) {
      console.error("[reference-library] worker tick failed", error);
      this.schedule(3_000);
    } finally {
      this.busy = false;
    }
  }
}

export const referenceLibraryWorker = new ReferenceLibraryWorker();
