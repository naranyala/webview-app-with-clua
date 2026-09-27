/*
 * Presentation of the persistence report produced by workspace.js.
 *
 * The raw report carries a scope (load/save), a protocol code, and a message.
 * This layer turns it into the sentence the header pill shows, so wording and
 * punctuation live in one place instead of being assembled at each call site.
 */

/* Returns { scope, code, text } for display, or null when there is no report. */
export function formatWorkspaceReport(report) {
  if (!report) return null;
  const detail =
    report.message.charAt(0).toUpperCase() + report.message.slice(1);
  return {
    scope: report.scope,
    code: report.code,
    text:
      report.scope === 'save'
        ? `Workspace not saved: ${detail}`
        : `Saved workspace not restored: ${detail}`,
  };
}
