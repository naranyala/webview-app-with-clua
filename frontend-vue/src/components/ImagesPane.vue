<script setup>
/*
 * ImagesPane - the Image Viewer pane.
 *
 * Extracted from App.vue, which was one file holding the shell and every pane's
 * template at once. The session state this pane reads is still owned by the
 * modules App.vue composes - this file adds markup and the few handlers that are
 * specific to one pane, and nothing else.
 *
 * Generated from the pane's own template by a one-shot tool, so the imports below
 * are exactly the bindings the template references and nothing was dropped in the
 * move. tests/template-bindings.test.js checks that claim over every component.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { view } from '../app-shell.js';
import {
  closeLightbox,
  imageDirectoryName,
  imageFiles,
  imageGroups,
  imageLoading,
  imageRecentPaths,
  imageSidebarOpen,
  imageStatus,
  imageStatusError,
  loadBrowserImageDirectory,
  openImageDirectory,
  openImageDirectoryAt,
  openLightbox,
  selectedImageGroup,
  toggleImageSidebar,
  visibleImages,
} from '../image-session.js';
import StatusLine from './StatusLine.vue';
</script>

<template>
    <section
      v-show="view === 'images'"
      class="image-app"
      :class="{ 'sidebar-closed': !imageSidebarOpen }"
      data-view="images"
      aria-label="Image viewer application"
    >
      <header class="image-toolbar">
        <div>
          <span class="image-eyebrow">IMAGE VIEWER</span>
          <strong>{{ imageDirectoryName || 'Choose an image directory' }}</strong>
        </div>
        <div class="image-actions">
          <StatusLine
            id="image-status"
            class="image-status"
            :message="imageStatus"
            :error="imageStatusError"
          />
          <button v-show="imageFiles.length > 0" class="toolbar-button primary" id="open-image-directory" type="button" :disabled="imageLoading" @click="openImageDirectory">Choose directory</button>
          <button
            class="toolbar-button subtle"
            id="image-toggle-sidebar"
            type="button"
            :aria-expanded="imageSidebarOpen"
            aria-controls="image-sidebar"
            @click="toggleImageSidebar"
          >
            {{ imageSidebarOpen ? 'Hide folders' : `Folders (${imageGroups.length})` }}
          </button>
        </div>
      </header>
      <!--
        Hidden with visibility, never unmounted, so a closed panel keeps its
        scroll position. Below the narrow breakpoint it overlays the thumbnail
        grid instead of taking a column of it.
      -->
      <button
        v-show="!imageSidebarOpen"
        class="sidebar-backdrop"
        type="button"
        tabindex="-1"
        aria-label="Close the folders panel"
        @click="toggleImageSidebar"
      />
      <aside
        id="image-sidebar"
        class="image-sidebar"
        :class="{ closed: !imageSidebarOpen }"
        aria-label="Image folders"
      >
        <div class="image-sidebar-heading">FOLDERS</div>
        <button
          v-for="group in imageGroups"
          :key="group.name"
          class="image-group-button"
          :class="{ active: selectedImageGroup === group.name }"
          :title="group.name"
          type="button"
          @click="selectedImageGroup = group.name; closeLightbox(); toggleImageSidebar()"
        >
          <span>{{ group.name }}</span><small>{{ group.images.length }}</small>
        </button>
      </aside>
      <div class="image-content">
        <input
          id="image-directory-input"
          ref="imageDirectoryInput"
          class="sr-only"
          type="file"
          webkitdirectory
          multiple
          accept="image/*,.avif,.heic,.heif,.svg,.tif,.tiff"
          @change="loadBrowserImageDirectory"
        />
        <div v-if="!imageFiles.length" class="image-empty">
          <span class="image-large-icon" aria-hidden="true">IMG</span>
          <h2>Open a folder of images</h2>
          <p>Pick a remembered directory below, or choose a parent one. Inner folders become categories in the sidebar.</p>
          <button class="toolbar-button primary" id="browse-image-directory" type="button" :disabled="imageLoading" @click="openImageDirectory">Choose directory</button>
          <!--
            The remembered list replaces the old "select the folder again to
            reload" flow: a stored directory is only scanned when its path is
            chosen here, so no launch walks the filesystem on its own.
          -->
          <div v-if="imageRecentPaths.length" class="recent-paths" aria-label="Remembered directories">
            <span class="recent-paths-title">REMEMBERED</span>
            <ul class="recent-paths-list">
              <li v-for="path in imageRecentPaths" :key="path">
                <button class="recent-path" type="button" :disabled="imageLoading" :title="path" @click="openImageDirectoryAt(path)">{{ path }}</button>
              </li>
            </ul>
          </div>
        </div>
        <div v-else class="image-grid" aria-label="Image thumbnails">
          <button v-for="image in visibleImages" :key="image.relativePath" class="image-thumbnail" type="button" @click="openLightbox(image)">
            <!--
              The thumbnail, not the original. The host downscales during the
              scan (image_directory.c) and sends the full-resolution bytes only
              when the lightbox asks, so a grid of 12 MP photos holds ~1 MB
              instead of ~120 MB. width/height let the cell reserve its box
              before the data URL decodes, which stops the grid reflowing as
              images arrive. `thumbnail || dataUrl` keeps a host that predates
              the field rendering.
            -->
            <img
              :src="image.thumbnail || image.dataUrl"
              :alt="image.name"
              :width="image.width || undefined"
              :height="image.height || undefined"
              loading="lazy"
              decoding="async"
            />
            <span :title="image.relativePath">{{ image.name }}</span>
          </button>
        </div>
      </div>
    </section>

</template>
