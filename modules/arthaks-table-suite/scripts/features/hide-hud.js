/**
 * Masquage de l'interface — MATRICE par AUDIENCE.
 *
 * Le MJ configure, depuis son écran, ce qui est masqué pour trois audiences :
 *   • MJ            : son propre écran ;
 *   • TV            : l'écran de table partagé (un joueur désigné, réglage « tvUser ») ;
 *   • Autres joueurs: tous les autres clients connectés.
 *
 * Chaque audience possède sa colonne de cases « masquer », réparties en trois sections :
 *   1. Interface — éléments du HUD Foundry (navigation, contrôles, logo, hotbar…), masqués
 *      en injectant une feuille de style « #ahh-audience-hide » à partir de sélecteurs CSS ;
 *   2. Onglets   — onglets de la sidebar, un par entrée (même mécanisme) ;
 *   3. Barres    — barres flottantes de la suite (gabarits, combat, token), masquées en
 *      basculant `display:none` sur l'élément racine de l'instance (relayout des autres).
 *
 * Le stockage (réglage « hideMatrix », scope MONDE) est donc partagé : le MJ écrit, chaque
 * client résout SON audience (`currentAudienceKey`) et applique la colonne correspondante.
 * NB : chat-scroll / chat-form sont des CLASSES (pas des id) en Foundry v14.
 */

import { MODULE_ID } from "../const.js";
import { BARS } from "./registry.js";
import { FloatingBar } from "../lib/floating-bar.js";
import { t } from "../lib/common.js";

/**
 * Les trois audiences, dans l'ordre d'affichage des colonnes du panneau.
 * @type {{ key: string, label: string, icon: string }[]}
 */
export const AUDIENCES = [
  { key: "gm",     label: "ATS.hide.audience.gm",     icon: "fa-solid fa-dungeon" },
  { key: "tv",     label: "ATS.hide.audience.tv",     icon: "fa-solid fa-tv" },
  { key: "others", label: "ATS.hide.audience.others", icon: "fa-solid fa-users" },
];

/**
 * Onglets de la sidebar proposés au masquage, un par entrée. Chat et Paramètres sont
 * volontairement absents : indispensables (lecture des messages à la table, accès à la
 * configuration — éviter de se verrouiller dehors).
 * @type {{ tab: string, label: string }[]}
 */
const SIDEBAR_TABS = [
  { tab: "combat",       label: "ATS.hide.tab.combat" },
  { tab: "scenes",       label: "ATS.hide.tab.scenes" },
  { tab: "placeables",   label: "ATS.hide.tab.placeables" },
  { tab: "actors",       label: "ATS.hide.tab.actors" },
  { tab: "items",        label: "ATS.hide.tab.items" },
  { tab: "journal",      label: "ATS.hide.tab.journal" },
  { tab: "tables",       label: "ATS.hide.tab.tables" },
  { tab: "cards",        label: "ATS.hide.tab.cards" },
  { tab: "macros",       label: "ATS.hide.tab.macros" },
  { tab: "playlists",    label: "ATS.hide.tab.playlists" },
  { tab: "compendium",   label: "ATS.hide.tab.compendium" },
  { tab: "dice-so-nice", label: "ATS.hide.tab.dice-so-nice" },
];

/**
 * Registre déclaratif des éléments masquables, groupés pour le panneau de configuration.
 * Chaque item porte une `key` stable et SOIT un `selector` CSS (Interface / Onglets, masqués
 * par feuille de style), SOIT un `bar` (barKey d'une barre de la suite, masquée par display).
 * @type {{ group: string, items: { key: string, label: string, selector?: string, bar?: string }[] }[]}
 */
