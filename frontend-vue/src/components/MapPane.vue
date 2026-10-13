<script setup>
/*
 * MapPane - the Map Explorer pane.
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
import { readFileAsText } from '../file-io.js';
import { distanceMeters, formatCoordinates, formatDistance } from '../geo.js';
import {
  clearGeoJSONLayers,
  flyToLocation,
  geojsonFeatureCount,
  geojsonLayers,
  geojsonShapesFor,
  geojsonVisible,
  handleMapDoubleClick,
  handleMapKeydown,
  handleMapPointerCancel,
  handleMapPointerDown,
  handleMapPointerLeave,
  handleMapPointerMove,
  handleMapPointerUp,
  handleMapWheel,
  loadGeoJSON,
  mapAdmittedTiles,
  mapCursorBearing,
  mapCursorLocation,
  mapFilter,
  mapFilters,
  mapFlying,
  mapLoading,
  mapPanning,
  mapPin,
  mapPinOffset,
  mapRenderer,
  mapScaleBar,
  mapShowCursor,
  mapShowGrid,
  mapSidebarOpen,
  mapSize,
  mapStatus,
  mapStatusError,
  mapTiles,
  mapTransform,
  mapZoomLabel,
  noteTileLoaded,
  placeMarkerOffset,
  previousLayer,
  previousTransform,
  removeGeoJSONLayer,
  selectedPlace,
  selectPlace,
  setGeoJSONVisible,
  setMapFilter,
  setMapRenderer,
  setMapShowCursor,
  setMapShowGrid,
  setMapStatus,
  tileSource,
  toggleGeoJSONLayer,
  toggleMapSidebar,
  zoomIn,
  zoomOut,
} from '../map-explorer.js';
import { pathData } from '../map-geojson-view.js';
import { describeLocate, locateViaBrowser } from '../map-locate.js';
import {
  addPlace,
  addPlaces,
  cancelPlaceEdit,
  clearPlaces,
  editingPlaceId,
  placeCount,
  placeStatus,
  placeStatusError,
  places,
  removePlace,
  savePlaceEdit,
  setPlaceStatus,
  startPlaceEdit,
} from '../map-places.js';
import { parsePlacesFile } from '../map-places-import.js';
import { getNativeBinding, runNativeCall } from '../native-bridge.js';
import {
  attachLocationToToc,
  attachPlaceToToc,
  linkTarget,
  linkTargetId,
  tocItems,
} from '../toc-outline.js';
import { plural } from '../workspace.js';
import StatusLine from './StatusLine.vue';

const FILTER_LABELS = {
  none: 'Original colours',
  grayscale: 'Grayscale',
  dark: 'Dark',
  sepia: 'Sepia',
  vivid: 'Vivid',
  faded: 'Faded',
};

function filterLabel(name) {
  return FILTER_LABELS[name] || FILTER_LABELS.none;
}

function markerStyle(place) {
  const offset = placeMarkerOffset(place);
  if (!offset) return { display: 'none' };
  return { left: `${offset.left}px`, top: `${offset.top}px` };
}

function goToPlace(place) {
  if (!place) return;
  /* Selecting as well as travelling: arriving at a place is what makes it the
     one the cursor readout measures against. */
  selectPlace(place.id);
  flyToLocation(place);
}

function promptSavePlace() {
  if (!mapPin.value) {
    setPlaceStatus('Click the map to drop a pin first.', true);
    return;
  }
  /* No save call here on purpose: adding to `places` is watched, which covers
     this and every other way the collection changes. Calling it by hand as well
     would be a second source of truth for when a place is written. */
  addPlace({
    lat: mapPin.value.lat,
    lon: mapPin.value.lon,
    label: mapPin.value.label || formatCoordinates(mapPin.value),
  });
}

async function handleGeoJSONFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await loadGeoJSON(file);
  } catch (error) {
    setMapStatus(`Could not load GeoJSON: ${error.message}`, true);
  }
  event.target.value = '';
}

