<script setup>
/*
 * The image preview dialog.
 *
 * Extracted from App.vue so its focus behaviour is one component's job: it
 * takes focus when it opens, keeps Tab inside itself while open, and returns
 * focus to whatever opened it. It previously had none of that, so a keyboard
 * user could tab out of the dialog into the page behind and focus was lost on
 * close.
 */
import { nextTick, onBeforeUnmount, watch } from 'vue';

const props = defineProps({
  /** The image being previewed, or null when the dialog is closed. */
  image: { type: Object, default: null },
  /** 1-based position, shown as "3 of 12". */
  position: { type: Number, default: 0 },
  /** Total images in the current collection. */
  total: { type: Number, default: 0 },
  /** Outline items the image can be attached to. */
  tocItems: { type: Array, default: () => [] },
  /** The item new links go to (v-model). */
  linkTargetId: { type: String, default: null },
  /** The resolved link target item, or null. */
  linkTarget: { type: Object, default: null },
});

const emit = defineEmits(['close', 'step', 'attach', 'update:linkTargetId']);

let previouslyFocused = null;

function focusableElements() {
  const root = document.querySelector('.lightbox');
  if (!root) return [];
  return [
    ...root.querySelectorAll(
      'button, select, [href], [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  // Keep focus inside the dialog: wrap at both ends.
  const focusable = focusableElements();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.image,
  async (image, previous) => {
    if (!image) return;
    if (!previous) {
      previouslyFocused = document.activeElement;
      await nextTick();
      document.querySelector('.lightbox')?.focus();
    }
  },
);

onBeforeUnmount(() => {
  // Return focus to the control that opened the preview.
  if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
});
</script>

<template>
  <div
    v-if="image"
    class="lightbox"
    role="dialog"
    aria-modal="true"
    :aria-label="`Image preview: ${image.name}`"
    tabindex="-1"
    @click.self="emit('close')"
    @keydown="onKeydown"
  >
    <button class="lightbox-close" type="button" aria-label="Close preview" @click="emit('close')">×</button>
    <button
      class="lightbox-nav previous"
      type="button"
      aria-label="Previous image"
      :disabled="total < 2"
      @click="emit('step', -1)"
    >
      ‹
    </button>
    <figure>
      <img :src="image.dataUrl" :alt="image.name" />
      <figcaption>
        {{ image.relativePath }}<span v-if="total > 0"> · {{ position }} of {{ total }}</span>
      </figcaption>
      <div class="lightbox-attach">
        <label class="sr-only" for="lightbox-link-target">Outline item</label>
        <select
          id="lightbox-link-target"
          :value="linkTargetId"
          @change="emit('update:linkTargetId', $event.target.value)"
        >
          <option :value="null" disabled>Select outline item</option>
          <option v-for="item in tocItems" :key="item.id" :value="item.id">
            {{ item.title }}
          </option>
        </select>
        <button
          class="toolbar-button primary"
          type="button"
          :disabled="!linkTarget"
          @click="emit('attach', image)"
        >
          Attach to section
        </button>
      </div>
    </figure>
    <button
      class="lightbox-nav next"
      type="button"
      aria-label="Next image"
      :disabled="total < 2"
      @click="emit('step', 1)"
    >
      ›
    </button>
  </div>
</template>
