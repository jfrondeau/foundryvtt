/**
 * Utilitaires partagés par toutes les fonctionnalités de la suite.
 */
import { MODULE_ID } from "../const.js";

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

/**
 * Ouvre la feuille de réglages de Foundry en se plaçant directement sur la
 * catégorie de CETTE suite. Utile côté joueur quand l'interface est masquée : le
 * menu de configuration n'est plus accessible autrement.
 */
export async function openModuleSettings() {
  const app = game.settings?.sheet;
  if (!app) return;
  await app.render({ force: true });
  await new Promise((r) => requestAnimationFrame(r));
  try { app.changeTab(MODULE_ID, "categories"); return; }
  catch (e) { console.warn("[Arthak's Table] settings:", e); }
  // Repli DOM : clique l'entrée de catégorie du module.
  app.element?.querySelector?.(`[data-tab="${MODULE_ID}"], [data-category="${MODULE_ID}"]`)?.click?.();
}
