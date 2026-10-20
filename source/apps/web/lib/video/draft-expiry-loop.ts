import type { DraftSweepCursor } from "./job-quota";
import { VIDEO_DRAFT_TTL_SECONDS } from "./job-lifecycle";
type SweepResult = { cursor: DraftSweepCursor | null; scanned: number; cancelled: number; blocked: number; done: boolean };
type Dependencies = { paused: () => boolean; now?: () => Date; sweep: (input: { cursor: DraftSweepCursor | null; cutoff: Date; limit: number }) => Promise<SweepResult> };
export function createDraftExpiryLoop(deps: Dependencies) {
  let cursor: DraftSweepCursor | null = null;
  let cutoff: Date | null = null;
  let pending: Promise<SweepResult> | null = null;
  let stopped = false;
  return {
    async run(): Promise<SweepResult | null> {
      if (stopped || pending || deps.paused()) return null;
      cutoff ??= new Date((deps.now?.() ?? new Date()).getTime() - VIDEO_DRAFT_TTL_SECONDS * 1000);
      pending = deps.sweep({ cursor, cutoff, limit: 50 });
      try {
        const result = await pending;
        cursor = result.cursor;
        if (result.done) { cursor = null; cutoff = null; }
        return result;
      } finally { pending = null; }
    },
    async stop() { stopped = true; await pending?.catch(() => undefined); },
  };
}
