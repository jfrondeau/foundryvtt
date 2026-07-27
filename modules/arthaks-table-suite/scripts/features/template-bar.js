/**
 * Spell Template Bar — Module Foundry VTT v14 · Système dnd5e 5.x
 *
 * Affiche automatiquement, pour TOUS les utilisateurs, une barre flottante
 * permettant de DESSINER des gabarits de sort via le « Template Mode » du
 * contrôle Regions de dnd5e — d'un seul clic, joueur compris.
 *
 * Chaque bouton de forme :
 *   1) ouvre le contrôle « Regions »,
 *   2) active le bascule « templateMode »,
 *   3) sélectionne la forme (cercle / cône / anneau / ligne / émanation / rect).
 *
 * Chaque gabarit dessiné est une Region renommée selon sa forme (« Cercle [Nom] »,
 * « Cône [Nom] », …) et marquée d'un flag d'appartenance (flags.<id>.owner).
 * La poubelle s'appuie sur ce flag (fiable, indépendant du nom) :
 *   - Joueur → supprime uniquement SES gabarits.
 *   - MJ     → supprime tous les gabarits de tous les joueurs.
 *
 * Interaction de la barre :
 *  - Clic gauche sur une forme → active le mode gabarit, puis dessiner sur la scène.
 *  - Clic sur 🗑        → supprime ses gabarits (tous, si MJ).
 *  - Bouton ⟨ / ⟩       → minimise / ré-étend la barre.
 *  - Poignée (⋮⋮)       → glisser pour déplacer la barre (position mémorisée).
 */

import { MODULE_ID } from "../const.js";
import { makeNotify } from "../lib/common.js";
import { FloatingBar } from "../lib/floating-bar.js";

const NS = MODULE_ID;                     // namespace des flags de Region (owner)
const notify = makeNotify("Gabarits");

// ── Formes disponibles (noms des outils du contrôle « regions » de dnd5e) ─────
const SHAPES = [
  { t: "circle",    icon: "fa-circle",           label: "Cercle" },
  { t: "cone",      icon: "fa-location-arrow",    label: "Cône" },
  { t: "ring",      icon: "fa-circle-notch",      label: "Anneau" },
  { t: "line",      icon: "fa-grip-lines",        label: "Ligne" },
  { t: "emanation", icon: "fa-arrows-to-circle",  label: "Émanation" },
  { t: "rectangle", icon: "fa-square",            label: "Rectangle" },
];

// ═══════════════════════════════════════════════════════════════════════════════
// BARRE
// ═══════════════════════════════════════════════════════════════════════════════
export class SpellTemplateBar extends FloatingBar {
  static instance = null;

  /** Instancie et affiche la barre (idempotent). Appelé selon le réglage d'activation. */
  static start() {
    if (this.instance) return;
    // Garde : le contrôle « regions » + « templateMode » doivent exister.
    if (!ui.controls.controls?.regions?.tools?.templateMode) {
      notify.warn("Le mode gabarit (Regions → templateMode) est introuvable. " +
                  "Cette fonctionnalité nécessite dnd5e 5.x sur Foundry v13+.");
    }
    this.instance = new this();
    this.instance.render();
  }

  constructor() {
    super("template");
    this.returnLayer = null;      // couche à restaurer après le dessin
    this.lastShape = null;        // dernière forme activée (sert au nommage)
    this.emanationTokenId = null; // token auquel attacher la prochaine émanation
  }

  get bar() { return this.el; }
  set bar(v) { this.el = v; }

