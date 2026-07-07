/**
 * Navigation seam — place at: apps/web/src/app/dashboard/navigation.ts
 *
 * jsdom cannot navigate and its window.location is non-configurable, so all
 * auth redirects route through this one-line module, giving tests a clean
 * jest.mock() point. Hard navigation (not router.push) is deliberate: it
 * bypasses the Next.js client router cache so middleware and server
 * components see fresh auth cookies — the root cause of the "login stays
 * open" bug fixed in commit 9fa798e2.
 */
export const redirectToLogin = (): void => {
  window.location.assign('/login?from=/dashboard')
}
