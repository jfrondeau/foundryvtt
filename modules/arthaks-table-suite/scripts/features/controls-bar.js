/**
 * Scene Controls Bar — Module Foundry VTT v14 · Système dnd5e 5.x
 *
 * Reproduit les CONTRÔLES DE SCÈNE natifs de Foundry (la colonne de gauche : Token,
 * Murs, Éclairage, Tuiles, Dessins, Sons, Regions, Notes… + les outils du contrôle
 * actif) dans une barre flottante de la suite, afin qu'ils bénéficient du même docking
 * (bord + ancre), du drag, du repli, du mode table et de la persistance par utilisateur
 * que les autres barres.
 *
 * La barre ne DUPLIQUE PAS la logique de Foundry : chaque bouton délègue au moteur natif
 * via l'API `ui.controls` (comme SpellTemplateBar le fait déjà pour le mode gabarit) :
 *   - clic sur un contrôle → `ui.controls.activate({ control })` ;
 *   - clic sur un outil     → `ui.controls.activate({ tool })`, ou `activate({ toggles })`
 *                             pour les bascules, ou `tool.onChange` pour les boutons d'action
 *                             (exactement la logique du natif `SceneControls#onChangeTool`).
 * La barre se resynchronise sur DEUX hooks : `renderSceneControls` (re-rendus complets) et
 * `activateSceneControls` (émis par tout `ui.controls.activate`, seul à couvrir les bascules de
 * toggle — que `renderSceneControls` ne déclenche pas, le natif ne touchant alors qu'`aria-pressed`).
 *
 * Comme l'activation passe par l'API (et non par un clic DOM), la barre reste pleinement
 * fonctionnelle même quand la colonne native est masquée (matrice de masquage, entrée
 * « sceneControls »). Elle la remplace donc entièrement.
 *
 * Interaction de la barre :
 *  - Clic gauche sur un contrôle → bascule le contrôle actif de la scène.
 *  - Clic gauche sur un outil    → sélectionne l'outil / bascule le toggle / déclenche l'action.
 *  - Bouton ↻            → oriente la barre (horizontale / verticale).
 *  - Bouton ⟨ / ⟩        → minimise / ré-étend la barre.
 *  - Poignée (⋮⋮)        → glisser pour déplacer ; clic droit → réglages.
 */

import { MODULE_ID } from "../const.js";
import { makeNotify, t } from "../lib/common.js";
import { FloatingBar } from "../lib/floating-bar.js";

const notify = makeNotify("Contrôles");

// ═══════════════════════════════════════════════════════════════════════════════
// BARRE
// ═══════════════════════════════════════════════════════════════════════════════
export class SceneControlsBar extends FloatingBar {
  static instance = null;

  /** Instancie et affiche la barre (idempotent). Démarrée par la matrice de masquage. */
  static start() {
    if (this.instance) return;
    this.instance = new this();
    this.instance.init();
  }

  constructor() {
    super("controls");
    // Rendu coalescé : `renderSceneControls` et `activateSceneControls` peuvent se déclencher
    // coup sur coup pour un même changement — on n'en fait qu'un rendu.
    this.scheduleRender = foundry.utils.debounce(() => this.render(), 20);
  }

  get bar() { return this.el; }
  set bar(v) { this.el = v; }

  // ── Cycle de vie ───────────────────────────────────────────────────────────
  /** Crée le conteneur, branche les hooks (une fois), puis premier rendu. */
  init() {
    document.querySelectorAll("body > #scene-controls-bar").forEach(el => el.remove());

    const bar = document.createElement("div");
    bar.id = "scene-controls-bar";
    this.bar = bar;
    document.body.appendChild(bar);

    this.registerHooks();
    this.attachViewportHandlers();
    this.render();
    notify.info(t("ATS.controls.ready"));
  }

  /**
   * Deux hooks complémentaires, car aucun seul ne couvre tous les cas :
   *  - `renderSceneControls` : re-rendus complets du natif (changement de contrôle, `ui.controls.render()`
   *    déclenché par un réglage, autres modules…) ;
   *  - `activateSceneControls` : émis par `SceneControls#activate` sur TOUT changement, y compris une
   *    bascule de toggle — que `renderSceneControls` NE couvre PAS (le natif ne fait alors que mettre à
   *    jour `aria-pressed`, sans re-render). Indispensable pour refléter un toggle basculé côté natif.
   * Les deux appellent le rendu coalescé.
   */
  registerHooks() {
    this.hookIds.renderSceneControls = Hooks.on("renderSceneControls", () => this.scheduleRender());
    this.hookIds.activateSceneControls = Hooks.on("activateSceneControls", () => this.scheduleRender());
  }