export const HIDEABLE = [
  {
    group: "ATS.hide.group.interface",
    items: [
      { key: "sidebar",       label: "ATS.hide.item.sidebar",       selector: "#ui-right, #sidebar" },
      { key: "navigation",    label: "ATS.hide.item.navigation",    selector: "#navigation" },
      { key: "sceneControls", label: "ATS.hide.item.sceneControls", selector: "#controls, #scene-controls" },
      { key: "logo",          label: "ATS.hide.item.logo",          selector: "#logo" },
      { key: "players",       label: "ATS.hide.item.players",       selector: "#players, #players-active" },
      { key: "hotbar",        label: "ATS.hide.item.hotbar",        selector: "#hotbar" },
      { key: "chatInput",     label: "ATS.hide.item.chatInput",     selector: ".chat-form, #chat-message, #chat-controls" },
      { key: "chatMenu",      label: "ATS.hide.item.chatMenu",      selector: "#chat-message > .menu-container" },
    ],
  },
  {
    group: "ATS.hide.group.tabs",
    items: SIDEBAR_TABS.map(({ tab, label }) => ({
      key: `tab-${tab}`,
      label,
      selector: `#sidebar-tabs menu > li:has(button[data-tab="${tab}"])`,
    })),
  },
  {
    group: "ATS.hide.group.bars",
    items: BARS.map((b) => ({ key: `bar-${b.barKey}`, label: b.label, bar: b.barKey })),
  },
];

/**
 * Clés d'onglets, pour composer les valeurs par défaut sans se répéter.
 * @type {string[]}
 */
const TAB_KEYS = SIDEBAR_TABS.map((t) => `tab-${t.tab}`);

/**
 * Valeurs par défaut de la matrice (rétablies par le bouton « Rétablir les défauts ») :
 *   • MJ      — rien de masqué (écran de travail complet) ;
 *   • TV      — écran de table épuré : tout le HUD sauf la sidebar (le chat reste lisible),
 *               tous les onglets masqués, barres conservées ;
 *   • Autres  — rien de masqué (appareils personnels des joueurs, interface normale).
 * @type {{ gm: object, tv: object, others: object }}
 */
export const HIDE_DEFAULTS = {
  gm: {},
  tv: Object.fromEntries(
    ["navigation", "sceneControls", "logo", "players", "hotbar", "chatInput", "chatMenu", ...TAB_KEYS]
      .map((k) => [k, true]),
  ),
  others: {},
};

export class HideHud {
  /**
   * Audience de CE client : « gm » si MJ, sinon « tv » si c'est le joueur désigné écran de
   * table (réglage « tvUser »), sinon « others ».
   * @returns {string}
   */
  static currentAudienceKey() {
    if (game.user.isGM) return "gm";
    const tv = game.settings.get(MODULE_ID, "tvUser");
    return tv && game.user.id === tv ? "tv" : "others";
  }

  /** Matrice complète { gm, tv, others } (objet vide par défaut, jamais null). */
  static matrix() {
    const m = game.settings.get(MODULE_ID, "hideMatrix");
    return m && typeof m === "object" ? m : {};
  }

  /** Colonne (map { key: true }) d'une audience donnée. */
  static columnFor(audienceKey) {
    return this.matrix()[audienceKey] ?? {};
  }

  /** Applique le masquage complet (interface + onglets + barres) pour l'audience de ce client. */
  static apply() {
    this.applyStyle();
    this.reconcileBars();
  }

  /**
   * Masquage des éléments à sélecteur (Interface + Onglets) : (re)génère la feuille de style
   * « #ahh-audience-hide » à partir de la colonne de l'audience courante. Bascule aussi la
   * classe « ahh-chat-bare » (chat isolé rendu transparent quand la saisie est masquée).
   */
  static applyStyle() {
    let style = document.getElementById("ahh-audience-hide");
    if (!style) {
      style = document.createElement("style");
      style.id = "ahh-audience-hide";
      document.head.appendChild(style);
    }

    const col = this.columnFor(this.currentAudienceKey());
    const selectors = HIDEABLE
      .flatMap((g) => g.items)
      .filter((it) => it.selector && col[it.key])
      .map((it) => it.selector);

    style.textContent = selectors.length ? `${selectors.join(",\n")} { display: none !important; }` : "";
    document.body.classList.toggle("ahh-chat-bare", !!col.chatInput);
    // Menu d'édition masqué : #chat-message a une hauteur figée ; sans cette classe
    // (voir main.css) les pixels du menu iraient à la saisie, pas à la conversation.
    document.body.classList.toggle("ahh-chat-menu-hidden", !!col.chatMenu);
  }