const legCache = new Map();

function placeLegFrom(from, to) {
  const key = `${from.lat},${from.lon}>${to.lat},${to.lon}`;
  if (legCache.has(key)) return legCache.get(key);
  const meters = distanceMeters(from, to);
  const label = meters === null ? '' : formatDistance(meters);
  if (legCache.size > 500) legCache.clear();
  legCache.set(key, label);
  return label;
}

function handlePlacesFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  /*
   * readFileAsText rather than withTextFileRead: the reader already picked the
   * file through a visible input, so going back through the host picker would ask
   * them to choose the same file twice.
   */
  readFileAsText(file)
    .then((text) => {
      const parsed = parsePlacesFile(file.name, text);
      if (parsed.error && parsed.candidates.length === 0) {
        setPlaceStatus(parsed.error, true);
        return;
      }
      addPlaces(parsed.candidates);
      /* The status the collection set is the one that counts, but a parse that
         dropped rows is worth saying out loud too — the two messages answer
         different questions and neither replaces the other. */
      if (parsed.skipped > 0) {
        setPlaceStatus(
          `${placeStatus.value} ${parsed.skipped} ${plural(parsed.skipped, 'row')} in ${file.name} had no point to place.`,
        );
      }
    })
    .catch((error) => {
      setPlaceStatus(`Could not read ${file.name}: ${error.message}`, true);
    });
}

const mapLocating = ref(false);

async function locateMapPlace(request = locateViaBrowser) {
  const binding = getNativeBinding('locateMapPlace');
  const result = binding
    ? await runNativeCall(() => binding())
    : await request();
  return result && typeof result === 'object' ? result : {};
}

async function locateMap() {
  if (mapLocating.value) return;
  mapLocating.value = true;
  try {
    const result = await locateMapPlace();
    const { message, error } = describeLocate(result);
    setMapStatus(message, error);
    /* An error does not move the map. Only a real fix does, and it arrives as a
       pin so the reader can see where "here" was taken to be. */
    if (!error)
      flyToLocation({ lat: result.lat, lon: result.lon, label: 'You' });
  } finally {
    mapLocating.value = false;
  }
}
</script>

