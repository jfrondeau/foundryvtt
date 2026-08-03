/**
 * Téléport de tokens — Module Foundry VTT v14 · Système dnd5e 5.x
 *
 * Permet au MJ de déplacer INSTANTANÉMENT les tokens sélectionnés vers un point de la
 * scène, sans trajet ni animation (« téléport »), en maintenant une touche dédiée et en
 * cliquant sur la scène. Utile à la table pour repositionner rapidement des créatures
 * sans les faire cheminer case par case.
 *
 * Mécanique :
 *  - Un raccourci clavier « teleportToken » (réservé au MJ, cf. settings.js) bascule un
 *    état MAINTENU (`held`) via ses `onDown`/`onUp`.
 *  - Tant que la touche est maintenue, un clic gauche sur le plateau (`canvas.app.view`)
 *    est intercepté EN PHASE DE CAPTURE, AVANT que Foundry ne démarre sa sélection au
 *    lasso : on annule l'événement (stopImmediatePropagation) et on téléporte à la place.
 *  - Les tokens gardent leur FORMATION : on calcule le vecteur qui amène le token de
 *    référence (le premier sélectionné) sur la case cliquée, puis on applique ce même
 *    vecteur à tous les tokens sélectionnés. Aucun empilement.
 *
 * Le placement est instantané grâce aux options d'update `{ animate: false, teleport: true }` :
 * `teleport` marque le déplacement comme une téléportation dans le pipeline de mouvement de
 * Foundry v13+ (pas de cheminement / contrainte de déplacement), `animate: false` supprime
 * toute interpolation visuelle.
 */

import { makeNotify, t } from "../lib/common.js";

const notify = makeNotify("Téléport");

// ═══════════════════════════════════════════════════════════════════════════════
// TÉLÉPORT
// ═══════════════════════════════════════════════════════════════════════════════
export class TokenTeleport {
  /** Vrai tant que la touche de téléport est maintenue enfoncée. */
  static held = false;
  /** Référence du gestionnaire pour idempotence / retrait éventuel. */
  static _handler = null;

  /**
   * Branche l'écoute des clics du plateau (une seule fois). Réservé au MJ : les joueurs
   * n'ont pas le raccourci (restricted) et le gestionnaire re-vérifie l'audience de toute
   * façon. Appelé au hook « ready ».
   */
  static install() {
    if (this._handler || !game.user?.isGM) return;
    this._handler = (ev) => this.onPointerDown(ev);
    // Capture : on passe AVANT les écouteurs PIXI du canvas (attachés sur l'élément
    // <canvas>), ce qui permet d'annuler la sélection au lasso quand on téléporte.
    document.addEventListener("pointerdown", this._handler, { capture: true });
    notify.info(t("ATS.teleport.ready"));
  }

  /** Bascule l'état maintenu (appelé par les onDown/onUp du keybinding). */
  static setHeld(v) { this.held = !!v; }

  /**
   * Intercepte un clic gauche sur le plateau pendant que la touche est maintenue.
   * @param {PointerEvent} ev
   */
  static onPointerDown(ev) {
    if (!this.held || ev.button !== 0) return;
    if (!game.user?.isGM || !canvas?.ready) return;
    if (ev.target !== canvas.app?.view) return; // clic hors du plateau (UI, barres…)

    const tokens = canvas.tokens?.controlled ?? [];
    if (!tokens.length) {
      notify.warn(t("ATS.teleport.noToken"));
      return;
    }

    // On prend la main : pas de sélection au lasso, pas de désélection.
    ev.preventDefault();
    ev.stopImmediatePropagation();
    this.teleport(tokens, ev);
  }

  /**
   * Téléporte les tokens en préservant leur formation autour du point cliqué.
   * @param {Token[]} tokens Tokens sélectionnés (le premier sert de référence).
   * @param {PointerEvent} ev Événement de clic (coordonnées écran).
   */
  static async teleport(tokens, ev) {
    try {
      // Coordonnées SCÈNE du clic : l'inverse de la transformée du stage mappe l'écran
      // vers l'espace de la scène (pan / zoom pris en compte).
      const world = canvas.stage.worldTransform.applyInverse({ x: ev.clientX, y: ev.clientY });

      // La case sous le curseur devient la case d'origine (coin haut-gauche) du token de
      // référence ; le reste du groupe suit par le même vecteur.
      const anchor = tokens[0];
      const cell = canvas.grid.getTopLeftPoint({ x: world.x, y: world.y });
      const dx = cell.x - anchor.document.x;
      const dy = cell.y - anchor.document.y;

      const updates = tokens.map((tk) => ({
        _id: tk.id,
        x: tk.document.x + dx,
        y: tk.document.y + dy,
      }));

      await canvas.scene.updateEmbeddedDocuments("Token", updates, { animate: false, teleport: true });
    } catch (err) {
      notify.warn(t("ATS.teleport.fail"));
      console.error(err);
    }
  }
}
