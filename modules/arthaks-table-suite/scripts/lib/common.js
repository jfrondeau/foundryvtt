/**
 * Utilitaires partagés par toutes les fonctionnalités de la suite.
 */

/**
 * Fabrique un petit logger préfixé par le nom de la fonctionnalité. `info` journalise
 * en console ; `warn` journalise ET notifie l'utilisateur (ui.notifications).
 * @param {string} tag - Étiquette de la fonctionnalité (ex. « Gabarits », « Combat »).
 * @returns {{ info: (m: string) => void, warn: (m: string) => void }}
 */
export function makeNotify(tag) {
  return {
    info: (m) => console.log(`[Arthak's Table · ${tag}] ${m}`),
    warn: (m) => { console.warn(`[Arthak's Table · ${tag}] ${m}`); ui.notifications?.warn(m); },
  };
}
