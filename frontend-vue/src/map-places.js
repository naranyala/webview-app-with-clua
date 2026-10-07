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

  /*
   * Saves many places at once, from an imported file.
   *
   * Deliberately built by folding the *same* rules addPlace() applies rather than
   * by writing a second set: the coordinate validator, the coordinate dedupe, the
   * label length cap, and MAX_SAVED_PLACES. A bulk path with its own rules is how
   * a collection ends up able to hold two places at one coordinate, or 250 of
   * them, depending on which path added it.
   *
   * Reports what happened rather than just what succeeded: imported, already
   * present, refused for a bad coordinate, and stopped by the cap. A file of 300
   * sites into a 200-place collection has to say "100 of these were dropped",
   * because a silent truncation looks like the file was wrong.
   */
  function addPlaces(candidates) {
    const rows = Array.isArray(candidates) ? candidates : [];
    let imported = 0;
    let alreadyThere = 0;
    let refused = 0;
    let overCap = 0;

    /* Working on a copy and committing once at the end: addPlace() writes state
       and a status message per call, so folding two hundred rows through it would
       produce two hundred saves of the whole workspace and two hundred status
       messages, of which only the last would ever be seen. */
    const working = [...places.value];
    const savedAt = now();

    for (const candidate of rows) {
      const coordinates = normalizeLocation({
        lat: candidate?.lat,
        lon: candidate?.lon,
      });
      const name = String(candidate?.label ?? '')
        .trim()
        .slice(0, MAX_PLACE_LABEL);
      if (!coordinates || !name) {
        refused += 1;
        continue;
      }
      if (
        working.some(
          (place) =>
            place.lat === coordinates.lat && place.lon === coordinates.lon,
        )
      ) {
        alreadyThere += 1;
        continue;
      }
      if (working.length >= MAX_SAVED_PLACES) {
        overCap += 1;
        continue;
      }
      /* Same construction as addPlace(), for the same reason: the schema owns id
         minting, and normalizeLocation's own `label` must not overwrite the name. */
      const place = normalizePlace({
        ...coordinates,
        label: name,
        createdAt: savedAt,
      });
      if (!place) {
        refused += 1;
        continue;
      }
      working.push(place);
      imported += 1;
    }

    if (imported > 0) places.value = working;

    const parts = [];
    if (imported > 0) {
      parts.push(
        `Imported ${imported} place${imported === 1 ? '' : 's'}. ${working.length} total.`,
      );
    }
    if (alreadyThere > 0) {
      parts.push(`${alreadyThere} already saved.`);
    }
    if (refused > 0) {
      parts.push(
        `${refused} skipped for want of a name or a usable coordinate.`,
      );
    }
    if (overCap > 0) {
      parts.push(
        `${overCap} dropped: the list holds at most ${MAX_SAVED_PLACES}.`,
      );
    }
    /* Nothing imported and something refused is the case that needs a loud
       failure: the reader asked for places and got none. */
    const onlyRefusals = imported === 0 && (refused > 0 || overCap > 0);
    setPlaceStatus(
      parts.join(' ') || 'Nothing in that file was a usable place.',
      onlyRefusals,
    );
    return { imported, alreadyThere, refused, overCap };
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
    addPlaces,
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
export const addPlaces = session.addPlaces;
export const renamePlace = session.renamePlace;
export const removePlace = session.removePlace;
export const clearPlaces = session.clearPlaces;
export const startPlaceEdit = session.startPlaceEdit;
export const cancelPlaceEdit = session.cancelPlaceEdit;
export const savePlaceEdit = session.savePlaceEdit;
export const mapPlacesSnapshot = session.snapshot;
export const applyMapPlaces = session.apply;