<template>
    <section
      v-show="view === 'map'"
      class="map-app"
      :class="{ 'sidebar-closed': !mapSidebarOpen, 'canvas-mode': mapRenderer === 'canvas' }"
      data-view="map"
      aria-label="OpenStreetMap explorer"
    >
      <header class="map-toolbar">
        <div>
          <span class="map-eyebrow">MAP EXPLORER</span>
          <strong id="map-center-label">{{ mapPin ? formatCoordinates(mapPin) : 'No pin' }}</strong>
        </div>
        <div class="map-actions">
          <StatusLine
            id="map-status"
            class="map-status"
            :message="mapStatus"
            :error="mapStatusError"
          />
          <button class="toolbar-button subtle" id="map-zoom-out" type="button" aria-label="Zoom out" @click="zoomOut">−</button>
          <span class="map-coords">{{ mapZoomLabel }}</span>
          <button class="toolbar-button subtle" id="map-zoom-in" type="button" aria-label="Zoom in" @click="zoomIn">+</button>
          <!--
            Locate. Disabled while a request is in flight rather than hidden, so
            the control does not move around the toolbar between states, and the
            busy state is the only feedback - a locate that fails says why in the
            status line instead of silently doing nothing.
          -->
          <button
            class="toolbar-button subtle"
            id="map-locate"
            type="button"
            :disabled="mapLocating"
            :aria-busy="mapLocating"
            title="Centre the map on your location"
            @click="locateMap"
          >
            {{ mapLocating ? 'Locating…' : 'Locate' }}
          </button>
          <label class="sr-only" for="map-link-target">Outline item</label>
          <select id="map-link-target" v-model="linkTargetId">
            <option :value="null" disabled>Select outline item</option>
            <option v-for="item in tocItems" :key="item.id" :value="item.id">{{ item.title }}</option>
          </select>
          <button class="toolbar-button primary" id="map-attach-location" type="button" :disabled="!linkTarget || !mapPin" @click="attachLocationToToc">Attach location</button>
          <button class="toolbar-button subtle" id="map-toggle-sidebar" type="button" :aria-expanded="mapSidebarOpen" @click="toggleMapSidebar">
            {{ mapSidebarOpen ? 'Hide places' : `Places (${placeCount})` }}
          </button>
        </div>
      </header>

      <div class="map-options" role="group" aria-label="Map rendering options">
        <label class="sr-only" for="map-filter">Colour filter</label>
        <select id="map-filter" :value="mapFilter" @change="setMapFilter($event.target.value)">
          <option v-for="option in mapFilters" :key="option" :value="option">{{ filterLabel(option) }}</option>
        </select>
        <button
          class="toolbar-button subtle"
          id="map-toggle-renderer"
          type="button"
          :aria-pressed="mapRenderer === 'canvas'"
          :title="mapRenderer === 'canvas' ? 'Drawing on a canvas; switch to DOM tiles' : 'Drawing DOM tiles; switch to a canvas'"
          @click="setMapRenderer(mapRenderer === 'canvas' ? 'dom' : 'canvas')"
        >{{ mapRenderer === 'canvas' ? 'Canvas' : 'DOM' }}</button>
        <button class="toolbar-button subtle" id="map-toggle-grid" type="button" :aria-pressed="mapShowGrid" @click="setMapShowGrid(!mapShowGrid)">Grid</button>
        <button class="toolbar-button subtle" id="map-toggle-cursor" type="button" :aria-pressed="mapShowCursor" @click="setMapShowCursor(!mapShowCursor)">Cursor</button>
      </div>

      <!--
        role="application" with a tabindex: the map is a drag-and-wheel surface
        with no focusable children, so without them it could only be driven with
        a mouse. The cursor readout is not a live region because it changes on
        every pointer move and would flood a screen reader.
      -->
      <div
        id="map-canvas"
        ref="mapElement"
        class="map-canvas"
        :class="[
          `filter-${mapFilter}`,
          { panning: mapPanning, flying: mapFlying },
        ]"
        role="application"
        aria-label="OpenStreetMap. Click to drop a pin, drag or scroll to pan, pinch or use the zoom buttons to zoom, arrow keys to move."
        tabindex="0"
        @pointerdown="handleMapPointerDown"
        @pointermove="handleMapPointerMove"
        @pointerup="handleMapPointerUp"
        @pointercancel="handleMapPointerCancel"
        @pointerleave="handleMapPointerLeave"
        @dblclick="handleMapDoubleClick"
        @wheel="handleMapWheel"
        @keydown="handleMapKeydown"
      >
        <!--
          The canvas renderer draws the same tile set, through the same
          layerTransform(), onto one element instead of a few dozen images. It
          keeps every tile out of the layout tree, which is what a slow pan pays
          for, at the cost of doing the decode and draw by hand.
        -->
        <canvas
          v-if="mapRenderer === 'canvas'"
          id="map-canvas-surface"
          ref="mapCanvasContext"
          class="map-surface"
          aria-hidden="true"
        ></canvas>
        <template v-else>
          <!--
            Each layer carries its own single transform. The outgoing set keeps
            the transform it was drawn with, because its tiles are positioned at
            the previous tile zoom and would otherwise be placed at the wrong
            scale during the fade.
          -->
          <div
            v-if="previousLayer"
            class="map-tile-layer map-tile-layer-previous"
            aria-hidden="true"
            :style="{ transform: previousTransform.css }"
          >
            <img
              v-for="tile in previousLayer.tiles"
              :key="`old-${tile.key}`"
              class="map-tile"
              :src="tileSource(tile)"
              :style="{ left: `${tile.left}px`, top: `${tile.top}px` }"
              alt=""
              draggable="false"
            />
          </div>
          <!--
            Only admitted tiles are mounted. A tile still waiting behind the rate
            floor is not rendered as a pending <img>, because a transparent-pixel
            placeholder fires its load event immediately and the loading
            indicator would count it as ground that had arrived.
          -->
          <div class="map-tile-layer" :style="{ transform: mapTransform.css }">
            <img
              v-for="tile in mapAdmittedTiles"
              :key="tile.key"
              class="map-tile"
              :src="tileSource(tile)"
              :style="{ left: `${tile.left}px`, top: `${tile.top}px` }"
              alt=""
              aria-hidden="true"
              draggable="false"
              decoding="async"
              @load="noteTileLoaded(tile.key)"
              @error="noteTileLoaded(tile.key)"
            />
          </div>
        </template>
        <!--
          The grid is a background on the canvas rather than an element, because
          it has to stay aligned to tile lines while the layer moves. The cell
          size carries the layer scale and the offset carries the translate, so
          the grid tracks the map exactly instead of drifting a pixel per pan.
        -->
        <div
          v-if="mapShowGrid"
          class="map-grid-overlay"
          aria-hidden="true"
          :style="{
            backgroundSize: `${256 * mapTransform.scale}px ${256 * mapTransform.scale}px`,
            backgroundPosition: `${mapTransform.x % (256 * mapTransform.scale)}px ${mapTransform.y % (256 * mapTransform.scale)}px`,
          }"
        ></div>
        <!--
          The GeoJSON overlay, as SVG.

          It is a sibling of the tile layer rather than a child of it: the shapes
          are already in viewport pixels, so it carries no transform and does not
          scale with the tiles. That is what lets the same shapes be handed to the
          canvas renderer unchanged - see map-geojson-view.js.

          Kept outside the `v-else` above so a loaded layer is visible under both
          renderers. It used to be reachable only from the canvas path, which made
          the DOM renderer show an empty map while the sidebar said the file had
          loaded.
        -->
        <svg
          v-if="geojsonShapesFor.circles.length || geojsonShapesFor.paths.length"
          class="map-geojson-overlay"
          :viewBox="`0 0 ${mapSize.width} ${mapSize.height}`"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            v-for="shape in geojsonShapesFor.paths"
            :key="shape.key"
            :d="pathData(shape.points, shape.closed)"
            :stroke="shape.color"
            :fill="shape.closed ? shape.color : 'none'"
            :stroke-width="shape.strokeWidth"
            stroke-linejoin="round"
          />
          <circle
            v-for="shape in geojsonShapesFor.circles"
            :key="shape.key"
            :cx="shape.x"
            :cy="shape.y"
            :r="shape.r"
            :fill="shape.color"
          />
        </svg>
        <!-- Saved places, drawn over the tiles and before the live pin. -->
        <button
          v-for="place in places"
          :key="place.id"
          v-show="placeMarkerOffset(place)"
          class="map-place-marker"
          type="button"
          :style="markerStyle(place)"
          :title="`${place.label} · ${formatCoordinates(place)}`"
          :aria-label="`Go to ${place.label}`"
