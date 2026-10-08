/** Serialize refreshes and coalesce requests received during a refresh into one follow-up.
 * A caller arriving during a scan waits for that follow-up, rather than sharing a scan that
 * may already have read the manifest before the caller changed it. */
export function queuedRefresh(refresh: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | undefined;
  let queued: Promise<void> | undefined;

  const start = (): Promise<void> => {
    active = Promise.resolve().then(refresh).finally(() => { active = undefined; });
    return active;
  };

  return () => {
    if (queued) {
      return queued;
    }
    if (!active) {
      return start();
    }
    // A failed scan must not strand later requests. Its own callers still see the rejection.
    queued = active.catch(() => {}).then(() => {
      queued = undefined;
      return start();
    });
    return queued;
  };
}
