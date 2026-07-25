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
 *
 * Mode immersif : un réglage MONDE (modifiable par le MJ uniquement) masque le
 * reste de l'interface pour les joueurs, ne laissant que cette barre + le canvas.
 */

const MODULE_ID = "spell-template-bar";
const NS = MODULE_ID;

const notify = {
  info: (m) => console.log(`[Spell Template Bar] ${m}`),
  warn: (m) => { console.warn(`[Spell Template Bar] ${m}`); ui.notifications?.warn(m); },
};

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
// RÉGLAGES
// ═══════════════════════════════════════════════════════════════════════════════
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "buttonSize", {
    name: "Taille des boutons (px)",
    hint: "Taille des boutons de la barre de gabarits.",
    scope: "client",
    config: true,
    type: Number,
    default: 40,
    onChange: () => SpellTemplateBar.instance?.applyButtonSize(),
  });

  // Toggle maître : masque l'interface des JOUEURS (le MJ garde la sienne).
  game.settings.register(MODULE_ID, "hidePlayerHud", {
    name: "Hide player HUD — masquer l'interface des joueurs",
    hint: "Réservé au MJ. Pour les JOUEURS uniquement : ne conserve que le canvas et cette barre. Le MJ garde son interface complète.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => SpellTemplateBar.applyHidePlayerHud(),
  });

  // Seule exception configurable : conserver le chat (chat-scroll), sans sa saisie.
  game.settings.register(MODULE_ID, "showChat", {
    name: "Chat",
    hint: "Conserver le journal de chat (chat-scroll) visible pour les joueurs quand l'interface est masquée. Le champ de saisie (chat-form) reste masqué.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => SpellTemplateBar.applyHidePlayerHud(),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════
Hooks.once("ready", () => {
  // Garde : le contrôle « regions » + « templateMode » doivent exister.
  if (!ui.controls.controls?.regions?.tools?.templateMode) {
    notify.warn("Le mode gabarit (Regions → templateMode) est introuvable. " +
                "Ce module nécessite dnd5e 5.x sur Foundry v13+.");
  }
  SpellTemplateBar.instance = new SpellTemplateBar();
  SpellTemplateBar.instance.render();
  SpellTemplateBar.applyHidePlayerHud();
});

// ═══════════════════════════════════════════════════════════════════════════════
// BARRE
// ═══════════════════════════════════════════════════════════════════════════════
class SpellTemplateBar {
  static instance = null;

  /**
   * Masque l'interface des joueurs selon les réglages monde (joueurs seulement).
   * Pose deux classes repère sur <body>, exploitées par la feuille de style :
   *  - stb-hide-hud  : masque toute l'interface (canvas + barre conservés) ;
   *  - stb-show-chat : exception « Chat » — garde .chat-scroll dans la sidebar
   *                    tout en masquant .chat-form (classes, pas des id en v14).
   */
  static applyHidePlayerHud() {
    const active   = !!game.settings.get(MODULE_ID, "hidePlayerHud") && !game.user.isGM;
    const showChat = !!game.settings.get(MODULE_ID, "showChat");
    document.body.classList.toggle("stb-hide-hud", active);
    document.body.classList.toggle("stb-show-chat", active && showChat);

    // Best-effort : garder l'onglet Chat actif pour que #chat-scroll reste affiché.
    if (active && showChat) {
      try { ui.sidebar?.changeTab?.("chat", "primary"); } catch (_) { /* API variable selon version */ }
    }
  }

  constructor() {
    this.bar = null;
    this.returnLayer = null;      // couche à restaurer après le dessin
    this.lastShape = null;        // dernière forme activée (sert au nommage)
    this.emanationTokenId = null; // token auquel attacher la prochaine émanation
    this.hookIds = {};
    this.onResize = this.onResize.bind(this);
  }

  get posKey() { return `${NS}.pos.${game.user.id}`; }
  get collapsedKey() { return `${NS}.collapsed.${game.user.id}`; }

  // ── Construction ─────────────────────────────────────────────────────────
  render() {
    document.querySelectorAll("body > #spell-template-bar").forEach(el => el.remove());

    const bar = document.createElement("div");
    bar.id = "spell-template-bar";
    this.bar = bar;
    document.body.appendChild(bar);

    // Poignée de déplacement.
    const handle = document.createElement("i");
    handle.className = "fas fa-grip-vertical tb-handle";
    handle.dataset.tooltip = "Glisser pour déplacer la barre";
    this.initDrag(handle);
    bar.appendChild(handle);

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
    this.applyPosition();

    // État minimisé mémorisé.
    if (localStorage.getItem(this.collapsedKey) === "1") this.setCollapsed(true);

    window.addEventListener("resize", this.onResize);
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
    const size = Number(game.settings.get(MODULE_ID, "buttonSize")) || 40;
    this.bar?.style.setProperty("--tb-btn", `${size}px`);
  }

  // ── Minimiser ──────────────────────────────────────────────────────────────
  toggleCollapsed() {
    this.setCollapsed(!this.bar.classList.contains("stb-collapsed"));
  }

  setCollapsed(on) {
    this.bar.classList.toggle("stb-collapsed", on);
    const icon = this.toggleIcon.querySelector("i");
    icon.className = on ? "fas fa-chevron-right" : "fas fa-chevron-left";
    this.toggleIcon.dataset.tooltip = on ? "Ré-étendre la barre" : "Minimiser la barre";
    localStorage.setItem(this.collapsedKey, on ? "1" : "0");
    // Re-contraint la position (la largeur a changé).
    const r = this.bar.getBoundingClientRect();
    this.setPos(r.left, r.top);
  }

  // ── Position ─────────────────────────────────────────────────────────────
  clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  setPos(left, top) {
    const bw = this.bar.offsetWidth  || 200;
    const bh = this.bar.offsetHeight || 40;
    left = this.clamp(left, 4, window.innerWidth  - bw - 4);
    top  = this.clamp(top,  4, window.innerHeight - bh - 4);
    this.bar.style.left = `${Math.round(left)}px`;
    this.bar.style.top  = `${Math.round(top)}px`;
    this.bar.style.right = this.bar.style.bottom = "auto";
  }

  savePos() {
    const r = this.bar.getBoundingClientRect();
    localStorage.setItem(this.posKey, JSON.stringify({ left: r.left, top: r.top }));
  }

  readPos() {
    try { return JSON.parse(localStorage.getItem(this.posKey)); } catch { return null; }
  }

  applyPosition() {
    const saved = this.readPos();
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      return this.setPos(saved.left, saved.top);
    }
    const hb = document.getElementById("hotbar");
    const r  = hb?.getBoundingClientRect();
    const bw = this.bar.offsetWidth, bh = this.bar.offsetHeight;
    if (r && r.width) this.setPos(r.left + r.width / 2 - bw / 2, r.top - bh - 8);
    else this.setPos((window.innerWidth - bw) / 2, window.innerHeight - bh - 90);
  }

  onResize() {
    const r = this.bar.getBoundingClientRect();
    this.setPos(r.left, r.top);
  }

  initDrag(handle) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const r = this.bar.getBoundingClientRect();
      const offX = ev.clientX - r.left;
      const offY = ev.clientY - r.top;
      handle.setPointerCapture(ev.pointerId);
      const onMove = (e) => this.setPos(e.clientX - offX, e.clientY - offY);
      const onUp = () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this.savePos();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
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

    this.bar.querySelectorAll(".tb-btn.tb-active").forEach(b => b.classList.remove("tb-active"));
    this.bar.querySelector(`.tb-btn[data-shape="${shape}"]`)?.classList.add("tb-active");
  }

  restoreLayer() {
    const target = this.returnLayer ?? canvas.tokens;
    this.returnLayer = null;
    target?.activate?.();
    this.bar.querySelectorAll(".tb-btn.tb-active").forEach(b => b.classList.remove("tb-active"));
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
    // Retour à la couche précédente après le dessin (différé pour ne pas casser
    // la propagation du placeable pendant _onCreate).
    this.hookIds.createRegion = Hooks.on("createRegion", (doc, options, userId) => {
      if (userId !== game.user.id) return;
      this.emanationTokenId = null;
      setTimeout(() => this.restoreLayer(), 50);
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

  destroy() {
    for (const [hook, id] of Object.entries(this.hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", this.onResize);
    this.bar?.remove();
    SpellTemplateBar.instance = null;
  }
}