:aria-pressed="selectedPlace && selectedPlace.id === place.id"
          @click="goToPlace(place)"
        ><span class="map-place-marker-label">{{ place.label }}</span></button>
        <span
          v-if="mapPin && mapPinOffset"
          class="map-pin"
          :style="{ left: `${mapPinOffset.left}px`, top: `${mapPinOffset.top}px` }"
        ></span>
        <span
          v-if="mapShowCursor && mapCursorLocation"
          class="map-cursor-readout"
          aria-hidden="true"
        >{{ formatCoordinates(mapCursorLocation) }}</span>
        <!--
          How far the pointer is from the selected place. The scale bar answers
          "how big is a pixel"; this answers "how far is the thing I am pointing
          at", which is the question a reader hovering a marker is asking.
          Hidden rather than shown as an em dash when there is nothing selected,
          so the readout does not flicker through an empty state on every move.
        -->
        <span
          v-if="mapShowCursor && mapCursorBearing"
          class="map-cursor-bearing"
          aria-hidden="true"
        >
          {{ mapCursorBearing.bearingLabel }} {{ mapCursorBearing.point }} ·
          {{ mapCursorBearing.label }} · {{ mapCursorBearing.imperial }}
        </span>
        <!--
          The scale bar is derived from the resolution at the current centre, so
          it stays honest as the map pans north and south.
        -->
        <div v-if="mapScaleBar.pixels" class="map-scale-bar">
          <span class="map-scale-rule" :style="{ width: `${mapScaleBar.pixels}px` }"></span>
          <span class="map-scale-label">{{ mapScaleBar.label }} · {{ mapScaleBar.imperial }}</span>
        </div>
        <span v-if="mapLoading" class="map-loading" role="status">Loading tiles…</span>
        <span class="map-attribution">
          © <a href="https://www.openstreetmap.org/copyright" rel="noreferrer noopener" target="_blank">OpenStreetMap</a> contributors
        </span>
        <div v-if="!mapTiles.length" class="map-empty">
          <h2>Map unavailable</h2>
          <p>The tile area has not been measured yet. Tiles need a network connection.</p>
        </div>
      </div>

      <!--
        The saved places. Collapsed by hiding the column rather than unmounting,
        so the list keeps its scroll position and the map keeps its measured
        width - which matters, because a pane that is not in the layout has no
        size and therefore no tiles.
      -->
      <aside class="map-sidebar" :class="{ closed: !mapSidebarOpen }" aria-label="Saved places">
        <div class="map-sidebar-heading">
          <span>SAVED PLACES</span>
          <strong id="map-place-count">{{ placeCount }}</strong>
        </div>
        <div class="map-sidebar-actions">
          <button
            class="toolbar-button primary"
            id="map-save-place"
            type="button"
            :disabled="!mapPin"
            :title="mapPin ? `Save the pin as a named place` : 'Click the map to drop a pin first'"
            @click="promptSavePlace"
          >Save pin</button>
          <button class="toolbar-button subtle" id="map-clear-places" type="button" :disabled="placeCount === 0" @click="clearPlaces">Clear</button>
          <!--
            Import, not another "Load": the GeoJSON panel loads a *layer*, which
            is drawn and discarded, and this creates places that persist and can
            be attached to a section. Two file pickers over the same formats is
            the price of keeping those two things distinct.
          -->
          <label class="toolbar-button subtle" for="map-places-input">
            Import
            <input
              id="map-places-input"
              type="file"
              accept=".geojson,.json,.csv,application/geo+json,text/csv"
              class="sr-only"
              @change="handlePlacesFile"
            />
          </label>
        </div>
        <StatusLine
          id="map-place-status"
          class="map-place-status"
          :message="placeStatus"
          :error="placeStatusError"
        />
        <p v-if="editingPlaceId" class="map-place-editing-hint">Editing a name — Enter to save, Escape to cancel.</p>
        <ul v-if="placeCount" class="map-place-list">
          <li
            v-for="(place, index) in places"
            :key="place.id"
            class="map-place-row"
            :class="{
              active: mapPin && mapPin.lat === place.lat && mapPin.lon === place.lon,
              selected: selectedPlace && selectedPlace.id === place.id,
            }"
          >
            <!--
              The distance to the previous row, so the reader can see the shape of
              a route rather than a list of unrelated coordinates. Shown only from
              the second row on - a distance to nowhere above the first place is
              noise - and computed in the template rather than in the session so it
              is not persisted with the workspace.
            -->
            <small
              v-if="index > 0 && placeLegFrom(places[index - 1], place)"
              class="map-place-leg"
            >{{ placeLegFrom(places[index - 1], place) }}</small>
            <form v-if="editingPlaceId === place.id" class="map-place-edit" @submit.prevent="savePlaceEdit(place.id, $event.target.elements.name.value)">
              <label class="sr-only" :for="`place-name-${place.id}`">Place name</label>
              <input
                :id="`place-name-${place.id}`"
                name="name"
                type="text"
                :value="place.label"
                maxlength="80"
                autocomplete="off"
                @keydown.esc="cancelPlaceEdit"
              />
              <button class="toolbar-button primary" type="submit">Save</button>
              <button class="toolbar-button subtle" type="button" @click="cancelPlaceEdit">Cancel</button>
            </form>
            <template v-else>
              <!--
                Clicking the name both travels there and selects it, so the cursor
                readout has something to measure against. The marker on the map
                does the same: a place the reader can only reach by opening the
                sidebar is not really selectable.
              -->
              <button
                class="map-place-open"
                type="button"
                :aria-pressed="selectedPlace && selectedPlace.id === place.id"
                :title="`Go to ${place.label}`"
                @click="goToPlace(place)"
              >
                <strong>{{ place.label }}</strong>
                <small>{{ formatCoordinates(place) }}</small>
              </button>
              <div class="map-place-buttons">
                <button
                  class="map-place-action"
                  type="button"
                  :title="`Attach ${place.label} to the selected section`"
                  :disabled="!linkTarget"
                  @click="attachPlaceToToc(place)"
                >Link</button>
                <button class="map-place-action" type="button" :title="`Rename ${place.label}`" @click="startPlaceEdit(place.id)">✎</button>
                <button class="map-place-action danger" type="button" :title="`Remove ${place.label}`" @click="removePlace(place.id)">×</button>
              </div>
            </template>
          </li>
        </ul>
        <p v-else class="map-place-empty">
          No places yet. Click the map to drop a pin, then save it with a name.
        </p>

        <div class="map-sidebar-heading">
          <span>GEOJSON LAYERS</span>
          <strong v-if="geojsonLayers.length">{{ geojsonFeatureCount }} features</strong>
        </div>
        <div class="map-sidebar-actions">
          <label class="toolbar-button subtle" for="map-geojson-input">
            Load GeoJSON
            <input
              id="map-geojson-input"
              type="file"
              accept=".geojson,.json,application/geo+json"
              class="sr-only"
              @change="handleGeoJSONFile"
            />
          </label>
          <button class="toolbar-button subtle" id="map-toggle-geojson" type="button" :disabled="geojsonLayers.length === 0" @click="setGeoJSONVisible(!geojsonVisible)">
            {{ geojsonVisible ? 'Hide' : 'Show' }}
          </button>
          <button class="toolbar-button subtle" id="map-clear-geojson" type="button" :disabled="geojsonLayers.length === 0" @click="clearGeoJSONLayers">Clear</button>
        </div>
        <ul v-if="geojsonLayers.length" class="map-place-list">
          <li
            v-for="(layer, index) in geojsonLayers"
            :key="`geojson-${index}`"
            class="map-place-row"
          >
            <button class="map-place-open" type="button" :title="layer.visible ? 'Hide layer' : 'Show layer'" @click="toggleGeoJSONLayer(index)">
              <strong>{{ layer.name }}</strong>
              <small>{{ layer.features.length }} features {{ layer.visible ? '' : '(hidden)' }}</small>
            </button>
            <div class="map-place-buttons">
              <button class="map-place-action danger" type="button" :title="`Remove ${layer.name}`" @click="removeGeoJSONLayer(index)">×</button>
            </div>
          </li>
        </ul>
        <p v-else class="map-place-empty">
          No GeoJSON layers. Load a .geojson file to overlay it on the map.
        </p>
      </aside>
    </section>

</template>
