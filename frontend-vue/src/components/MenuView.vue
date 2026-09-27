<script setup>
/*
 * The application menu: five tool cards, each with a live badge.
 *
 * Extracted because it is the one pane with no tool state of its own — it only
 * routes — so it needs five badge strings and one emit. That makes the routing
 * surface of the whole app a single readable component instead of 50 lines in
 * the composition root.
 */
defineProps({
  editorBadge: { type: String, default: '' },
  pdfBadge: { type: String, default: '' },
  imagesBadge: { type: String, default: '' },
  outlineBadge: { type: String, default: '' },
  mapBadge: { type: String, default: '' },
});

const emit = defineEmits(['select']);
</script>

<template>
  <section v-show="true" class="app-menu" data-view="menu" aria-label="Application menu">
    <div class="menu-heading">
      <span>APPLICATIONS</span>
      <h1>What would you like to open?</h1>
      <p>Choose a local tool to get started.</p>
    </div>
    <div class="app-grid">
      <button class="app-card" data-app="toc" type="button" @click="emit('select', 'toc')">
        <span class="app-icon toc-manager-icon" aria-hidden="true">TOC</span>
        <span class="app-card-copy">
          <strong>TOC Manager</strong>
          <small :title="outlineBadge">{{ outlineBadge }}</small>
        </span>
        <span class="app-card-arrow" aria-hidden="true">›</span>
      </button>
      <button class="app-card" data-app="editor" type="button" @click="emit('select', 'editor')">
        <span class="app-icon text-icon" aria-hidden="true">Aa</span>
        <span class="app-card-copy">
          <strong>Text Editor</strong>
          <small :title="editorBadge">{{ editorBadge }}</small>
        </span>
        <span class="app-card-arrow" aria-hidden="true">›</span>
      </button>
      <button class="app-card" data-app="pdf" type="button" @click="emit('select', 'pdf')">
        <span class="app-icon pdf-icon" aria-hidden="true">PDF</span>
        <span class="app-card-copy">
          <strong>PDF Reader</strong>
          <small :title="pdfBadge">{{ pdfBadge }}</small>
        </span>
        <span class="app-card-arrow" aria-hidden="true">›</span>
      </button>
      <button class="app-card" data-app="images" type="button" @click="emit('select', 'images')">
        <span class="app-icon image-icon" aria-hidden="true">IMG</span>
        <span class="app-card-copy">
          <strong>Image Viewer</strong>
          <small :title="imagesBadge">{{ imagesBadge }}</small>
        </span>
        <span class="app-card-arrow" aria-hidden="true">›</span>
      </button>
      <button class="app-card" data-app="map" type="button" @click="emit('select', 'map')">
        <span class="app-icon map-icon" aria-hidden="true">MAP</span>
        <span class="app-card-copy">
          <strong>Map Explorer</strong>
          <small :title="mapBadge">{{ mapBadge }}</small>
        </span>
        <span class="app-card-arrow" aria-hidden="true">›</span>
      </button>
    </div>
  </section>
</template>
