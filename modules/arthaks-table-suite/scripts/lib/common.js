/**
 * Utilitaires partagés par toutes les fonctionnalités de la suite.
 */

/**
 * Traduit une clé i18n (namespace « ATS. »), avec interpolation optionnelle. Enveloppe
 * `game.i18n` : `format` si des données sont fournies (ex. `{ name: "Feu" }` pour
 * « Cercle {name} »), sinon `localize`. À utiliser pour tout texte construit en DOM brut ;
 * les `name`/`hint` de réglages, menus et keybindings sont localisés automatiquement par
 * Foundry (leur passer directement la clé).
 * @param {string} key - Clé i18n (ex. « ATS.dock.name »).
 * @param {object} [data] - Données d'interpolation ; si présent, utilise `format`.
 * @returns {string} Le texte traduit dans la langue active.
 */
export function t(key, data) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

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
