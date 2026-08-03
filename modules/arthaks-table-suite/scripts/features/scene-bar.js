/**
 * Scene Bar — Module Foundry VTT v14 · Système dnd5e 5.x
 *
 * Reproduit la NAVIGATION DE SCÈNE native de Foundry (la barre d'onglets de scènes en haut,
 * `#navigation`) dans une barre flottante de la suite, afin qu'elle bénéficie du même docking
 * (bord + ancre), du drag, du repli, du mode table et de la persistance par utilisateur que les
 * autres barres. Deuxième barre à remplacer un élément d'interface natif, après la barre de
 * contrôles (cf. ControlBar).
 *
 * La barre ne DUPLIQUE PAS la logique de Foundry : chaque onglet délègue au document Scene via
 * l'API stable :
 *   - clic gauche  → `scene.view()`     (affiche la scène sur cet écran) ;
 *   - clic droit   → `scene.activate()` (MJ : active la scène pour toute la table).
 * Comme l'action passe par l'API (et non par un clic DOM), la barre reste pleinement fonctionnelle
 * même quand la navigation native est masquée. Elle la remplace donc entièrement :
 * `replacesNativeSelector` déclare la barre native, que HideHud masque automatiquement sur tout
 * client où cette barre tourne (cf. HideHud.applyNativeReplacements).
 *
 * Resynchronisation : le hook `renderSceneNavigation` (émis par le natif à tout changement de
 * scène : création / suppression / activation / renommage), plus `canvasReady` (mise à jour du
 * surlignage de la scène VUE par ce client). Les deux appellent le rendu coalescé.
 *
 * Interaction de la barre :
 *  - Clic gauche sur un onglet → affiche la scène ; clic droit → l'active (MJ).
 *  - Bouton ↻            → oriente la barre (horizontale / verticale).
 *  - Bouton ⟨ / ⟩        → minimise / ré-étend la barre.
 *  - Poignée (⋮⋮)        → glisser pour déplacer ; clic droit → réglages.
 */

import { MODULE_ID } from "../const.js";
import { makeNotify, t } from "../lib/common.js";
import { FloatingBar } from "../lib/floating-bar.js";

const notify = makeNotify("Scènes");

// ═══════════════════════════════════════════════════════════════════════════════
// BARRE
// ═══════════════════════════════════════════════════════════════════════════════
export class SceneBar extends FloatingBar {
  static instance = null;

  /**
   * Sélecteur de l'élément d'interface NATIF que cette barre remplace (la navigation de scène).
   * Tant qu'une instance de la barre tourne sur ce client, HideHud masque ce natif automatiquement
   * (pas besoin de le cocher dans la matrice). Cf. HideHud.applyNativeReplacements.
   */
  static replacesNativeSelector = "#navigation, #scene-navigation";

  /** Instancie et affiche la barre (idempotent). Démarrée par la matrice de masquage. */
  static start() {
    if (this.instance) return;
    this.instance = new this();
    this.instance.init();
  }

  constructor() {
    super("scene");
    // Rendu coalescé : plusieurs hooks peuvent se déclencher coup sur coup pour un même
    // changement (renderSceneNavigation + canvasReady) — on n'en fait qu'un rendu.
    this.scheduleRender = foundry.utils.debounce(() => this.render(), 20);
  }

  get bar() { return this.el; }
  set bar(v) { this.el = v; }

  // ── Cycle de vie ───────────────────────────────────────────────────────────
  /** Crée le conteneur, branche les hooks (une fois), puis premier rendu. */
  init() {
    document.querySelectorAll("body > #scene-nav-bar").forEach(el => el.remove());

    const bar = document.createElement("div");
    bar.id = "scene-nav-bar";
    this.bar = bar;
    document.body.appendChild(bar);

    this.registerHooks();
    this.attachViewportHandlers();
    this.render();
    notify.info(t("ATS.scene.ready"));
  }

  /**
   * `renderSceneNavigation` couvre l'essentiel (création / suppression / activation / renommage
   * de scène : le natif re-rend sa navigation, même masquée par CSS) ; `canvasReady` rafraîchit le
   * surlignage de la scène VUE par ce client. Les deux passent par le rendu coalescé.
   */
  registerHooks() {
    this.hookIds.renderSceneNavigation = Hooks.on("renderSceneNavigation", () => this.scheduleRender());
    this.hookIds.canvasReady = Hooks.on("canvasReady", () => this.scheduleRender());
  }

