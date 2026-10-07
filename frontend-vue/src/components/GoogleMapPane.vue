<script setup>
/*
 * GoogleMapPane - the Google Maps Viewer pane.
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
import { formatCoordinates } from '../geo.js';
import {
  addGooglePlaceFromUrl,
  clearGoogleParsedPlaces,
  downloadGoogleGeoJSON,
  googleMapCenter,
  googleMapCursorLocation,
  googleMapLayer,
  googleMapLayers,
  googleMapLoading,
  googleMapPanning,
  googleMapRenderer,
  googleMapScaleBar,
  googleMapShowCursor,
  googleMapShowGrid,
  googleMapStatus,
  googleMapStatusError,
  googleMapTiles,
  googleMapTransform,
  googleMapZoomLabel,
  googleParsedPlaces,
  googlePreviousLayer,
  googlePreviousTransform,
  googleTileSource,
  googleZoomIn,
  googleZoomOut,
  handleGoogleMapDoubleClick,
  handleGoogleMapKeydown,
  handleGoogleMapPointerCancel,
  handleGoogleMapPointerDown,
  handleGoogleMapPointerLeave,
  handleGoogleMapPointerMove,
  handleGoogleMapPointerUp,
  handleGoogleMapWheel,
  noteGoogleTileLoaded,
  removeGoogleParsedPlace,
  setGoogleMapLayer,
  setGoogleMapRenderer,
  setGoogleMapShowCursor,
  setGoogleMapShowGrid,
} from '../google-maps-session.js';
import {
  activeLightboxImage,
  changeLightbox,
  closeLightbox,
  imageFiles,
  lightboxFullSizeLoading,
  lightboxFullSizeUrl,
  lightboxIndex,
} from '../image-session.js';
import {
  attachImageToToc,
  linkTarget,
  linkTargetId,
  tocItems,
} from '../toc-outline.js';
import LightboxDialog from './LightboxDialog.vue';
import StatusLine from './StatusLine.vue';

const layerLabel = (layer) => {
  const labels = { m: 'Road', s: 'Satellite', y: 'Hybrid', t: 'Terrain' };
  return labels[layer] || 'Road';
};

const googleMapUrlInput = ref('');

function handleParseUrl() {
  const url = googleMapUrlInput.value.trim();
  if (!url) return;
  addGooglePlaceFromUrl(url);
  googleMapUrlInput.value = '';
}
</script>

<template>
    <section
      v-show="view === 'googlemap'"
      class="google-map-app"
      :class="{ 'canvas-mode': googleMapRenderer === 'canvas' }"
      data-view="googlemap"
      aria-label="Google Maps viewer"
    >
      <header class="google-map-toolbar">
        <div>
          <span class="google-map-eyebrow">GOOGLE MAPS</span>
          <strong id="google-map-center-label">{{ formatCoordinates(googleMapCenter) }}</strong>
        </div>
        <div class="google-map-actions">
          <StatusLine
            id="google-map-status"
            class="google-map-status"
            :message="googleMapStatus"
            :error="googleMapStatusError"
          />
          <button class="toolbar-button subtle" id="google-map-zoom-out" type="button" aria-label="Zoom out" @click="googleZoomOut">−</button>
          <span class="google-map-zoom-label">{{ googleMapZoomLabel }}</span>
          <button class="toolbar-button subtle" id="google-map-zoom-in" type="button" aria-label="Zoom in" @click="googleZoomIn">+</button>
        </div>
      </header>

      <div class="google-map-options" role="group" aria-label="Map layer options">
        <label class="sr-only" for="google-map-layer">Map layer</label>
        <select id="google-map-layer" :value="googleMapLayer" @change="setGoogleMapLayer($event.target.value)">
          <option v-for="layer in googleMapLayers" :key="layer" :value="layer">{{ layerLabel(layer) }}</option>
        </select>
        <button
          class="toolbar-button subtle"
          id="google-map-toggle-renderer"
          type="button"
          :aria-pressed="googleMapRenderer === 'canvas'"
          :title="googleMapRenderer === 'canvas' ? 'Drawing on a canvas; switch to DOM tiles' : 'Drawing DOM tiles; switch to a canvas'"
          @click="setGoogleMapRenderer(googleMapRenderer === 'canvas' ? 'dom' : 'canvas')"
        >{{ googleMapRenderer === 'canvas' ? 'Canvas' : 'DOM' }}</button>
        <button class="toolbar-button subtle" id="google-map-toggle-grid" type="button" :aria-pressed="googleMapShowGrid" @click="setGoogleMapShowGrid(!googleMapShowGrid)">Grid</button>
        <button class="toolbar-button subtle" id="google-map-toggle-cursor" type="button" :aria-pressed="googleMapShowCursor" @click="setGoogleMapShowCursor(!googleMapShowCursor)">Cursor</button>
      </div>

      <div
        id="google-map-canvas"
        ref="googleMapElement"
        class="google-map-canvas"
        :class="{ panning: googleMapPanning }"
        role="application"
        aria-label="Google Maps. Drag to pan, scroll to zoom, use the zoom buttons to zoom, arrow keys to move."
        tabindex="0"
        @pointerdown="handleGoogleMapPointerDown"
        @pointermove="handleGoogleMapPointerMove"
        @pointerup="handleGoogleMapPointerUp"
        @pointercancel="handleGoogleMapPointerCancel"
        @pointerleave="handleGoogleMapPointerLeave"
        @dblclick="handleGoogleMapDoubleClick"
        @wheel="handleGoogleMapWheel"
        @keydown="handleGoogleMapKeydown"
      >
        <canvas
          v-if="googleMapRenderer === 'canvas'"
          id="google-map-canvas-surface"
          ref="googleMapCanvasContext"
          class="google-map-surface"
          aria-hidden="true"
        ></canvas>
        <template v-else>
          <div
            v-if="googlePreviousLayer"
            class="google-map-tile-layer google-map-tile-layer-previous"
            aria-hidden="true"
            :style="{ transform: googlePreviousTransform.css }"
          >
            <img
              v-for="tile in googlePreviousLayer.tiles"
              :key="`old-${tile.key}`"
              class="google-map-tile"
              :src="googleTileSource(tile)"
              :style="{ left: `${tile.left}px`, top: `${tile.top}px` }"
              alt=""
              draggable="false"
            />
          </div>
          <div class="google-map-tile-layer" :style="{ transform: googleMapTransform.css }">
            <img
              v-for="tile in googleMapTiles"
              :key="tile.key"
              class="google-map-tile"
              :src="googleTileSource(tile)"
              :style="{ left: `${tile.left}px`, top: `${tile.top}px` }"
              alt=""
              aria-hidden="true"
              draggable="false"
              decoding="async"
              @load="noteGoogleTileLoaded(tile.key)"
              @error="noteGoogleTileLoaded(tile.key)"
            />
          </div>
        </template>
        <div
          v-if="googleMapShowGrid"
          class="google-map-grid-overlay"
          aria-hidden="true"
          :style="{
            backgroundSize: `${256 * googleMapTransform.scale}px ${256 * googleMapTransform.scale}px`,
            backgroundPosition: `${googleMapTransform.x % (256 * googleMapTransform.scale)}px ${googleMapTransform.y % (256 * googleMapTransform.scale)}px`,
          }"
        ></div>
        <span
          v-if="googleMapShowCursor && googleMapCursorLocation"
          class="google-map-cursor-readout"
          aria-hidden="true"
        >{{ formatCoordinates(googleMapCursorLocation) }}</span>
        <div v-if="googleMapScaleBar.pixels" class="google-map-scale-bar">
          <span class="google-map-scale-rule" :style="{ width: `${googleMapScaleBar.pixels}px` }"></span>
          <span class="google-map-scale-label">{{ googleMapScaleBar.label }} · {{ googleMapScaleBar.imperial }}</span>
        </div>
        <span v-if="googleMapLoading" class="google-map-loading" role="status">Loading tiles…</span>
        <span class="google-map-attribution">Google Maps</span>
        <div v-if="!googleMapTiles.length" class="google-map-empty">
          <h2>Map unavailable</h2>
          <p>The tile area has not been measured yet. Tiles need a network connection.</p>
        </div>
      </div>

      <div class="google-map-sidebar">
        <div class="google-map-sidebar-heading">
          <span>URL PARSER</span>
        </div>
        <form class="google-map-url-form" @submit.prevent="handleParseUrl">
          <label class="sr-only" for="google-map-url-input">Google Maps URL</label>
          <input
            id="google-map-url-input"
            v-model="googleMapUrlInput"
            type="url"
            placeholder="Paste a Google Maps URL…"
            autocomplete="off"
          />
          <button class="toolbar-button primary" type="submit">Parse</button>
        </form>
        <div class="google-map-sidebar-heading">
          <span>PARSED PLACES ({{ googleParsedPlaces.length }})</span>
        </div>
        <div class="google-map-actions">
          <button class="toolbar-button subtle" id="google-map-clear-parsed" type="button" :disabled="googleParsedPlaces.length === 0" @click="clearGoogleParsedPlaces">Clear</button>
          <button class="toolbar-button primary" id="google-map-export-geojson" type="button" :disabled="googleParsedPlaces.length === 0" @click="downloadGoogleGeoJSON">Export GeoJSON</button>
        </div>
        <ul v-if="googleParsedPlaces.length" class="google-map-place-list">
          <li
            v-for="(place, index) in googleParsedPlaces"
            :key="`${place.name}-${index}`"
            class="google-map-place-row"
          >
            <div class="google-map-place-info">
              <strong>{{ place.name }}</strong>
              <small v-if="place.lat !== null">{{ formatCoordinates(place) }}</small>
              <small v-else>Search query (no coordinates)</small>
            </div>
            <button
              class="google-map-place-action danger"
              type="button"
              :title="`Remove ${place.name}`"
              @click="removeGoogleParsedPlace(index)"
            >×</button>
          </li>
        </ul>
        <p v-else class="google-map-place-empty">
          No places yet. Paste a Google Maps URL above to extract locations.
        </p>
      </div>
    </section>

    <Teleport to="body">
      <LightboxDialog
        :image="activeLightboxImage"
        :position="lightboxIndex + 1"
        :total="imageFiles.length"
        :toc-items="tocItems"
        :link-target-id="linkTargetId"
        :link-target="linkTarget"
        :full-size-url="lightboxFullSizeUrl"
        :loading-full-size="lightboxFullSizeLoading"
        @close="closeLightbox"
        @step="changeLightbox"
        @attach="attachImageToToc"
        @update:link-target-id="linkTargetId = $event"
      />
    </Teleport>
</template>
