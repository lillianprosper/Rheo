/**
 * Navigation seam — place at: apps/admin/src/app/dashboard/navigation.ts
 *
 * Why this file exists: jsdom (the browser simulator Jest uses) cannot
 * perform real page navigation, and modern jsdom makes window.location
 * non-overridable. Isolating the redirect behind this one-line module
 * gives tests a clean mock point (jest.mock) without hacking globals —
 * a proper seam per the modular/context-engineering rule.
 */
export const redirectToLogin = (): void => {
  window.location.replace('/login')
}