  /**
   * (Dé)marre les BARRES selon l'audience de ce client : il n'y a plus de réglage « Activer »,
   * une barre tourne ici dès que la colonne de l'audience courante ne la masque pas. Démarre
   * les barres à afficher (si pas déjà vivantes), détruit celles masquées. Idempotent : appelé
   * au démarrage et à chaque changement de matrice / de joueur TV.
   */
  static reconcileBars() {
    for (const b of BARS) {
      const hidden = !!this.columnFor(this.currentAudienceKey())[`bar-${b.barKey}`];
      if (hidden) b.cls.instance?.destroy();
      else if (!b.cls.instance) b.cls.start();
    }
    FloatingBar.layoutAll();
  }

  /**
   * Bascule une cellule de la matrice et persiste (l'onChange de « hideMatrix » ré-applique
   * sur tous les clients, d'où l'aperçu en direct).
   * @param {string} audienceKey - « gm » | « tv » | « others ».
   * @param {string} key - Clé de l'élément dans HIDEABLE.
   * @param {boolean} on - true pour masquer, false pour réafficher.
   */
  static setCell(audienceKey, key, on) {
    const m = foundry.utils.deepClone(this.matrix());
    const col = (m[audienceKey] ??= {});
    if (on) col[key] = true;
    else delete col[key];
    return game.settings.set(MODULE_ID, "hideMatrix", m);
  }

  /**
   * Bascule TOUS les éléments d'une catégorie pour une audience (toggle « tout cocher /
   * décocher » de l'en-tête de section).
   * @param {string} audienceKey - « gm » | « tv » | « others ».
   * @param {{ key: string }[]} items - Éléments de la catégorie.
   * @param {boolean} on - true pour tout masquer, false pour tout réafficher.
   */
  static setGroup(audienceKey, items, on) {
    const m = foundry.utils.deepClone(this.matrix());
    const col = (m[audienceKey] ??= {});
    for (const it of items) {
      if (on) col[it.key] = true;
      else delete col[it.key];
    }
    return game.settings.set(MODULE_ID, "hideMatrix", m);
  }

  /** Rétablit la matrice à ses valeurs par défaut (HIDE_DEFAULTS). */
  static resetDefaults() {
    return game.settings.set(MODULE_ID, "hideMatrix", foundry.utils.deepClone(HIDE_DEFAULTS));
  }
}

/**
 * Panneau de configuration du masquage : sélecteur du joueur « TV » puis matrice
 * audience × élément (case = « masquer »), groupée en sections avec un toggle « tout
 * cocher / décocher » par catégorie et par colonne, et un bouton « Rétablir les défauts ».
 * Les changements sont persistés et appliqués en direct. Rendu en DOM brut, sans template
 * Handlebars, pour rester cohérent avec le reste de la suite.
 */
