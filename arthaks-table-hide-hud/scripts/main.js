/**
 * Arthak's Table Hide HUD — Module Foundry VTT v13/v14
 *
 * Masque l'interface des JOUEURS pour l'écran partagé de la table : ne conserve
 * que le canvas (et cette table de jeu), avec en option le journal de chat.
 * Réservé au MJ, qui garde son interface complète.
 *
 * Deux classes repère sont posées sur <body>, exploitées par la feuille de style :
 *  - ahh-hide-hud  : masque toute l'interface (canvas conservé) ;
 *  - ahh-show-chat : exception « Chat » — garde .chat-scroll dans la sidebar tout
 *                    en masquant la saisie (.chat-form). NB : chat-scroll /
 *                    chat-form sont des CLASSES (pas des id) en Foundry v14.
 *
 * (Extrait de « arthaks-table-template-bar » — le mode immersif y vivait avant.)
 */

const MODULE_ID = "arthaks-table-hide-hud";

Hooks.once("init", () => {
  // Toggle maître : masque l'interface des JOUEURS (le MJ garde la sienne).
  game.settings.register(MODULE_ID, "hidePlayerHud", {
    name: "Hide player HUD — masquer l'interface des joueurs",
    hint: "Réservé au MJ. Pour les JOUEURS uniquement : ne conserve que le canvas et les barres de la table. Le MJ garde son interface complète.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => HideHud.apply(),
  });

  // Seule exception configurable : conserver le chat (chat-scroll), sans sa saisie.
  game.settings.register(MODULE_ID, "showChat", {
    name: "Chat",
    hint: "Conserver le journal de chat (chat-scroll) visible pour les joueurs quand l'interface est masquée. Le champ de saisie (chat-form) reste masqué.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => HideHud.apply(),
  });
});

Hooks.once("ready", () => HideHud.apply());

class HideHud {
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
