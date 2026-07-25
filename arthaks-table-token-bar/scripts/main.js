/**
 * Arthak's Table Token Bar — Module Foundry VTT v13/v14 · Système dnd5e
 *
 * Barre flottante remplie DYNAMIQUEMENT avec les objets utilisables du token
 * sélectionné, en sections : INVENTAIRE → FEATURES → SORTS. Affichée pour tous,
 * mise à jour au changement de sélection et quand les objets de l'acteur changent.
 * (Portage du script hotbar « ActionBar.js » en module.)
 *
 * Contenu :
 *  - Inventaire = armes (équipées par défaut) + consommables utilisables.
 *  - Features   = dons "feat" réellement actionnables (effet réel, consommation
 *                 de ressource ou charges), + rappels listés (ex. Multiattack,
 *                 affichés en premier). Badge « charges restantes / total ».
 *  - Sorts      = Cantrips (niveau 0) à part, puis un groupe par niveau de sort,
 *                 dont l'en-tête affiche « emplacements restants / total ».
 *                 Compatible dnd5e v3/v4/v5.
 *
 * Interaction :
 *  - Clic gauche → utilise l'objet (item.use()).
 *  - Clic droit  → ouvre la fiche de l'objet.
 *  - Poignée (⋮⋮) → glisser pour déplacer la barre (position mémorisée).
 *  - Bouton ⟨ / ⟩ → minimise / ré-étend la barre (état mémorisé par utilisateur).
 *
 * Tout le comportement (groupes, taille, armes équipées, dédoublonnage, features
 * « rappel ») est configurable via les réglages du module.
 */

const MODULE_ID = "arthaks-table-token-bar";
const NS = MODULE_ID;
const BAR_ID = "selected-token-actions";

const notify = {
  info: (m) => console.log(`[Token Bar] ${m}`),
  warn: (m) => { console.warn(`[Token Bar] ${m}`); ui.notifications?.warn(m); },
};

// Configuration vivante, rafraîchie depuis les réglages à chaque rendu.
let CFG = {};