  // ── Construction ─────────────────────────────────────────────────────────
  render() {
    document.querySelectorAll("body > #spell-template-bar").forEach(el => el.remove());

    const bar = document.createElement("div");
    bar.id = "spell-template-bar";
    this.bar = bar;
    document.body.appendChild(bar);

    // Poignée de déplacement + bouton ↻ (rotation, visible seulement quand ancrée).
    bar.appendChild(this.makeHandle("tb-handle"));
    bar.appendChild(this.makeRotateButton("tb-rotate"));

    // Libellé (repliable).
    const label = document.createElement("div");
    label.className = "tb-label tb-collapsible";
    label.textContent = "Gabarits";
    bar.appendChild(label);

    // Boutons de forme (repliables).
    for (const shape of SHAPES) {
      const btn = document.createElement("div");
      btn.className = "tb-btn tb-collapsible";
      btn.dataset.shape = shape.t;
      btn.dataset.tooltip = `${shape.label} — clic-glisser pour dimensionner`;
      const i = document.createElement("i");
      i.className = this.shapeIcon(shape);
      btn.appendChild(i);
      btn.addEventListener("click", (ev) => { ev.preventDefault(); this.activateTool(shape.t); });
      bar.appendChild(btn);
    }

    // Séparateur + poubelle (repliables).
    const sep = document.createElement("div");
    sep.className = "tb-sep tb-collapsible";
    bar.appendChild(sep);

    const trash = document.createElement("div");
    trash.className = "tb-btn tb-trash tb-collapsible";
    trash.dataset.tooltip = game.user.isGM
      ? "Supprimer tous les gabarits (MJ)"
      : "Supprimer mes gabarits";
    const trashIcon = document.createElement("i");
    trashIcon.className = "fas fa-trash";
    trash.appendChild(trashIcon);
    trash.addEventListener("click", (ev) => { ev.preventDefault(); this.clearMine(); });
    bar.appendChild(trash);

    // Toggle minimiser / ré-étendre (toujours visible).
    const toggle = document.createElement("div");
    toggle.className = "tb-toggle";
    toggle.dataset.tooltip = "Minimiser la barre";
    const toggleIcon = document.createElement("i");
    toggleIcon.className = "fas fa-chevron-left";
    toggle.appendChild(toggleIcon);
    toggle.addEventListener("click", () => this.toggleCollapsed());
    this.toggleIcon = toggle;
    bar.appendChild(toggle);

    this.applyButtonSize();
    this.applyDock();

    // État minimisé mémorisé.
    if (localStorage.getItem(this.collapsedKey) === "1") this.setCollapsed(true);

    this.attachViewportHandlers();
    this.registerHooks();
    this.refreshEmanationState();
    notify.info("Barre de gabarits prête.");
  }

  /** Icône du bouton : reprend celle de l'outil du contrôle « Regions » de dnd5e. */
  shapeIcon(shape) {
    const toolIcon = ui.controls.controls?.regions?.tools?.[shape.t]?.icon;
    return (typeof toolIcon === "string" && toolIcon.trim()) ? toolIcon : `fas ${shape.icon}`;
  }

  /** Re-synchronise les icônes des boutons sur celles du contrôle Regions. */
  refreshIcons() {
    for (const shape of SHAPES) {
      const i = this.bar?.querySelector(`.tb-btn[data-shape="${shape.t}"] > i`);
      if (i) i.className = this.shapeIcon(shape);
    }
  }

  /** Active/désactive le bouton Émanation : il exige exactement UN token sélectionné. */
  refreshEmanationState() {
    const btn = this.bar?.querySelector('.tb-btn[data-shape="emanation"]');
    if (!btn) return;
    const ready = canvas.tokens?.controlled?.length === 1;
    btn.classList.toggle("tb-disabled", !ready);
    btn.dataset.tooltip = ready
      ? "Émanation — attachée au token sélectionné"
      : "Émanation — sélectionner d'abord un token";
  }

  applyButtonSize() {
    const size = Number(game.settings.get(MODULE_ID, "templateButtonSize")) || 40;
    this.bar?.style.setProperty("--tb-btn", `${size}px`);
  }

  // Ancrage aux bords : hérité de FloatingBar. Bord par défaut « free » (position libre) ;
  // orientation explicite via le bouton ↻ (défaut horizontale).
  get dockSettingKey() { return "templateDock"; }
  get orientSettingKey() { return "templateOrientation"; }

  // ── Minimiser (skeleton dans FloatingBar) ──────────────────────────────────
  get collapsedClass() { return "stb-collapsed"; }

  updateCollapseIcon(on) {
    const icon = this.toggleIcon.querySelector("i");
    icon.className = on ? "fas fa-chevron-right" : "fas fa-chevron-left";
    this.toggleIcon.dataset.tooltip = on ? "Ré-étendre la barre" : "Minimiser la barre";
  }

  // ── Activation du mode gabarit ─────────────────────────────────────────────
  async activateTool(shape) {
    // L'émanation se dessine comme les autres formes ; la région créée sera
    // simplement attachée au token sélectionné (voir preCreateRegion). On mémorise
    // ce token dès le clic. Le bouton est désactivé sans sélection, mais on garde
    // cette garde par sécurité.
    this.emanationTokenId = null;
    if (shape === "emanation") {
      const controlled = canvas.tokens.controlled;
      if (controlled.length !== 1) {
        notify.warn("Sélectionner exactement UN token pour attacher l'émanation.");
        return;
      }
      this.emanationTokenId = controlled[0].id;
    }

    const regions = ui.controls.controls?.regions;
    if (!regions) { notify.warn("Contrôle « Regions » indisponible sur cette scène."); return; }

    const current = canvas.activeLayer;
    if (current && current !== canvas.regions) this.returnLayer = current;
    this.lastShape = shape;

    // 1) Ouvre le contrôle Regions.
    await ui.controls.activate({ control: "regions", tool: "select" });

    // 2) Active le bascule templateMode s'il ne l'est pas déjà.
    const tm = ui.controls.control?.tools?.templateMode;
    if (tm && !tm.active) {
      tm.active = true;
      try { await tm.onChange?.(null, true); } catch (e) { console.warn("[Spell Template Bar] templateMode onChange:", e); }
    }

    // 3) Sélectionne la forme voulue.
    await ui.controls.activate({ control: "regions", tool: shape });
    ui.controls.render();

    this.clearActiveButtons();
    this.bar.querySelector(`.tb-btn[data-shape="${shape}"]`)?.classList.add("tb-active");
  }

