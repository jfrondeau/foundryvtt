/**
 * Action Bar Macro — Foundry VTT v13/v14 · Système dnd5e
 *
 * Affiche une 2e barre flottante remplie dynamiquement avec les objets
 * utilisables du token sélectionné, dans l'ordre : ARMES → CANTRIPS → FEATURES.
 *
 * Contenu :
 *  - Armes    = type "weapon" (équipées uniquement par défaut).
 *  - Cantrips = sorts de niveau 0 (system.level === 0).
 *  - Features = dons "feat" réellement actionnables (effet réel ou consommation
 *               de ressource ou charges), + rappels listés (ex. Multiattack,
 *               affichés en premier). Compatible dnd5e v3 et v4 (activities).
 *
 * Interaction :
 *  - Clic gauche → utilise l'objet (item.use()).
 *  - Clic droit  → ouvre la fiche de l'objet.
 *  - Poignée (⋮⋮) en tête → glisser pour déplacer la barre (position mémorisée).
 *  - Bouton ✕    → referme la barre.
 *
 * La barre se met à jour au changement de sélection (controlToken) et quand les
 * objets de l'acteur changent. Relancer la macro remplace proprement l'instance.
 * Id unique "selected-token-actions" pour éviter tout conflit avec d'autres modules.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — modifier ici uniquement
// ═══════════════════════════════════════════════════════════════════════════════
const CFG = {
  // Groupes affichés, dans l'ordre : armes → cantrips → features.
  includeWeapons:  true,   // armes (attaques)
  includeCantrips: true,   // cantrips (sorts niveau 0)
  includeFeatures: true,   // features (dons) AVEC action ou usage limité

  onlyEquippedWeapons: true, // armes : n'afficher que si équipées
  dedupeByName:        true, // masquer les doublons de même nom

  // Features « rappel » toujours affichées même sans effet mécanique
  // (ex. Multiattack, Spellcasting). Correspondance par sous-chaîne, casse ignorée
  // ("Spellcasting" couvre aussi "Innate Spellcasting").
  alwaysShowFeatureNames: ["Multiattack", "Spellcasting"],

  buttonSize: 42,            // taille des boutons (px)
};
// ═══════════════════════════════════════════════════════════════════════════════

const NS = "actionBar";
const notify = {
  info:  (m) => { console.log(`[Action Bar] ${m}`); },
  warn:  (m) => { console.warn(`[Action Bar] ${m}`); ui.notifications.warn(m); },
};

// ── Garde système ─────────────────────────────────────────────────────────────
if (game.system.id !== "dnd5e") {
  notify.warn(`Cette macro cible le système dnd5e (système actuel : ${game.system.id}).`);
}

// ── Nettoyage d'une instance précédente ──────────────────────────────────────
if (window[NS]?.destroy) window[NS].destroy();
// Filet de sécurité : retire uniquement MA barre résiduelle (enfant direct du
// body) — jamais un élément homonyme imbriqué dans un autre module.
document.querySelectorAll("body > #selected-token-actions").forEach(el => el.remove());

// ── Styles (injectés une seule fois) ─────────────────────────────────────────
const STYLE_ID = "selected-token-actions-style";
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #selected-token-actions {
      position: fixed; z-index: 70;
      display: flex; align-items: center; gap: 6px;
      max-width: 96vw; padding: 4px 8px;
      background: rgba(0,0,0,0.65); border: 1px solid #7a7a7a; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      pointer-events: all; user-select: none;
    }
    #selected-token-actions .ab-handle {
      flex: 0 0 auto; cursor: grab; color: #aaa; touch-action: none;
      padding: 0 4px; font-size: 14px; line-height: 1;
    }
    #selected-token-actions .ab-handle:hover { color: #fff; }
    #selected-token-actions .ab-handle:active { cursor: grabbing; color: #ff6400; }
    #selected-token-actions .ab-label {
      font-size: 11px; color: #ddd; font-weight: bold;
      white-space: nowrap; margin-right: 2px; max-width: 120px;
      overflow: hidden; text-overflow: ellipsis;
    }
    #selected-token-actions .ab-items {
      display: flex; align-items: center; gap: 4px;
      overflow-x: auto; overflow-y: hidden; padding: 2px;
    }
    #selected-token-actions .ab-items::-webkit-scrollbar { height: 6px; }
    #selected-token-actions .ab-items::-webkit-scrollbar-thumb { background: #666; border-radius: 3px; }
    #selected-token-actions .ab-btn {
      position: relative; flex: 0 0 auto;
      background-size: cover; background-position: center;
      border: 2px solid #555; border-radius: 4px; cursor: pointer;
      transition: border-color .1s ease, transform .1s ease;
    }
    #selected-token-actions .ab-btn:hover { border-color: #ff6400; transform: translateY(-2px); }
    #selected-token-actions .ab-btn.ab-cantrip { border-color: #4a90d9; }
    #selected-token-actions .ab-btn.ab-cantrip:hover { border-color: #7ec8ff; }
    #selected-token-actions .ab-btn.ab-feature { border-color: #7a9c4a; }
    #selected-token-actions .ab-btn.ab-feature:hover { border-color: #b5d97e; }
    #selected-token-actions .ab-sep { width: 1px; align-self: stretch; background: #666; margin: 2px 2px; }
    #selected-token-actions .ab-empty { font-size: 12px; color: #999; font-style: italic; padding: 4px 8px; }
    #selected-token-actions .ab-close {
      flex: 0 0 auto; width: 20px; height: 20px; line-height: 18px; text-align: center;
      color: #ccc; border: 1px solid #666; border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    #selected-token-actions .ab-close:hover { color: #fff; border-color: #ff6400; }
  `;
  document.head.appendChild(style);
}

// ── Construction de la barre ─────────────────────────────────────────────────
// Barre flottante (position: fixed) : placée par défaut au-dessus de #hotbar,
// déplaçable au drag via la poignée. Position mémorisée dans localStorage.
const POS_KEY = `${NS}.pos`;
const bar = document.createElement("div");
bar.id = "selected-token-actions";
document.body.appendChild(bar);

// ── Position : lecture / écriture / application ──────────────────────────────
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function setPos(left, top) {
  const bw = bar.offsetWidth  || 200;
  const bh = bar.offsetHeight || 40;
  left = clamp(left, 4, window.innerWidth  - bw - 4);
  top  = clamp(top,  4, window.innerHeight - bh - 4);
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top  = `${Math.round(top)}px`;
  bar.style.right = bar.style.bottom = "auto";
  bar.style.transform = "none";
}

function savePos() {
  const r = bar.getBoundingClientRect();
  localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top }));
}

function readPos() {
  try { return JSON.parse(localStorage.getItem(POS_KEY)); } catch { return null; }
}

// Applique la position mémorisée, sinon place la barre au-dessus de #hotbar.
function applyPosition() {
  const saved = readPos();
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    return setPos(saved.left, saved.top);
  }
  const hb = document.getElementById("hotbar");
  const r  = hb?.getBoundingClientRect();
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  if (r && r.width) {
    setPos(r.left + r.width / 2 - bw / 2, r.top - bh - 8); // centré au-dessus
  } else {
    setPos((window.innerWidth - bw) / 2, window.innerHeight - bh - 90);
  }
}

// ── Drag via la poignée ──────────────────────────────────────────────────────
function initDrag(handle) {
  handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const r = bar.getBoundingClientRect();
    const offX = ev.clientX - r.left;
    const offY = ev.clientY - r.top;
    handle.setPointerCapture(ev.pointerId);
    const onMove = (e) => setPos(e.clientX - offX, e.clientY - offY);
    const onUp = () => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      savePos();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

// ── Détection des objets ─────────────────────────────────────────────────────
function isCantrip(item) {
  return item.type === "spell" && Number(item.system?.level) === 0;
}

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

// Feature (don) affichée si :
//  - son nom est dans la liste blanche « rappel » (ex. Multiattack), OU
//  - au moins une activity est active (effet réel ou consommation de ressource), OU
//  - elle a un usage limité (charges).
// Les riders passifs (soin en bonus seul, "utility" sans effet) sont masqués.
function isFeature(item) {
  if (item.type !== "feat") return false;
  const name = (item.name ?? "").toLowerCase();
  if (CFG.alwaysShowFeatureNames?.some(n => name.includes(n.toLowerCase()))) return true;
  if (activities(item).some(isActiveActivity)) return true;
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

function collect(actor) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  // Features : les rappels (Multiattack…) d'abord, puis le reste alphabétique.
  const byReminderThenName = (a, b) => {
    const ra = isReminderFeature(a), rb = isReminderFeature(b);
    if (ra !== rb) return ra ? -1 : 1;
    return byName(a, b);
  };
  const weapons  = CFG.includeWeapons  ? dedupeByName(actor.items.filter(isWeapon)).sort(byName)   : [];
  const cantrips = CFG.includeCantrips ? dedupeByName(actor.items.filter(isCantrip)).sort(byName)  : [];
  const features = CFG.includeFeatures ? dedupeByName(actor.items.filter(isFeature)).sort(byReminderThenName) : [];
  return { weapons, cantrips, features };
}

// ── Création d'un bouton ─────────────────────────────────────────────────────
function makeButton(item, cssClass) {
  const btn = document.createElement("div");
  btn.className = `ab-btn${cssClass ? " " + cssClass : ""}`;
  btn.style.width = btn.style.height = `${CFG.buttonSize}px`;
  btn.style.backgroundImage = `url("${item.img}")`;
  btn.dataset.tooltip = item.name;
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

// ── Rendu ────────────────────────────────────────────────────────────────────
function render() {
  const controlled = canvas.tokens?.controlled ?? [];
  bar.replaceChildren();

  if (controlled.length !== 1) {
    bar.style.display = "none";
    return;
  }

  const token = controlled[0];
  const actor = token.actor;
  if (!actor) { bar.style.display = "none"; return; }

  bar.style.display = "flex";

  // Poignée de déplacement (drag) en tête de barre.
  const handle = document.createElement("i");
  handle.className = "fas fa-grip-vertical ab-handle";
  handle.dataset.tooltip = "Glisser pour déplacer la barre";
  initDrag(handle);
  bar.appendChild(handle);

  const label = document.createElement("div");
  label.className = "ab-label";
  label.textContent = token.name;
  bar.appendChild(label);

  const { weapons, cantrips, features } = collect(actor);

  const wrap = document.createElement("div");
  wrap.className = "ab-items";

  // Ajoute un groupe, précédé d'un séparateur si la barre a déjà du contenu.
  const addGroup = (items, cssClass) => {
    if (!items.length) return;
    if (wrap.childElementCount) {
      const sep = document.createElement("div");
      sep.className = "ab-sep";
      wrap.appendChild(sep);
    }
    items.forEach(i => wrap.appendChild(makeButton(i, cssClass)));
  };

  // Ordre imposé : armes → cantrips → features.
  addGroup(weapons,  null);
  addGroup(cantrips, "ab-cantrip");
  addGroup(features, "ab-feature");

  if (!wrap.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "ab-empty";
    empty.textContent = "Aucune arme, cantrip ou feature.";
    wrap.appendChild(empty);
  }

  bar.appendChild(wrap);

  const close = document.createElement("div");
  close.className = "ab-close";
  close.textContent = "✕";
  close.dataset.tooltip = "Fermer la barre d'action";
  close.addEventListener("click", () => window[NS]?.destroy());
  bar.appendChild(close);

  // Placement une fois le contenu construit (dimensions connues).
  applyPosition();
}

// ── Hooks ─────────────────────────────────────────────────────────────────────
const hookIds = {};
hookIds.controlToken = Hooks.on("controlToken", () => render());

// Rafraîchir si un objet de l'acteur contrôlé change.
const refreshOnItem = (item) => {
  const actorId = canvas.tokens?.controlled?.[0]?.actor?.id;
  if (item?.parent?.id && item.parent.id === actorId) render();
};
hookIds.createItem = Hooks.on("createItem", refreshOnItem);
hookIds.updateItem = Hooks.on("updateItem", refreshOnItem);
hookIds.deleteItem = Hooks.on("deleteItem", refreshOnItem);

// Re-contraindre la position si la fenêtre est redimensionnée.
const onResize = () => {
  if (bar.style.display === "none") return;
  const r = bar.getBoundingClientRect();
  setPos(r.left, r.top);
};
window.addEventListener("resize", onResize);

// ── API globale + destruction propre ─────────────────────────────────────────
window[NS] = {
  render,
  destroy() {
    for (const [hook, id] of Object.entries(hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", onResize);
    bar.remove();
    delete window[NS];
    notify.info("Barre d'action fermée.");
  },
};

// ── Premier rendu ─────────────────────────────────────────────────────────────
render();
notify.info("Barre d'action activée.");
