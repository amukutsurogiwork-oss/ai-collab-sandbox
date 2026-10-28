"use strict";

/**
 * Read policy: a public document is readable by anyone; a private document
 * is readable only by its authenticated owner.
 */
function canReadDocument(viewer, document) {
  if (!document || typeof document !== "object") return false;
  if (document.isPublic === true) return true;
  return Boolean(viewer && viewer.id && viewer.id === document.ownerId);
}

module.exports = { canReadDocument };