  /** Retire la surbrillance des boutons de forme (sans toucher à la couche). */
  clearActiveButtons() {
    this.bar?.querySelectorAll(".tb-btn.tb-active").forEach(b => b.classList.remove("tb-active"));
  }

  restoreLayer() {
    const target = this.returnLayer ?? canvas.tokens;
    this.returnLayer = null;
    target?.activate?.();
    this.clearActiveButtons();
  }

  // ── Suppression des gabarits ───────────────────────────────────────────────
  async clearMine() {
    const scene = canvas.scene;
    if (!scene) return;

    const myId  = game.user.id;
    const myTag = `[${game.user.name}]`;
    const flagOwner   = (r) => r.flags?.[NS]?.owner;                          // id de l'auteur
    const endsWithTag = (r) => /\[[^\]]+\]\s*$/.test(r.name ?? "");           // repli : nom balisé
    const isTemplate  = (r) => flagOwner(r) != null || endsWithTag(r);
    const isMine      = (r) => flagOwner(r) === myId || (r.name ?? "").includes(myTag);

    const ids = scene.regions
      .filter(r => game.user.isGM ? isTemplate(r) : isMine(r))
      .map(r => r.id);

    if (!ids.length) {
      ui.notifications.info("Aucun gabarit à supprimer.");
      return;
    }
    try {
      await scene.deleteEmbeddedDocuments("Region", ids);
      ui.notifications.info(`${ids.length} gabarit(s) supprimé(s).`);
    } catch (err) {
      notify.warn("Suppression impossible.");
      console.error(err);
    }
  }

  // ── Hooks Region ───────────────────────────────────────────────────────────
  registerHooks() {
    // Après le dessin d'un gabarit : on NE restaure la couche QUE si c'est la
    // barre qui l'a changée (returnLayer posé via un bouton) ET pour un JOUEUR
    // (mode immersif). Le MJ n'est jamais sorti de sa couche, et un dessin manuel
    // (returnLayer absent) ne provoque aucune bascule. Différé pour ne pas casser
    // la propagation du placeable pendant _onCreate.
    this.hookIds.createRegion = Hooks.on("createRegion", (doc, options, userId) => {
      if (userId !== game.user.id) return;
      this.emanationTokenId = null;
      if (this.returnLayer && !game.user.isGM) {
        setTimeout(() => this.restoreLayer(), 50);
      } else {
        this.returnLayer = null;
        this.clearActiveButtons();
      }
    });

    // Le bouton Émanation suit la sélection de tokens (actif si exactement un).
    this.hookIds.controlToken = Hooks.on("controlToken", () => this.refreshEmanationState());

    // Filet de sécurité : re-synchronise les icônes dès que les outils Regions
    // sont disponibles (elles peuvent ne pas l'être au tout premier rendu).
    this.hookIds.renderSceneControls = Hooks.on("renderSceneControls", () => this.refreshIcons());

    // Baptême + marquage à la création : renomme « <Forme> [Nom] » et pose le flag.
    this.hookIds.preCreateRegion = Hooks.on("preCreateRegion", (doc, data, options, userId) => {
      if (userId !== game.user.id) return;
      if (!ui.controls.controls?.regions?.tools?.templateMode?.active) return;

      // En mode gabarit, l'outil actif reste « select » : on se fie à la forme
      // cliquée sur la barre, et on n'utilise activeTool que s'il désigne une forme.
      const activeTool = ui.controls.control?.activeTool;
      const toolName = SHAPES.some(s => s.t === activeTool) ? activeTool : this.lastShape;
      const label = SHAPES.find(s => s.t === toolName)?.label ?? "Gabarit";

      const update = {
        name: `${label} [${game.user.name}]`,
        flags: { [NS]: { owner: game.user.id, ownerName: game.user.name } },
      };

      // Émanation : on attache la région au token sélectionné pour qu'elle le
      // suive et tourne avec lui (identique à ce que produit createTokenEmanation).
      if (toolName === "emanation" && this.emanationTokenId) {
        update.attachment = { token: this.emanationTokenId };
      }

      doc.updateSource(update);
    });
  }

  // destroy() : hérité de FloatingBar (Hooks.off + resize + remove + instance = null).
}
