/*
 * The Explorer's saved places: a named, persisted collection the reader builds
 * while exploring, independent of the outline.
 *
 * A place is a label plus a coordinate. That is the whole point of saving one -
 * "the north transect" is useful, a bare "51.507351, -0.127758" is not - so a
 * record without a label is not a place and normalizePlace() rejects it. The
 * coordinates themselves go through the map's validator, so a hand-edited
 * workspace cannot put NaN on the map.
 *
 * Places are separate from the outline's links.location on purpose. A place is
 * somewhere you have been; a location link is somewhere a section is *about*.
 * They meet at attachPlaceToToc(), which copies one into the other.
 */
import { computed, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { normalizeLocation } from './geo.js';
import {
  MAX_PLACE_LABEL,
  MAX_SAVED_PLACES,
  normalizePlace,
} from './workspace.js';

export function createMapPlaces({
  boot = restoredWorkspace,
  now = () => Date.now(),
} = {}) {
  const places = ref([...boot.map.places]);
  /* The row being renamed inline, or null. Mirrors the outline's edit state so
     the two lists behave the same way. */
  const editingPlaceId = ref(null);
  const placeStatus = ref(
    places.value.length > 0
      ? `${places.value.length} place${places.value.length === 1 ? '' : 's'} saved.`
      : 'Click the map to drop a pin, then save it as a named place.',
  );
  const placeStatusError = ref(false);

  function setPlaceStatus(message, isError = false) {
    placeStatus.value = message;
    placeStatusError.value = isError;
  }

  function setPlaces(next, message, isError = false) {
    places.value = next;
    setPlaceStatus(message, isError);
  }

  function findPlace(id) {
    return places.value.find((place) => place.id === id) || null;
  }

  /*
   * Saves a place. Re-adding one that is already stored moves it to the top and
   * keeps its label rather than making a near-duplicate the reader has to clean
   * up, which is what would otherwise happen every time someone re-picks a spot
   * they have already noted.
   */
  function addPlace({ label, lat, lon } = {}) {
    const coordinates = normalizeLocation({ lat, lon });
    const name = String(label ?? '')
      .trim()
      .slice(0, MAX_PLACE_LABEL);
    if (!coordinates) {
      setPlaceStatus('That spot is not a usable coordinate.', true);
      return null;
    }
    if (!name) {
      setPlaceStatus('Give the place a name before saving it.', true);
      return null;
    }
    const existing = places.value.find(
      (place) => place.lat === coordinates.lat && place.lon === coordinates.lon,
    );
    if (existing) {
      setPlaces(
        [existing, ...places.value.filter((place) => place.id !== existing.id)],
        `“${name}” is already saved as “${existing.label}”.`,
      );
      return existing;
    }
    if (places.value.length >= MAX_SAVED_PLACES) {
      setPlaceStatus(
        `The list already holds ${MAX_SAVED_PLACES} places. Remove one before saving another.`,
        true,
      );
      return null;
    }
    /*
     * The schema owns id minting and validation, so a new place is made by
     * handing it a record and taking back what it normalizes to.
     *
     * The spread order matters: normalizeLocation() carries its own `label`
     * field, and letting it spread last would overwrite the name with the empty
     * string it defaults to, so the place would be rejected as unnamed.
     */
    const place = normalizePlace({
      ...coordinates,
      label: name,
      createdAt: now(),
    });
    if (!place) {
      setPlaceStatus('That spot could not be saved.', true);
      return null;
    }
    setPlaces(
      [place, ...places.value],
      `Saved “${place.label}”. ${places.value.length + 1} place${
        places.value.length + 1 === 1 ? '' : 's'
      }.`,
    );
    return place;
  }

  /* Renames in place, keeping position and coordinates. */
  function renamePlace(id, label) {
    const place = findPlace(id);
    const name = String(label ?? '')
      .trim()
      .slice(0, MAX_PLACE_LABEL);
    if (!place) {
      setPlaceStatus('That place is no longer in the list.', true);
      return null;
    }
    if (!name) {
      setPlaceStatus('A place needs a name.', true);
      return null;
    }
    const updated = { ...place, label: name };
    setPlaces(
      places.value.map((candidate) =>
        candidate.id === id ? updated : candidate,
      ),
      `Renamed to “${name}”.`,
    );
    return updated;
  }

  function removePlace(id) {
    const place = findPlace(id);
    if (!place) return null;
    const remaining = places.value.length - 1;
    if (editingPlaceId.value === id) editingPlaceId.value = null;
    setPlaces(
      places.value.filter((candidate) => candidate.id !== id),
      `Removed “${place.label}”. ${remaining} place${remaining === 1 ? '' : 's'} left.`,
    );
    return place;
  }

  function clearPlaces() {
    editingPlaceId.value = null;
    setPlaces([], 'Cleared every saved place.');
  }

  function startPlaceEdit(id) {
    editingPlaceId.value = id;
  }

  function cancelPlaceEdit() {
    editingPlaceId.value = null;
  }

  function savePlaceEdit(id, label) {
    const updated = renamePlace(id, label);
    editingPlaceId.value = null;
    return updated;
  }

  /* The places session as it belongs in the workspace snapshot. */
  function snapshot() {
    return places.value;
  }

  function apply(incoming) {
    if (!incoming) return false;
    setPlaces(
      [...incoming],
      `${incoming.length} place${incoming.length === 1 ? '' : 's'} restored.`,
    );
    editingPlaceId.value = null;
    return true;
  }

  const placeCount = computed(() => places.value.length);

  return {
    places,
    placeCount,
    placeStatus,
    placeStatusError,
    editingPlaceId,
    setPlaceStatus,
    findPlace,
    addPlace,
    renamePlace,
    removePlace,
    clearPlaces,
    startPlaceEdit,
    cancelPlaceEdit,
    savePlaceEdit,
    snapshot,
    apply,
  };
}

const session = createMapPlaces();

export const places = session.places;
export const placeCount = session.placeCount;
export const placeStatus = session.placeStatus;
export const placeStatusError = session.placeStatusError;
export const editingPlaceId = session.editingPlaceId;
export const setPlaceStatus = session.setPlaceStatus;
export const findPlace = session.findPlace;
export const addPlace = session.addPlace;
export const renamePlace = session.renamePlace;
export const removePlace = session.removePlace;
export const clearPlaces = session.clearPlaces;
export const startPlaceEdit = session.startPlaceEdit;
export const cancelPlaceEdit = session.cancelPlaceEdit;
export const savePlaceEdit = session.savePlaceEdit;
export const mapPlacesSnapshot = session.snapshot;
export const applyMapPlaces = session.apply;
