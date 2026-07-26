/**
 * Hide HUD — deux masquages distincts, à granularités différentes :
 *
 *  1. Vue JOUEUR (tout-ou-rien, scope monde) : réglage « hidePlayerHud ». Ne
 *     conserve que le canvas (et cette table de jeu), avec en option le journal de
 *     chat. Réservé au MJ qui le déclenche ; le MJ garde son interface complète.
 *     Implémenté par deux classes repère sur <body> exploitées par la feuille de
 *     style :
 *       - ahh-hide-hud  : masque toute l'interface (canvas conservé) ;
 *       - ahh-show-chat : exception « Chat » — garde .chat-scroll dans la sidebar
 *                         tout en masquant la saisie (.chat-form). NB : chat-scroll
 *                         / chat-form sont des CLASSES (pas des id) en Foundry v14.
 *
 *  2. Vue MJ (granulaire, scope client) : le MJ coche individuellement les éléments
 *     à retirer de SON écran (barre de macros, panneau joueurs, saisie du chat,
 *     onglets de sidebar un à un…). Le choix est stocké dans le réglage « gmHidden »
 *     et appliqué en injectant dynamiquement une feuille de style « #ahh-gm-hide » :
 *     aucun CSS figé à maintenir, ajouter une cible = une ligne dans GM_HIDEABLE.
 */

import { MODULE_ID } from "../const.js";

/**
 * Onglets de la sidebar proposés au masquage MJ, un par entrée. Chat et Paramètres
 * sont volontairement absents : indispensables (lecture des messages à la table,
 * accès à la configuration — éviter de se verrouiller dehors).
 * @type {{ tab: string, label: string }[]}
 */
const SIDEBAR_TABS = [
  { tab: "combat",       label: "Combats" },
  { tab: "scenes",       label: "Scènes" },
  { tab: "placeables",   label: "Éléments placés" },
  { tab: "actors",       label: "Acteurs" },
  { tab: "items",        label: "Objets" },
  { tab: "journal",      label: "Journal" },
  { tab: "tables",       label: "Tables aléatoires" },
  { tab: "cards",        label: "Cartes" },
  { tab: "macros",       label: "Macros" },
  { tab: "playlists",    label: "Playlists" },
  { tab: "compendium",   label: "Compendiums" },
  { tab: "dice-so-nice", label: "Dice So Nice" },
];

/**
 * Registre déclaratif des éléments masquables sur la vue MJ, groupés pour le
 * panneau de configuration. Chaque item : `{ key, label, selector }`. `selector`
 * peut lister plusieurs cibles séparées par des virgules (liste de sélecteurs CSS).
 * @type {{ group: string, items: { key: string, label: string, selector: string }[] }[]}
 */
export const GM_HIDEABLE = [
  {
    group: "Interface",
    items: [
      { key: "hotbar",    label: "Barre de macros",          selector: "#hotbar" },
      { key: "players",   label: "Panneau joueurs",          selector: "#players, #players-active" },
      { key: "chatInput", label: "Saisie du chat",           selector: ".chat-form, #chat-message, #chat-controls" },
      { key: "chatMenu",  label: "Menu d'édition du chat",   selector: ".editor-menu" },
    ],
  },
  {
    group: "Onglets de la sidebar",
    items: SIDEBAR_TABS.map(({ tab, label }) => ({
      key: `tab-${tab}`,
      label,
      selector: `#sidebar-tabs menu > li:has(button[data-tab="${tab}"])`,
    })),
  },
];

export class HideHud {
  /**
   * Applique les deux masquages (joueur + MJ). Un changement de réglage monde
   * (hidePlayerHud/showChat) déclenche ce onChange sur tous les clients connectés ;
   * un changement de « gmHidden » (scope client) ne concerne que le MJ local.
   */
  static apply() {
    HideHud.applyPlayerHud();
    HideHud.applyGmHide();
  }