export class HideConfig extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ahh-hide-config",
    classes: ["ahh-hide-config"],
    window: { title: "ATS.menu.hide.name", icon: "fa-solid fa-eye-slash" },
    position: { width: 620, height: "auto" },
  };

  /** Petite fabrique de cellule de grille (div à classe, texte optionnel). */
  _cell(cls, text) {
    const d = document.createElement("div");
    d.className = cls;
    if (text) d.textContent = text;
    return d;
  }

  /**
   * Construit le contenu : bandeau d'aide, sélecteur du joueur TV, grille de la matrice
   * (en-tête d'audiences, puis par section un en-tête à toggles et une ligne par élément),
   * et pied avec le bouton de réinitialisation.
   * @returns {HTMLElement} Le fragment racine à insérer dans la fenêtre.
   */
  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "ahh-hide-body";

    const hint = document.createElement("p");
    hint.className = "notes";
    hint.textContent = t("ATS.hide.hint");
    root.appendChild(hint);

    root.appendChild(this._buildTvSelector());
    root.appendChild(this._buildMirrorToggle());

    const grid = document.createElement("div");
    grid.className = "ahh-hide-grid";
    root.appendChild(grid);

    // En-tête : cellule vide (colonne des libellés) + une par audience.
    grid.appendChild(this._cell("ahh-hide-corner"));
    for (const a of AUDIENCES) {
      const h = this._cell("ahh-hide-head");
      h.innerHTML = `<i class="${a.icon}"></i><span>${t(a.label)}</span>`;
      grid.appendChild(h);
    }

    for (const group of HIDEABLE) {
      // Ligne d'en-tête de section : nom + un toggle « tout » par audience.
      grid.appendChild(this._cell("ahh-hide-legend", t(group.group)));
      for (const a of AUDIENCES) grid.appendChild(this._buildGroupToggle(a, group));

      // Une ligne par élément masquable.
      for (const item of group.items) {
        grid.appendChild(this._cell("ahh-hide-label", t(item.label)));
        for (const a of AUDIENCES) grid.appendChild(this._buildCellToggle(a, item));
      }
    }

    const footer = document.createElement("div");
    footer.className = "ahh-hide-footer";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${t("ATS.hide.reset")}`;
    reset.addEventListener("click", async () => { await HideHud.resetDefaults(); this.render(); });
    footer.appendChild(reset);
    root.appendChild(footer);

    return root;
  }

  /** Ligne « Joueur TV » : liste déroulante des utilisateurs non-MJ (+ « Aucun »). */
  _buildTvSelector() {
    const row = document.createElement("div");
    row.className = "ahh-hide-tv";

    const label = document.createElement("label");
    label.htmlFor = "ahh-tv-user";
    label.innerHTML = `<i class="fa-solid fa-tv"></i> ${t("ATS.hide.tvLabel")}`;

    const select = document.createElement("select");
    select.id = "ahh-tv-user";
    const current = game.settings.get(MODULE_ID, "tvUser") ?? "";

    const none = document.createElement("option");
    none.value = "";
    none.textContent = t("ATS.hide.none");
    none.selected = current === "";
    select.appendChild(none);

    for (const u of game.users.filter((u) => !u.isGM)) {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.name;
      opt.selected = u.id === current;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => game.settings.set(MODULE_ID, "tvUser", select.value));

    row.append(label, select);
    return row;
  }

  /**
   * Ligne « Mode table (miroir 180°) » : copie retournée des barres au coin opposé, pour les
   * joueurs assis en face. Ne s'applique QU'À l'écran de table (joueur TV désigné ci-dessus).
   */
  _buildMirrorToggle() {
    const row = document.createElement("label");
    row.className = "ahh-hide-mirror";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = game.settings.get(MODULE_ID, "tableMode") === true;
    cb.addEventListener("change", () => game.settings.set(MODULE_ID, "tableMode", cb.checked));

    const span = document.createElement("span");
    span.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> ${t("ATS.hide.mirror")}`;

    row.append(cb, span);
    return row;
  }

  /**
   * Toggle « tout cocher / décocher » d'une catégorie pour une audience. Coché si tous les
   * éléments le sont, indéterminé si seulement certains.
   */
  _buildGroupToggle(audience, group) {
    const c = this._cell("ahh-hide-legend-toggle");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.title = t("ATS.hide.groupToggle");

    const col = HideHud.columnFor(audience.key);
    const checked = group.items.filter((it) => col[it.key]).length;
    cb.checked = checked === group.items.length;
    cb.indeterminate = checked > 0 && checked < group.items.length;

    cb.addEventListener("change", async () => {
      await HideHud.setGroup(audience.key, group.items, cb.checked);
      this.render(); // resynchronise cases et états indéterminés.
    });
    c.appendChild(cb);
    return c;
  }

  /** Case d'une cellule (audience × élément). */
  _buildCellToggle(audience, item) {
    const c = this._cell("ahh-hide-check");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!HideHud.columnFor(audience.key)[item.key];
    cb.addEventListener("change", async () => {
      await HideHud.setCell(audience.key, item.key, cb.checked);
      this.render(); // resynchronise les toggles « tout cocher » (états coché / indéterminé).
    });
    c.appendChild(cb);
    return c;
  }

  /** Insère le contenu construit dans la zone de fenêtre. */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }
}
