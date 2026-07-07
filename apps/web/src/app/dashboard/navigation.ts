/**
 * Navigation seam — place at: apps/web/src/app/dashboard/navigation.ts
 * (REPLACES the previous version; adds goToJobs for post-create navigation.)
 *
 * All navigation goes through this one-line module so jsdom tests can
 * jest.mock() it cleanly. Hard navigation (not router.push) is deliberate:
 * it bypasses the Next.js client router cache so middleware and server
 * components see fresh state — the root cause of the "login stays open"
 * bug fixed in commit 9fa798e2.
 */
export const redirectToLogin = (): void => {
  window.location.assign('/login?from=/dashboard')
}

/** Post-create landing: the jobs list, where the new job appears. */
export const goToJobs = (): void => {
  window.location.assign('/dashboard/jobs')
}
