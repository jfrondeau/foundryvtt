/**
 * Combat Overlay — Module Foundry VTT v14 · Système dnd5e 5.x
 *
 * Suivi de combat COMPACT superposé à la scène, pensé pour l'écran partagé de la
 * table. Il s'affiche AUTOMATIQUEMENT dès qu'un combat est actif (encounter créé
 * avec au moins un combattant) et reste visible pour TOUS les utilisateurs.
 *
 * Affichage :
 *  - En-tête : « Manche N » (ou « Préparation » avant le début) + boutons MJ.
 *  - Une ligne par combattant : marqueur ▶ sur le courant, portrait (ou image de
 *    token, réglable), nom, initiative. Fond différent PJ / monstre.
 *  - Les combattants cachés ne sont visibles que du MJ (grisés).
 *
 * Automatisations au changement de tour :
 *  - Le token du combattant courant est SÉLECTIONNÉ (pour qui le possède : le MJ
 *    voit chaque token, un joueur voit le sien à son tour).
 *  - La caméra se CENTRE sur ce token (MJ uniquement, pour piloter la vue de table).
 *
 * Aide au MJ en début de combat :
 *  - Bouton « dé » : roule l'initiative de tous les MONSTRES d'un clic (rollNPC).
 *  - Chaque ligne de PJ expose un champ d'initiative éditable → saisie manuelle
 *    rapide au clavier (le MJ possède tout ; un joueur édite la sienne).
 *  - Bouton « play / tour suivant » selon l'état du combat.
 *
 * Raccourci clavier : « . » (Period) passe au tour suivant (réservé au MJ, qui
 * pilote le combat). « , » (Comma) revient au tour précédent (non lié par défaut).
 *
 * Interaction de la barre :
 *  - Poignée (⋮⋮) : glisser pour déplacer (position mémorisée par utilisateur).
 *  - Bouton ⟨ / ⟩ : minimise / ré-étend (état mémorisé par utilisateur).
 */

const MODULE_ID = "combat-overlay";
const NS = MODULE_ID;

const notify = {
  info: (m) => console.log(`[Combat Overlay] ${m}`),
  warn: (m) => { console.warn(`[Combat Overlay] ${m}`); ui.notifications?.warn(m); },
};

const VIDEO_RE = /\.(webm|mp4|m4v|ogv|ogg)$/i;
const MYSTERY_MAN = "icons/svg/mystery-man.svg";