// ═══════════════════════════════════════════════════════════════════════════════
// RÉGLAGES
// ═══════════════════════════════════════════════════════════════════════════════
Hooks.once("init", () => {
  const reRender = () => TokenActionBar.instance?.render();

  game.settings.register(MODULE_ID, "buttonSize", {
    name: "Taille des boutons (px)",
    hint: "Taille des icônes d'objet de la barre.",
    scope: "client", config: true, type: Number, default: 42,
    onChange: reRender,
  });

  game.settings.register(MODULE_ID, "includeInventory", {
    name: "Afficher les armes",
    hint: "Armes (équipées par défaut).",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRender,
  });

  game.settings.register(MODULE_ID, "onlyEquippedWeapons", {
    name: "Armes équipées uniquement",
    hint: "N'afficher que les armes actuellement équipées.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRender,
  });

  game.settings.register(MODULE_ID, "includeFeatures", {
    name: "Afficher les features",
    hint: "Dons réellement actionnables (effet réel, consommation de ressource ou charges), avec compteur de charges.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRender,
  });

  game.settings.register(MODULE_ID, "includeSpells", {
    name: "Afficher les sorts",
    hint: "Cantrips (niveau 0) puis sorts groupés par niveau, avec les emplacements restants / total.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRender,
  });

  game.settings.register(MODULE_ID, "showGroupLabels", {
    name: "Afficher les en-têtes de groupe",
    hint: "Mince ligne de libellés de section (Armes, Features, Cantrips, N1…) et compteurs d'emplacements, au-dessus des icônes.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRender,
  });

  game.settings.register(MODULE_ID, "dockPosition", {
    name: "Ancrage de la barre",
    hint: "Ancre la barre sur un bord de l'écran (la poignée de déplacement est alors masquée). « Libre » = glisser-déposer, position mémorisée.",
    scope: "client", config: true, type: String,
    choices: {
      free: "Libre (glisser-déposer)",
      "bottom-left": "Bas · gauche",
      "bottom-center": "Bas · centre",
      "bottom-right": "Bas · droite",
      "top-left": "Haut · gauche",
      "top-center": "Haut · centre",
      "top-right": "Haut · droite",
      "left-top": "Gauche · haut",
      "left-center": "Gauche · centre",
      "left-bottom": "Gauche · bas",
      "right-top": "Droite · haut",
      "right-center": "Droite · centre",
      "right-bottom": "Droite · bas",
    },
    default: "bottom-center",
    onChange: reRender,
  });

  game.settings.register(MODULE_ID, "dedupeByName", {
    name: "Masquer les doublons",
    hint: "Masque les objets de même nom (garde le premier).",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: reRender,
  });

  game.settings.register(MODULE_ID, "alwaysShowFeatureNames", {
    name: "Features « rappel » toujours affichées",
    hint: "Noms de features toujours affichées même sans effet mécanique (séparés par des virgules). Correspondance par sous-chaîne, casse ignorée.",
    scope: "client", config: true, type: String, default: "Multiattack, Spellcasting",
    onChange: reRender,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════
Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    notify.warn(`Ce module cible le système dnd5e (système actuel : ${game.system.id}).`);
  }
  TokenActionBar.instance = new TokenActionBar();
  TokenActionBar.instance.init();
});

// ═══════════════════════════════════════════════════════════════════════════════
// DÉTECTION DES OBJETS (lit CFG, rafraîchi à chaque rendu)
// ═══════════════════════════════════════════════════════════════════════════════
// Liste des activities d'un objet (dnd5e v4). Vide en v3.
function activities(item) {
  const acts = item.system?.activities;
  if (!acts) return [];
  return acts.contents ?? (typeof acts[Symbol.iterator] === "function" ? [...acts] : []);
}

// Une activity produit-elle un effet mécanique réel ? On exige de VRAIS dés ou
// une formule (number/denomination/formula) pour les dégâts et le soin — un
// simple `bonus` de soin (ex. Disciple of Life = "+3") est un rider passif et
// ne compte PAS.
function activityHasRealEffect(act) {
  if (!act) return false;
  if (act.type === "attack" || act.attack) return true;
  if (act.type === "save"   || act.save)   return true;
  const dmg = act.damage?.parts ?? [];
  if (dmg.some(p => p?.number || p?.custom?.formula)) return true;
  const h = act.healing;
  if (h && (h.number || h.custom?.formula)) return true;
  return false;
}

// Une activity est « active » si elle a un effet réel OU consomme une ressource
// (charges, emplacement, Channel Divinity…). Distingue Preserve Life (consomme)
// des riders passifs comme Blessed Healer (ne consomme rien).
function isActiveActivity(act) {
  if (!act) return false;
  if (act.consumption?.targets?.length) return true;
  return activityHasRealEffect(act);
}

// L'objet a-t-il un usage limité (charges) ? (dnd5e v3 et v4)
function hasUses(item) {
  const u = item.system?.uses;
  if (!u) return false;
  if (u.max != null && u.max !== "" && Number(u.max) !== 0) return true; // v4 : formule/nombre
  if (Number(u.value) > 0) return true;                                  // v3
  return false;
}

// Arme (attaque). Optionnellement restreinte aux armes équipées.
function isWeapon(item) {
  if (item.type !== "weapon") return false;
  if (CFG.onlyEquippedWeapons && "equipped" in (item.system ?? {}) && !item.system.equipped) {
    return false;
  }
  return true;
}

// L'objet consomme-t-il une ressource/attribut de l'acteur ? (ex. resources.legact
// pour les actions légendaires, resources.legres pour la résistance légendaire)
function consumesActorResource(item) {
  const acts = activities(item);
  if (acts.some(a => (a.consumption?.targets ?? []).some(t => t.type === "attribute"))) return true;
  const c = item.system?.consume; // dnd5e v3
  return c?.type === "attribute" && !!c.target;
}

// Sort affichable : cantrip (niveau 0), méthode spéciale (atwill/innate/pact),
// ou sort préparé. (dnd5e v4/v5 : system.method + system.prepared)
function isUsableSpellItem(spell) {
  if (spell.type !== "spell") return false;
  if (Number(spell.system?.level) === 0) return true;
  const method = spell.system?.method;
  if (method && method !== "spell") return true;
  return !!spell.system?.prepared;
}

// Charges d'un objet (dnd5e v3/v4/v5) → { remaining, max } ou null.
// v4/v5 : uses.spent (restant = max - spent) ; v3 : uses.value (déjà le restant).
// Couvre aussi « recharge X-Y » (souffle de dragon) : uses.max vaut 1.
function itemUses(item) {
  const u = item.system?.uses;
  const max = Number(u?.max);
  if (!(max > 0)) return null;
  const remaining = (u.spent != null) ? (max - Number(u.spent)) : Number(u.value ?? 0);
  return { remaining, max };
}

// Compteur à afficher en badge sur un bouton : d'abord les charges propres de
// l'objet (inclut « recharge »), sinon la ressource d'acteur consommée
// (actions/résistance légendaires…). → { remaining, max } ou null.
function buttonCounter(item, actor) {
  const own = itemUses(item);
  if (own) return own;

  const readRes = (target) => {
    if (!target) return null;
    const path = String(target).replace(/\.value$/, ""); // "resources.legact.value" → "resources.legact"
    const res = foundry.utils.getProperty(actor?.system ?? {}, path);
    if (res && Number(res.max) > 0) return { remaining: Number(res.value ?? 0), max: Number(res.max) };
    return null;
  };

  for (const a of activities(item)) {
    for (const t of a.consumption?.targets ?? []) {
      if (t.type === "attribute") {
        const r = readRes(t.target);
        if (r) return r;
      }
    }
  }
  const c = item.system?.consume; // dnd5e v3
  if (c?.type === "attribute") {
    const r = readRes(c.target);
    if (r) return r;
  }
  return null;
}

// Feature (don) affichée si : nom en liste blanche « rappel », OU au moins une
// activity active (effet réel/consommation), OU usage limité (charges).
function isFeature(item) {
  if (item.type !== "feat") return false;
  const name = (item.name ?? "").toLowerCase();
  if (CFG.alwaysShowFeatureNames?.some(n => name.includes(n.toLowerCase()))) return true;
  if (activities(item).some(isActiveActivity)) return true;
  if (consumesActorResource(item)) return true;   // ex. résistance légendaire (legres)
  return hasUses(item);
}

// Retire les doublons de même nom (garde le premier).
function dedupeByName(items) {
  if (!CFG.dedupeByName) return items;
  const seen = new Set();
  return items.filter(i => {
    const key = (i.name ?? "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Une feature est-elle un « rappel » de la liste blanche (ex. Multiattack) ?
function isReminderFeature(item) {
  const name = (item.name ?? "").toLowerCase();
  return Boolean(CFG.alwaysShowFeatureNames?.some(n => name.includes(n.toLowerCase())));
}

// Construit les sections ordonnées : Inventaire → Features → Sorts (cantrips
// puis un groupe par niveau de sort, avec son compteur d'emplacements).
// Chaque section = { label, cssClass, items[], slotText? }.
function buildSections(actor) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  // Features : les rappels (Multiattack…) d'abord, puis le reste alphabétique.
  const byReminderThenName = (a, b) => {
    const ra = isReminderFeature(a), rb = isReminderFeature(b);
    if (ra !== rb) return ra ? -1 : 1;
    return byName(a, b);
  };
  const sections = [];

  // Inventaire : armes (équipées par défaut).
  if (CFG.includeInventory) {
    const items = dedupeByName(actor.items.filter(isWeapon)).sort(byName);
    if (items.length) sections.push({ label: "Armes", cssClass: null, items });
  }

  // Features actionnables (badge de charges sur les boutons).
  if (CFG.includeFeatures) {
    const items = dedupeByName(actor.items.filter(isFeature)).sort(byReminderThenName);
    if (items.length) sections.push({ label: "Features", cssClass: "ab-feature", items });
  }

  // Sorts : cantrips à part, puis un groupe par niveau (avec slots restants/total).
  if (CFG.includeSpells) {
    const spells = actor.items.filter(isUsableSpellItem);
    const cantrips = dedupeByName(spells.filter(s => Number(s.system?.level) === 0)).sort(byName);
    if (cantrips.length) sections.push({ label: "Cantrips", cssClass: "ab-cantrip", items: cantrips });

    for (let lvl = 1; lvl <= 9; lvl++) {
      const items = dedupeByName(spells.filter(s => Number(s.system?.level) === lvl)).sort(byName);
      if (!items.length) continue;
      const slot = actor.system?.spells?.[`spell${lvl}`];
      const slotText = (slot && Number(slot.max) > 0) ? `${slot.value ?? 0}/${slot.max}` : "";
      sections.push({ label: `N${lvl}`, cssClass: "ab-spell", items, slotText });
    }
  }

  return sections;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BARRE
// ═══════════════════════════════════════════════════════════════════════════════
class TokenActionBar {
  static instance = null;

  constructor() {
    this.bar = null;
    this.hookIds = {};
    this.onResize = this.onResize.bind(this);
  }

  get posKey() { return `${NS}.pos.${game.user.id}`; }
  get collapsedKey() { return `${NS}.collapsed.${game.user.id}`; }

  // ── Cycle de vie ─────────────────────────────────────────────────────────
  init() {
    document.querySelectorAll(`body > #${BAR_ID}`).forEach(el => el.remove());
    this.bar = document.createElement("div");
    this.bar.id = BAR_ID;
    document.body.appendChild(this.bar);

    this.registerHooks();
    window.addEventListener("resize", this.onResize);
    this.render();
    notify.info("Barre d'action prête.");
  }

  registerHooks() {
    this.hookIds.controlToken = Hooks.on("controlToken", () => this.render());
    const refreshOnItem = (item) => {
      const actorId = canvas.tokens?.controlled?.[0]?.actor?.id;
      if (item?.parent?.id && item.parent.id === actorId) this.render();
    };
    this.hookIds.createItem = Hooks.on("createItem", refreshOnItem);
    this.hookIds.updateItem = Hooks.on("updateItem", refreshOnItem);
    this.hookIds.deleteItem = Hooks.on("deleteItem", refreshOnItem);
  }

  destroy() {
    for (const [hook, id] of Object.entries(this.hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", this.onResize);
    this.bar?.remove();
    TokenActionBar.instance = null;
  }

  // Rafraîchit CFG depuis les réglages (les fonctions de détection lisent CFG).
  readCfg() {
    const names = String(game.settings.get(MODULE_ID, "alwaysShowFeatureNames") ?? "")
      .split(",").map(s => s.trim()).filter(Boolean);
    CFG = {
      includeInventory: game.settings.get(MODULE_ID, "includeInventory"),
      includeFeatures:  game.settings.get(MODULE_ID, "includeFeatures"),
      includeSpells:    game.settings.get(MODULE_ID, "includeSpells"),
      showGroupLabels:  game.settings.get(MODULE_ID, "showGroupLabels"),
      dockPosition:     game.settings.get(MODULE_ID, "dockPosition") || "bottom-center",
      onlyEquippedWeapons: game.settings.get(MODULE_ID, "onlyEquippedWeapons"),
      dedupeByName: game.settings.get(MODULE_ID, "dedupeByName"),
      alwaysShowFeatureNames: names,
      buttonSize: Number(game.settings.get(MODULE_ID, "buttonSize")) || 42,
    };
  }

  // ── Rendu ──────────────────────────────────────────────────────────────────
  render() {
    this.readCfg();
    const controlled = canvas.tokens?.controlled ?? [];
    this.bar.replaceChildren();

    if (controlled.length !== 1 || !controlled[0].actor) {
      this.bar.style.display = "none";
      return;
    }

    const token = controlled[0];
    const actor = token.actor;
    this.bar.style.display = "flex";

    // Poignée de déplacement (masquée quand la barre est ancrée).
    const handle = document.createElement("i");
    handle.className = "fas fa-grip-vertical ab-handle";
    handle.dataset.tooltip = "Glisser pour déplacer la barre";
    this.initDrag(handle);
    this.bar.appendChild(handle);
    this.handle = handle;

    // Libellé (repliable).
    const label = document.createElement("div");
    label.className = "ab-label ab-collapsible";
    label.textContent = token.name;
    this.bar.appendChild(label);

    // Groupes (repliables) : Inventaire → Features → Sorts (cantrips + par niveau).
    const sections = buildSections(actor);
    const wrap = document.createElement("div");
    wrap.className = "ab-items ab-collapsible";

    for (const section of sections) {
      // Chaque section = un bloc vertical : mini-libellé au-dessus, icônes en dessous.
      const block = document.createElement("div");
      block.className = "ab-section";

      if (CFG.showGroupLabels && section.label) {
        const head = document.createElement("div");
        head.className = "ab-group";
        const name = document.createElement("span");
        name.className = "ab-group-name";
        name.textContent = section.label;
        head.appendChild(name);
        if (section.slotText) {
          const slot = document.createElement("span");
          slot.className = "ab-slot";
          slot.textContent = section.slotText;
          slot.dataset.tooltip = "Emplacements restants / total à ce niveau";
          head.appendChild(slot);
        }
        block.appendChild(head);
      }

      const row = document.createElement("div");
      row.className = "ab-row";
      section.items.forEach(i => row.appendChild(this.makeButton(i, section.cssClass, actor)));
      block.appendChild(row);

      wrap.appendChild(block);
    }

    if (!wrap.childElementCount) {
      const empty = document.createElement("div");
      empty.className = "ab-empty";
      empty.textContent = "Aucune action disponible.";
      wrap.appendChild(empty);
    }
    this.bar.appendChild(wrap);

    // Toggle minimiser / ré-étendre (toujours visible).
    const collapsed = localStorage.getItem(this.collapsedKey) === "1";
    const toggle = document.createElement("div");
    toggle.className = "ab-toggle";
    toggle.dataset.tooltip = collapsed ? "Ré-étendre la barre" : "Minimiser la barre";
    toggle.innerHTML = `<i class="fas fa-chevron-${collapsed ? "right" : "left"}"></i>`;
    toggle.addEventListener("click", () => this.toggleCollapsed());
    this.bar.appendChild(toggle);

    this.bar.classList.toggle("ab-collapsed", collapsed);

    // Orientation selon l'ancrage.
    const dock = CFG.dockPosition;
    this.bar.classList.toggle("ab-vertical", dock.startsWith("left") || dock.startsWith("right"));

    // Placement une fois le contenu construit (dimensions connues).
    this.applyDockOrFree();
  }

  makeButton(item, cssClass, actor) {
    const btn = document.createElement("div");
    btn.className = `ab-btn${cssClass ? " " + cssClass : ""}`;
    btn.style.width = btn.style.height = `${CFG.buttonSize}px`;
    btn.style.backgroundImage = `url("${item.img}")`;
    btn.dataset.tooltip = item.name;

    // Badge : charges propres (features, recharge…) ou ressource d'acteur
    // consommée (actions légendaires legact, résistance légendaire legres…).
    const counter = buttonCounter(item, actor);
    if (counter) {
      const badge = document.createElement("span");
      badge.className = "ab-badge";
      badge.textContent = `${counter.remaining}/${counter.max}`;
      if (counter.remaining <= 0) badge.classList.add("ab-badge-empty");
      btn.appendChild(badge);
    }

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      item.use?.({}, { event: ev });
    });
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      item.sheet?.render(true);
    });
    return btn;
  }

  // ── Minimiser ────────────────────────────────────────────────────────────
  toggleCollapsed() {
    const on = !this.bar.classList.contains("ab-collapsed");
    this.bar.classList.toggle("ab-collapsed", on);
    localStorage.setItem(this.collapsedKey, on ? "1" : "0");
    const icon = this.bar.querySelector(".ab-toggle i");
    if (icon) icon.className = `fas fa-chevron-${on ? "right" : "left"}`;
    const toggle = this.bar.querySelector(".ab-toggle");
    if (toggle) toggle.dataset.tooltip = on ? "Ré-étendre la barre" : "Minimiser la barre";
    // Ré-ancre (ou re-clampe en mode libre) après le changement de dimensions.
    this.applyDockOrFree();
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
    this.bar.style.transform = "none";
  }

  savePos() {
    const r = this.bar.getBoundingClientRect();
    localStorage.setItem(this.posKey, JSON.stringify({ left: r.left, top: r.top }));
  }

  readPos() {
    try { return JSON.parse(localStorage.getItem(this.posKey)); } catch { return null; }
  }

  // Ancre la barre sur un bord selon le réglage, ou la laisse libre (glisser).
  applyDockOrFree() {
    const dock = CFG.dockPosition || "bottom-center";
    if (dock === "free") {
      if (this.handle) this.handle.style.display = "";
      return this.applyPosition();
    }
    if (this.handle) this.handle.style.display = "none";

    const m = 8;
    const bw = this.bar.offsetWidth, bh = this.bar.offsetHeight;
    const W = window.innerWidth, H = window.innerHeight;
    const [edge, align] = dock.split("-");
    let left, top;

    if (edge === "bottom" || edge === "top") {
      top = edge === "top" ? m : H - bh - m;
      left = align === "left" ? m : align === "right" ? W - bw - m : (W - bw) / 2;
      // Bas-centre : se caler au-dessus de la hotbar plutôt que de la recouvrir.
      if (edge === "bottom" && align === "center") {
        const hb = document.getElementById("hotbar")?.getBoundingClientRect();
        if (hb && hb.width) top = hb.top - bh - m;
      }
    } else { // gauche / droite : barre verticale
      left = edge === "left" ? m : W - bw - m;
      top = align === "top" ? m : align === "bottom" ? H - bh - m : (H - bh) / 2;
    }
    this.setPos(left, top);
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
    if (!this.bar || this.bar.style.display === "none") return;
    if ((CFG.dockPosition || "bottom-center") !== "free") return this.applyDockOrFree();
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
}
