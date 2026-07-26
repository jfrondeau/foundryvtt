/**
 * Hide HUD — masquage de l'interface des JOUEURS pour l'écran partagé de la table :
 * ne conserve que le canvas (et cette table de jeu), avec en option le journal de
 * chat. Réservé au MJ, qui garde son interface complète.
 *
 * Deux classes repère sont posées sur <body>, exploitées par la feuille de style :
 *  - ahh-hide-hud  : masque toute l'interface (canvas conservé) ;
 *  - ahh-show-chat : exception « Chat » — garde .chat-scroll dans la sidebar tout
 *                    en masquant la saisie (.chat-form). NB : chat-scroll /
 *                    chat-form sont des CLASSES (pas des id) en Foundry v14.
 */

import { MODULE_ID } from "../const.js";

// Réglages (hidePlayerHud, showChat) : centralisés dans settings.js.
// Contrairement aux barres, cette fonctionnalité n'a pas de toggle d'activation
// dédié : le réglage « hidePlayerHud » EST son interrupteur (désactivé = inactif).
export class HideHud {
  /**
   * Applique le masquage selon les réglages monde (joueurs seulement). Un
   * changement de réglage monde déclenche ce onChange sur tous les clients
   * connectés → chaque joueur réagit.
   */
  static apply() {
    const active   = !!game.settings.get(MODULE_ID, "hidePlayerHud") && !game.user.isGM;
    const showChat = !!game.settings.get(MODULE_ID, "showChat");
    document.body.classList.toggle("ahh-hide-hud", active);
    document.body.classList.toggle("ahh-show-chat", active && showChat);

    // Best-effort : garder l'onglet Chat actif pour que #chat-scroll reste affiché.
    if (active && showChat) {
      try { ui.sidebar?.changeTab?.("chat", "primary"); } catch (_) { /* API variable selon version */ }
    }
  }
}
