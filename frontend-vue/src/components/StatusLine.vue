<script setup>
/*
 * The one status line every tool pane uses.
 *
 * Four panes each grew their own <span> with the same three bindings — an id,
 * an error class, a title, and aria-live — which is how the wording, the
 * announcement, and the error styling drifted apart. The pane-specific class
 * still comes through as a fallthrough attribute, so index.css keeps working
 * unchanged; what this component owns is the shared vocabulary.
 */
defineProps({
  /** Element id, e.g. "pdf-status": the static contract tests key on it. */
  id: { type: String, required: true },
  /** The sentence to show. Empty renders an empty (but present) line. */
  message: { type: String, default: '' },
  /** Renders the error treatment. */
  error: { type: Boolean, default: false },
  /** Announced politely; errors are assertive so they interrupt. */
  live: { type: String, default: 'polite' },
});
</script>

<template>
  <span
    :id="id"
    class="status-line"
    :class="{ error }"
    :title="message"
    role="status"
    :aria-live="live"
    :aria-atomic="true"
  >
    {{ message }}
  </span>
</template>