  /** Masquage tout-ou-rien de l'interface, pour les JOUEURS uniquement. */
  static applyPlayerHud() {
    const active   = !!game.settings.get(MODULE_ID, "hidePlayerHud") && !game.user.isGM;
    const showChat = !!game.settings.get(MODULE_ID, "showChat");
    document.body.classList.toggle("ahh-hide-hud", active);
    document.body.classList.toggle("ahh-show-chat", active && showChat);

    // Best-effort : garder l'onglet Chat actif pour que #chat-scroll reste affiché.
    if (active && showChat) {
      try { ui.sidebar?.changeTab?.("chat", "primary"); } catch (_) { /* API variable selon version */ }
    }
  }

  /**
   * Masquage granulaire de la vue MJ : injecte (ou vide) la feuille de style
   * « #ahh-gm-hide » à partir des éléments cochés dans le réglage « gmHidden ».
   * Ne s'applique qu'au MJ ; côté joueur la feuille reste vide.
   */
  static applyGmHide() {
    let style = document.getElementById("ahh-gm-hide");
    if (!style) {
      style = document.createElement("style");
      style.id = "ahh-gm-hide";
      document.head.appendChild(style);
    }

    if (!game.user.isGM) { style.textContent = ""; return; }

    const hidden    = game.settings.get(MODULE_ID, "gmHidden") ?? {};
    const selectors = GM_HIDEABLE
      .flatMap((g) => g.items)
      .filter((it) => hidden[it.key])
      .map((it) => it.selector);

    style.textContent = selectors.length ? `${selectors.join(",\n")} { display: none !important; }` : "";
  }

  /**
   * Bascule l'état masqué d'un élément MJ et persiste le réglage (l'onChange de
   * « gmHidden » ré-applique la feuille de style, d'où l'aperçu en direct).
   * @param {string} key - Clé de l'élément dans GM_HIDEABLE.
   * @param {boolean} on - true pour masquer, false pour réafficher.
   */
  static setGmHidden(key, on) {
    const cur = foundry.utils.deepClone(game.settings.get(MODULE_ID, "gmHidden") ?? {});
    if (on) cur[key] = true;
    else delete cur[key];
    return game.settings.set(MODULE_ID, "gmHidden", cur);
  }
}

/**
 * Panneau de configuration du masquage MJ : une case à cocher par élément
 * masquable (registre GM_HIDEABLE). Les changements sont persistés et appliqués en
 * direct (aperçu immédiat à la table). Rendu en DOM brut, sans template Handlebars,
 * pour rester cohérent avec le reste de la suite.
 */
export class GmHideConfig extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ahh-gm-hide-config",
    classes: ["ahh-gm-hide-config"],
    window: { title: "Masquage MJ · Éléments masqués", icon: "fa-solid fa-eye-slash" },
    position: { width: 420, height: "auto" },
  };

  /**
   * Construit le contenu de la fenêtre : les groupes du registre, chacun en
   * <fieldset>, avec une case à cocher par élément masquable.
   * @returns {HTMLElement} Le fragment racine à insérer dans la fenêtre.
   */
  async _renderHTML() {
    const hidden = game.settings.get(MODULE_ID, "gmHidden") ?? {};
    const root = document.createElement("div");
    root.className = "ahh-gm-hide-body";

    const hint = document.createElement("p");
    hint.className = "notes";
    hint.textContent = "Masque les éléments cochés sur VOTRE écran (MJ) uniquement. Appliqué en direct.";
    root.appendChild(hint);

    for (const group of GM_HIDEABLE) {
      const fs = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = group.group;
      fs.appendChild(legend);

      for (const item of group.items) {
        const row = document.createElement("label");
        row.className = "ahh-gm-hide-row";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!hidden[item.key];
        cb.addEventListener("change", () => HideHud.setGmHidden(item.key, cb.checked));

        const span = document.createElement("span");
        span.textContent = item.label;

        row.append(cb, span);
        fs.appendChild(row);
      }
      root.appendChild(fs);
    }
    return root;
  }

  /** Insère le contenu construit dans la zone de fenêtre. */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }
}