  // ── Construction du contenu (rebâti à chaque changement) ─────────────────────
  /** Reconstruit intégralement le DOM de la barre à partir de la liste des scènes navigables. */
  render() {
    if (this._destroyed || !this.bar) return;
    this.bar.replaceChildren();

    // En-tête commun (poignée · ↻ · pastille · titre · repli).
    this.bar.appendChild(this.makeHeader("sn", { icon: "fa-compass", title: t("ATS.scene.label") }));

    for (const scene of this.navScenes()) {
      this.bar.appendChild(this.makeSceneButton(scene));
    }

    this.applyButtonSize();
    // État replié mémorisé posé AVANT applyDock (la disposition tient compte de la taille repliée).
    this.applyCollapsedState();
    this.applyDock();
  }

  /**
   * Scènes à présenter, dans l'ordre de navigation : celles marquées « dans la navigation »
   * (plus la scène active et celle actuellement vue, toujours incluses), filtrées par permission
   * (le MJ voit tout ; un joueur voit celles qu'il peut au moins observer). Trie par `navOrder`.
   * @returns {Scene[]}
   */
  navScenes() {
    const list = (game.scenes ?? []).filter((s) =>
      (s.navigation || s.active || s.isView) &&
      (game.user.isGM || s.testUserPermission(game.user, "OBSERVER")),
    );
    return list.sort((a, b) => (a.navOrder ?? a.sort ?? 0) - (b.navOrder ?? b.sort ?? 0));
  }

  /**
   * Fabrique un onglet de scène (repliable) : libellé texte (alias de navigation si défini, sinon
   * nom), surligné selon l'état — VUE par ce client (`sn-active`) et/ou ACTIVE globalement (`sn-current`).
   * @param {Scene} scene
   * @returns {HTMLElement}
   */
  makeSceneButton(scene) {
    const name = scene.navName?.trim() || scene.name;
    const btn = document.createElement("div");
    btn.className = "sn-btn sn-collapsible";
    if (scene.isView) btn.classList.add("sn-active");
    if (scene.active) btn.classList.add("sn-current");
    btn.dataset.tooltip = name;

    const label = document.createElement("span");
    label.className = "sn-label";
    label.textContent = name;
    btn.appendChild(label);

    btn.addEventListener("click", (ev) => { ev.preventDefault(); this.viewScene(scene); });
    btn.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); this.activateScene(scene); });
    return btn;
  }

  // ── Pilotage via l'API Scene ────────────────────────────────────────────────
  /** Affiche la scène sur CET écran (comme un clic sur l'onglet natif). */
  async viewScene(scene) {
    try {
      await scene.view();
    } catch (err) {
      notify.warn(t("ATS.scene.viewFail"));
      console.error(err);
    }
  }

  /** Active la scène pour toute la table (MJ uniquement ; clic droit sur l'onglet). */
  async activateScene(scene) {
    if (!game.user.isGM) return;
    try {
      await scene.activate();
    } catch (err) {
      notify.warn(t("ATS.scene.activateFail"));
      console.error(err);
    }
  }

  // ── Taille des onglets ──────────────────────────────────────────────────────
  applyButtonSize() {
    const size = Number(game.settings.get(MODULE_ID, "sceneButtonSize")) || 28;
    this.bar?.style.setProperty("--sn-size", `${size}px`);
  }

  // ── Ancrage / orientation ───────────────────────────────────────────────────
  // Le natif est une barre horizontale en haut : on reprend ce défaut.
  get dockSettingKey() { return "sceneDock"; }
  get orientSettingKey() { return "sceneOrientation"; }
  get defaultEdge() { return "top"; }
  get defaultOrientation() { return "h"; }

  // ── Minimiser ───────────────────────────────────────────────────────────────
  get collapsedClass() { return "sn-collapsed"; }

  /**
   * Plafonne la barre à l'espace utile selon son orientation (beaucoup de scènes possibles) :
   * au-delà, le contenu défile au lieu d'allonger la barre hors écran. Calqué sur ControlBar.
   */
  constrainSize() {
    if (!this.bar || this.bar.style.display === "none") return;
    const vertical = this.getOrientation() === "v";
    if (vertical) {
      this.bar.style.maxWidth = "";
      this.bar.style.maxHeight = `${window.innerHeight - 8}px`;
    } else {
      this.bar.style.maxHeight = "";
      this.bar.style.maxWidth = `${Math.max(120, this.usableRight() - 8)}px`;
    }
  }

  // destroy() : hérité de FloatingBar (Hooks.off + resize + remove + instance = null).
}