// ═══════════════════════════════════════════════════════════════════════════════
// RÉGLAGES + RACCOURCIS
// ═══════════════════════════════════════════════════════════════════════════════
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "imageMode", {
    name: "Image des combattants",
    hint: "Portrait de la fiche d'acteur ou image du token placé sur la scène.",
    scope: "world",
    config: true,
    type: String,
    choices: { actor: "Portrait de l'acteur", token: "Image du token" },
    default: "actor",
    onChange: () => CombatOverlay.instance?.sync(),
  });

  game.settings.register(MODULE_ID, "rowSize", {
    name: "Taille des lignes (px)",
    hint: "Hauteur des vignettes de combattant.",
    scope: "client",
    config: true,
    type: Number,
    default: 40,
    onChange: () => CombatOverlay.instance?.applyRowSize(),
  });

  game.settings.register(MODULE_ID, "autoControlToken", {
    name: "Sélectionner le token du combattant courant",
    hint: "À chaque changement de tour, sélectionne sur la scène le token du combattant courant (pour l'utilisateur qui le possède).",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "autoPanToken", {
    name: "Centrer la caméra sur le combattant courant (MJ)",
    hint: "À chaque changement de tour, centre la vue du MJ sur le token courant. N'affecte pas la caméra des joueurs.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // « . » : tour suivant (le MJ pilote le combat → raccourci réservé au MJ).
  game.keybindings.register(MODULE_ID, "nextTurn", {
    name: "Combat : tour suivant",
    hint: "Passe au combattant suivant.",
    editable: [{ key: "Period" }],
    restricted: true,
    onDown: () => CombatOverlay.advanceTurn(+1),
  });

  // « , » : tour précédent.
  game.keybindings.register(MODULE_ID, "prevTurn", {
    name: "Combat : tour précédent",
    hint: "Revient au combattant précédent.",
    editable: [{ key: "Comma" }],
    restricted: true,
    onDown: () => CombatOverlay.advanceTurn(-1),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════
Hooks.once("ready", () => {
  CombatOverlay.instance = new CombatOverlay();
  CombatOverlay.instance.init();
});

// ═══════════════════════════════════════════════════════════════════════════════
// OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════
class CombatOverlay {
  static instance = null;

  /** Fait avancer le combat actif d'un pas (MJ seulement). Renvoie true si consommé. */
  static advanceTurn(dir) {
    // Ne pas capter la touche quand on tape dans un champ (saisie d'initiative).
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return false;

    const combat = game.combats?.active;
    if (!combat || !game.user.isGM) return false;
    if (dir < 0) combat.previousTurn();
    else combat.nextTurn();
    return true;
  }

  constructor() {
    this.root = null;
    this.hookIds = {};
    this._lastTurnId = null;            // id du combattant courant au dernier rendu
    this._lastVisibleCurrentId = null;  // dernier combattant courant VISIBLE (pour ce user)
    this.onResize = this.onResize.bind(this);
    // Regroupe les rafales de hooks (création multiple de combattants, etc.).
    this.sync = foundry.utils.debounce(this._sync.bind(this), 30);
  }

  get combat() { return game.combats?.active ?? null; }
  get posKey() { return `${NS}.pos.${game.user.id}`; }
  get collapsedKey() { return `${NS}.collapsed.${game.user.id}`; }

  // ── Cycle de vie ─────────────────────────────────────────────────────────
  init() {
    this.registerHooks();
    window.addEventListener("resize", this.onResize);
    this.sync();
    notify.info("Overlay de combat prêt.");
  }

  registerHooks() {
    const rerender = () => this.sync();
    this.hookIds.createCombat      = Hooks.on("createCombat", rerender);
    this.hookIds.deleteCombat      = Hooks.on("deleteCombat", rerender);
    this.hookIds.updateCombat      = Hooks.on("updateCombat", rerender);
    this.hookIds.createCombatant   = Hooks.on("createCombatant", rerender);
    this.hookIds.updateCombatant   = Hooks.on("updateCombatant", rerender);
    this.hookIds.deleteCombatant   = Hooks.on("deleteCombatant", rerender);
  }

  destroy() {
    for (const [hook, id] of Object.entries(this.hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", this.onResize);
    this.root?.remove();
    CombatOverlay.instance = null;
  }

  // ── Décision d'affichage ────────────────────────────────────────────────
  _sync() {
    const combat = this.combat;
    const visible = combat?.combatants?.size ? this.visibleCombatants(combat).length > 0 : false;

    if (!visible) {
      this._lastTurnId = null;
      this._lastVisibleCurrentId = null;
      if (this.root) this.root.style.display = "none";
      return;
    }

    this.mount();
    this.root.style.display = "";
    this.render(combat);

    // Changement de tour → sélection + centrage sur le token courant.
    const currentId = combat.started ? (combat.combatant?.id ?? null) : null;
    if (currentId && currentId !== this._lastTurnId) this.onTurnChange(combat.combatant);
    this._lastTurnId = currentId;
  }

  /** Combattants pertinents pour l'utilisateur (le MJ voit les cachés, pas les joueurs). */
  visibleCombatants(combat) {
    return combat.turns.filter(c => game.user.isGM || !c.hidden);
  }

  // ── Construction du conteneur (une seule fois) ───────────────────────────
  mount() {
    if (this.root) return;

    const root = document.createElement("div");
    root.id = "combat-overlay";
    this.root = root;
    document.body.appendChild(root);

    this.applyRowSize();
    this.applyPosition();
    if (localStorage.getItem(this.collapsedKey) === "1") root.classList.add("co-collapsed");
  }

  // ── Rendu ────────────────────────────────────────────────────────────────
  render(combat) {
    const root = this.root;

    // Ne pas reconstruire pendant une saisie d'initiative : la mise à jour d'un
    // autre client ne doit pas détruire le champ en cours d'édition (perte de focus).
    const active = document.activeElement;
    if (active && root.contains(active) && active.classList.contains("co-init-edit")) return;

    root.innerHTML = "";

    // En-tête : poignée + manche + boutons MJ + toggle.
    const header = document.createElement("div");
    header.className = "co-header";

    const handle = document.createElement("i");
    handle.className = "fas fa-grip-vertical co-handle";
    handle.dataset.tooltip = "Glisser pour déplacer";
    this.initDrag(handle);
    header.appendChild(handle);

    const round = document.createElement("div");
    round.className = "co-round";
    round.textContent = combat.started ? `Manche ${combat.round}` : "Préparation";
    header.appendChild(round);

    if (game.user.isGM) {
      // Rouler l'initiative des monstres.
      const rollBtn = this.makeBtn("fas fa-dice-d20", "Rouler l'initiative des monstres", () => {
        combat.rollNPC();
      });
      header.appendChild(rollBtn);

      // Commencer / tour suivant selon l'état.
      if (!combat.started) {
        header.appendChild(this.makeBtn("fas fa-play", "Commencer le combat", () => combat.startCombat()));
      } else {
        header.appendChild(this.makeBtn("fas fa-forward-step", "Tour suivant ( . )", () => combat.nextTurn()));
      }

      // Terminer le combat (confirmation).
      const endBtn = this.makeBtn("fas fa-flag-checkered", "Terminer le combat", () => this.endCombat(combat));
      endBtn.classList.add("co-btn-end");
      header.appendChild(endBtn);
    }

    // Toggle minimiser (toujours à droite de l'en-tête).
    const toggle = document.createElement("div");
    toggle.className = "co-toggle";
    const collapsed = root.classList.contains("co-collapsed");
    toggle.dataset.tooltip = collapsed ? "Ré-étendre" : "Minimiser";
    toggle.innerHTML = `<i class="fas fa-chevron-${collapsed ? "down" : "up"}"></i>`;
    toggle.addEventListener("click", () => this.toggleCollapsed());
    header.appendChild(toggle);

    root.appendChild(header);

    // Liste des combattants (masquée à l'état minimisé).
    const list = document.createElement("div");
    list.className = "co-list co-collapsible";

    // Marqueur ▶ : sur le combattant courant s'il est visible pour cet utilisateur.
    // Si le courant est caché (ex. monstre invisible côté joueur), on CONSERVE le
    // marqueur sur le dernier combattant visible qui l'avait, plutôt que de l'effacer.
    const visible = this.visibleCombatants(combat);
    const visibleIds = new Set(visible.map(c => c.id));
    const actualCurrentId = combat.started ? (combat.combatant?.id ?? null) : null;

    let markerId = null;
    if (actualCurrentId && visibleIds.has(actualCurrentId)) {
      markerId = actualCurrentId;
      this._lastVisibleCurrentId = actualCurrentId;
    } else if (combat.started && visibleIds.has(this._lastVisibleCurrentId)) {
      markerId = this._lastVisibleCurrentId;
    }

    for (const c of visible) {
      list.appendChild(this.renderRow(c, c.id === markerId));
    }
    root.appendChild(list);
  }

  renderRow(c, isCurrent) {
    const row = document.createElement("div");
    row.className = "co-row";
    row.classList.toggle("co-pc", !c.isNPC);
    row.classList.toggle("co-npc", c.isNPC);
    row.classList.toggle("co-current", isCurrent);
    row.classList.toggle("co-hidden", !!c.hidden);
    row.dataset.combatantId = c.id;

    // Marqueur du combattant courant.
    const marker = document.createElement("div");
    marker.className = "co-marker";
    marker.innerHTML = isCurrent ? '<i class="fas fa-caret-right"></i>' : "";
    row.appendChild(marker);

    // Portrait / token.
    const img = document.createElement("img");
    img.className = "co-img";
    img.src = this.imgFor(c);
    img.alt = c.name;
    row.appendChild(img);

    // Nom.
    const name = document.createElement("div");
    name.className = "co-name";
    name.textContent = c.name;
    row.appendChild(name);

    // Initiative : champ éditable si l'utilisateur possède le combattant, sinon texte.
    row.appendChild(this.renderInit(c));

    // Clic sur la ligne (hors champ) → sélectionne/centre le token si possédé.
    row.addEventListener("click", (ev) => {
      if (ev.target.closest("input")) return;
      this.focusToken(c);
    });

    return row;
  }

  renderInit(c) {
    const hasInit = c.initiative !== null && c.initiative !== undefined;
    if (c.isOwner) {
      const input = document.createElement("input");
      input.className = "co-init co-init-edit";
      input.type = "number";
      input.value = hasInit ? c.initiative : "";
      input.placeholder = "–";
      input.dataset.tooltip = "Initiative (Entrée pour valider)";
      input.addEventListener("click", (ev) => ev.stopPropagation());
      input.addEventListener("change", () => this.setInit(c, input.value));
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      });
      return input;
    }
    const span = document.createElement("div");
    span.className = "co-init";
    span.textContent = hasInit ? c.initiative : "–";
    return span;
  }

  makeBtn(iconClass, tooltip, onClick) {
    const btn = document.createElement("div");
    btn.className = "co-btn";
    btn.dataset.tooltip = tooltip;
    btn.innerHTML = `<i class="${iconClass}"></i>`;
    btn.addEventListener("click", (ev) => { ev.preventDefault(); onClick(); });
    return btn;
  }

  // ── Données ────────────────────────────────────────────────────────────
  /** Source d'image selon le réglage, avec repli si vidéo/manquante. */
  imgFor(c) {
    const mode = game.settings.get(MODULE_ID, "imageMode");
    const token = c.token?.texture?.src || c.img;
    const actor = c.actor?.img;
    let src = mode === "token" ? (token || actor) : (actor || token);
    if (!src || VIDEO_RE.test(src)) {
      const alt = mode === "token" ? actor : token;
      src = (alt && !VIDEO_RE.test(alt)) ? alt : MYSTERY_MAN;
    }
    return src;
  }

  /** Termine et clôture le combat après confirmation (MJ). */
  async endCombat(combat) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Terminer le combat" },
      content: "<p>Terminer et clôturer ce combat ?</p>",
      rejectClose: false,
      modal: true,
    });
    if (!ok) return;
    try {
      await combat.delete();
    } catch (err) {
      notify.warn("Impossible de terminer le combat.");
      console.error(err);
    }
  }

  async setInit(c, value) {
    const trimmed = String(value).trim();
    const num = trimmed === "" ? null : Number(trimmed);
    if (num !== null && Number.isNaN(num)) { notify.warn("Initiative invalide."); return; }
    try {
      await c.update({ initiative: num });
    } catch (err) {
      notify.warn("Impossible de modifier l'initiative.");
      console.error(err);
    }
  }

  // ── Automatisations de tour ──────────────────────────────────────────────
  onTurnChange(combatant) {
    const token = combatant?.token?.object;
    if (!token) return;

    if (game.settings.get(MODULE_ID, "autoControlToken") && token.isOwner) {
      try { token.control({ releaseOthers: true }); } catch (e) { console.warn("[Combat Overlay] control:", e); }
    }
    if (game.settings.get(MODULE_ID, "autoPanToken") && game.user.isGM) {
      try { canvas.animatePan({ x: token.center.x, y: token.center.y }); } catch (e) { console.warn("[Combat Overlay] pan:", e); }
    }
  }

  /** Clic sur une ligne : sélectionne et centre sur le token si l'utilisateur le possède. */
  focusToken(combatant) {
    const token = combatant?.token?.object;
    if (!token?.isOwner) return;
    try {
      token.control({ releaseOthers: true });
      canvas.animatePan({ x: token.center.x, y: token.center.y });
    } catch (e) { console.warn("[Combat Overlay] focus:", e); }
  }

  // ── Taille / minimiser ───────────────────────────────────────────────────
  applyRowSize() {
    const size = Number(game.settings.get(MODULE_ID, "rowSize")) || 40;
    this.root?.style.setProperty("--co-row", `${size}px`);
  }

  toggleCollapsed() {
    const on = !this.root.classList.contains("co-collapsed");
    this.root.classList.toggle("co-collapsed", on);
    localStorage.setItem(this.collapsedKey, on ? "1" : "0");
    const r = this.root.getBoundingClientRect();
    this.setPos(r.left, r.top);
    // Met à jour l'icône du toggle immédiatement.
    const icon = this.root.querySelector(".co-toggle i");
    if (icon) icon.className = `fas fa-chevron-${on ? "down" : "up"}`;
    const toggle = this.root.querySelector(".co-toggle");
    if (toggle) toggle.dataset.tooltip = on ? "Ré-étendre" : "Minimiser";
  }

  // ── Position (drag + mémorisation) ───────────────────────────────────────
  clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  setPos(left, top) {
    const bw = this.root.offsetWidth || 200;
    const bh = this.root.offsetHeight || 60;
    left = this.clamp(left, 4, window.innerWidth - bw - 4);
    top = this.clamp(top, 4, window.innerHeight - bh - 4);
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
    this.root.style.right = this.root.style.bottom = "auto";
  }

  savePos() {
    const r = this.root.getBoundingClientRect();
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
    this.setPos(10, 80); // par défaut : coin supérieur gauche de la scène.
  }

  onResize() {
    if (!this.root) return;
    const r = this.root.getBoundingClientRect();
    this.setPos(r.left, r.top);
  }

  initDrag(handle) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const r = this.root.getBoundingClientRect();
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
}