  // ── Construction du contenu (rebâti à chaque changement d'état natif) ────────
  /** Reconstruit intégralement le DOM de la barre à partir de l'état de `ui.controls`. */
  render() {
    if (this._destroyed || !this.bar) return;
    this.bar.replaceChildren();

    // En-tête commun (poignée · ↻ · pastille · titre · repli).
    this.bar.appendChild(this.makeHeader("sc", { icon: "fa-sliders", title: t("ATS.controls.label") }));

    const controls = this.orderedVisible(ui.controls?.controls);
    const activeControl = ui.controls?.control;

    // Groupe 1 — les contrôles top-level (un bouton par contrôle visible).
    for (const control of controls) {
      const btn = this.makeButton({
        icon: control.icon,
        tooltip: control.title,            // déjà localisé par Foundry
        active: activeControl?.name === control.name,
        onClick: (ev) => this.activateControl(control, ev),
      });
      this.bar.appendChild(btn);
    }

    // Groupe 2 — les outils du contrôle actif.
    const tools = this.orderedVisible(activeControl?.tools);
    if (tools.length) {
      const sep = document.createElement("div");
      sep.className = "sc-sep sc-collapsible";
      this.bar.appendChild(sep);

      for (const tool of tools) {
        const btn = this.makeButton({
          icon: tool.icon,
          tooltip: tool.title,             // déjà localisé par Foundry
          active: this.isToolActive(tool),
          toggle: !!tool.toggle,
          onClick: (ev) => this.activateTool(activeControl, tool, ev),
        });
        this.bar.appendChild(btn);
      }
    }

    this.applyButtonSize();
    // État replié mémorisé posé AVANT applyDock (la disposition tient compte de la taille repliée).
    this.applyCollapsedState();
    this.applyDock();
  }

  /**
   * Liste triée (par `order`) et filtrée (visibles) des valeurs d'un dictionnaire de
   * contrôles ou d'outils de `ui.controls`. Tolère un dictionnaire absent.
   * @param {object|undefined} dict
   * @returns {object[]}
   */
  orderedVisible(dict) {
    return Object.values(dict ?? {})
      .filter(entry => entry && entry.visible !== false)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /**
   * État actif d'un outil, à l'identique du natif (`SceneControls`, l.255 / l.304) :
   *  - bouton d'action → jamais actif ;
   *  - bascule (toggle) → son état vivant `tool.active` (bordure + fond) ;
   *  - outil normal → l'outil réellement sélectionné (`ui.controls.tool`, PAS
   *    `control.activeTool` qui n'est que le défaut déclaré, jamais mis à jour).
   * @param {object} tool
   * @returns {boolean}
   */
  isToolActive(tool) {
    if (tool.button) return false;
    if (tool.toggle) return !!tool.active;
    return ui.controls?.tool?.name === tool.name;
  }

  /**
   * Fabrique un bouton d'action carré (repliable) avec icône + tooltip.
   * @param {{icon:string, tooltip:string, active:boolean, toggle?:boolean, onClick:(ev:Event) => void}} opts
   * @returns {HTMLElement}
   */
  makeButton({ icon, tooltip, active, toggle = false, onClick }) {
    const btn = document.createElement("div");
    btn.className = "sc-btn sc-collapsible";
    if (toggle) btn.classList.add("sc-toggle");
    if (active) btn.classList.add("sc-active");
    if (tooltip) btn.dataset.tooltip = tooltip;
    const i = document.createElement("i");
    i.className = (typeof icon === "string" && icon.trim()) ? icon : "fas fa-question";
    btn.appendChild(i);
    btn.addEventListener("click", (ev) => { ev.preventDefault(); onClick(ev); });
    return btn;
  }

  // ── Pilotage du moteur natif ────────────────────────────────────────────────
  // Le re-rendu de la barre après une action est assuré par le hook `activateSceneControls`
  // (émis par tout `ui.controls.activate`), sauf pour le cas BOUTON qui ne passe pas par
  // `activate()` : on y planifie alors le rendu explicitement.

  /** Active un contrôle top-level (bascule la colonne native). */
  async activateControl(control, ev) {
    try {
      await ui.controls.activate({ control: control.name, event: ev });
    } catch (err) {
      notify.warn(t("ATS.controls.activateFail"));
      console.error(err);
    }
  }

  /**
   * Actionne un outil selon son type, exactement comme le natif (`#onChangeTool`) :
   *  - bouton d'action (`tool.button`) : déclenche `onChange`, ne devient pas l'outil actif ;
   *  - bascule (`tool.toggle`) : `activate({ toggles: { [nom]: !actif } })` — met à jour l'état,
   *    déclenche `onChange` et bascule le visuel actif (bordure + fond) ;
   *  - outil normal : `activate({ tool })` — devient l'outil sélectionné.
   */
  async activateTool(control, tool, ev) {
    try {
      if (tool.button) {
        await tool.onChange?.(ev ?? new Event("change"), true);
        this.scheduleRender(); // le bouton ne passe pas par activate() → pas de hook.
      } else if (tool.toggle) {
        await ui.controls.activate({ control: control.name, toggles: { [tool.name]: !tool.active }, event: ev });
      } else {
        await ui.controls.activate({ control: control.name, tool: tool.name, event: ev });
      }
    } catch (err) {
      notify.warn(t("ATS.controls.activateFail"));
      console.error(err);
    }
  }

  // ── Taille des boutons ──────────────────────────────────────────────────────
  applyButtonSize() {
    const size = Number(game.settings.get(MODULE_ID, "controlsButtonSize")) || 40;
    this.bar?.style.setProperty("--sc-btn", `${size}px`);
  }

  // ── Ancrage / orientation ───────────────────────────────────────────────────
  // Le natif est une colonne verticale à gauche : on reprend ce défaut.
  get dockSettingKey() { return "controlsDock"; }
  get orientSettingKey() { return "controlsOrientation"; }
  get defaultEdge() { return "left"; }
  get defaultOrientation() { return "v"; }

  // ── Minimiser ───────────────────────────────────────────────────────────────
  get collapsedClass() { return "sc-collapsed"; }

  /**
   * Plafonne la barre à l'espace utile selon son orientation (beaucoup d'outils
   * possibles) : au-delà, le contenu défile au lieu d'allonger la barre hors écran.
   * Calqué sur TokenActionBar.constrainSize.
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
