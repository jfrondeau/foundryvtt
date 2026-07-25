/**
 * Template Bar Macro — Foundry VTT v14 · Système dnd5e 5.x
 *
 * Affiche une petite barre flottante avec des boutons permettant de DESSINER
 * des gabarits de sort sur la scène — via le « Template Mode » du contrôle
 * Regions de dnd5e — mais accessible d'un seul clic, y compris pour un joueur.
 *
 * Chaque bouton de forme :
 *   1) ouvre le contrôle « Regions »,
 *   2) active le bascule « templateMode »,
 *   3) sélectionne la forme (cercle / cône / anneau / ligne / émanation / rect).
 * Le joueur dessine ensuite normalement (clic-glisser = dimensionner), exactement
 * comme quand on utilise le mode gabarit natif de la barre d'outils.
 *
 * Chaque gabarit dessiné est une Region renommée selon sa forme (« Cercle [Nom] »,
 * « Cône [Nom] », …) et marquée d'un flag d'appartenance (flags.templateBar.owner).
 * La poubelle s'appuie sur ce flag (fiable, indépendant du nom) :
 *   - Joueur → supprime uniquement SES gabarits.
 *   - MJ     → supprime tous les gabarits de tous les joueurs,
 *              sans toucher aux vraies regions de la scène.
 *
 * Après avoir posé un gabarit, la couche active revient automatiquement à la
 * couche des tokens (outil « Sélection »).
 *
 * Interaction de la barre :
 *  - Clic gauche sur une forme → active le mode gabarit, puis dessiner sur la scène.
 *  - Clic sur 🗑 → supprime ses gabarits (tous, si MJ).
 *  - Poignée (⋮⋮) → glisser pour déplacer la barre (position mémorisée).
 *  - Bouton ✕    → referme la barre.
 *
 * Relancer la macro remplace proprement l'instance précédente.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — modifier ici uniquement
// ═══════════════════════════════════════════════════════════════════════════════
const CFG = {
  buttonSize: 40, // taille des boutons (px)
};
// ═══════════════════════════════════════════════════════════════════════════════

const NS = "templateBar";
const notify = {
  info: (m) => { console.log(`[Template Bar] ${m}`); },
  warn: (m) => { console.warn(`[Template Bar] ${m}`); ui.notifications.warn(m); },
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

// ── Garde : le contrôle « regions » + « templateMode » doivent exister ────────
if (!ui.controls.controls?.regions?.tools?.templateMode) {
  notify.warn("Le mode gabarit (Regions → templateMode) est introuvable. " +
              "Cette macro nécessite dnd5e 5.x sur Foundry v13+.");
}

// ── Nettoyage d'une instance précédente ──────────────────────────────────────
if (window[NS]?.destroy) window[NS].destroy();
document.querySelectorAll("body > #spell-template-bar").forEach(el => el.remove());

// ── Styles (injectés une seule fois) ─────────────────────────────────────────
const STYLE_ID = "spell-template-bar-style";
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #spell-template-bar {
      position: fixed; z-index: 70;
      display: flex; align-items: center; gap: 6px;
      padding: 4px 8px;
      background: rgba(0,0,0,0.65); border: 1px solid #7a7a7a; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      pointer-events: all; user-select: none;
    }
    #spell-template-bar .tb-handle {
      flex: 0 0 auto; cursor: grab; color: #aaa; touch-action: none;
      padding: 0 4px; font-size: 14px; line-height: 1;
    }
    #spell-template-bar .tb-handle:hover { color: #fff; }
    #spell-template-bar .tb-handle:active { cursor: grabbing; color: #ff6400; }
    #spell-template-bar .tb-label {
      font-size: 11px; color: #ddd; font-weight: bold; white-space: nowrap; margin-right: 2px;
    }
    #spell-template-bar .tb-btn {
      display: flex; align-items: center; justify-content: center;
      flex: 0 0 auto; color: #eee;
      border: 2px solid #4a90d9; border-radius: 4px; cursor: pointer;
      background: rgba(74,144,217,0.15); transition: all .1s ease;
    }
    #spell-template-bar .tb-btn:hover {
      border-color: #7ec8ff; background: rgba(126,200,255,0.3);
      color: #fff; transform: translateY(-2px);
    }
    #spell-template-bar .tb-btn.tb-active {
      border-color: #ff6400; background: rgba(255,100,0,0.3); color: #fff;
    }
    #spell-template-bar .tb-btn i { font-size: 16px; pointer-events: none; }
    #spell-template-bar .tb-trash {
      border-color: #b5484a; background: rgba(181,72,74,0.15);
    }
    #spell-template-bar .tb-trash:hover { border-color: #ff7e7e; background: rgba(255,126,126,0.3); }
    #spell-template-bar .tb-sep { width: 1px; align-self: stretch; background: #666; margin: 2px 2px; }
    #spell-template-bar .tb-close {
      flex: 0 0 auto; width: 20px; height: 20px; line-height: 18px; text-align: center;
      color: #ccc; border: 1px solid #666; border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    #spell-template-bar .tb-close:hover { color: #fff; border-color: #ff6400; }
  `;
  document.head.appendChild(style);
}

// ── Barre flottante ──────────────────────────────────────────────────────────
const POS_KEY = `${NS}.pos`;
const bar = document.createElement("div");
bar.id = "spell-template-bar";
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
  if (r && r.width) setPos(r.left + r.width / 2 - bw / 2, r.top - bh - 8);
  else setPos((window.innerWidth - bw) / 2, window.innerHeight - bh - 90);
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

// Couche à restaurer une fois le gabarit dessiné (défaut : couche des tokens).
let returnLayer = null;

// Dernière forme activée depuis la barre — sert à nommer la region créée.
let lastShape = null;

// ── Activation du mode gabarit (contrôle Regions + toggle templateMode) ───────
// Reproduit exactement le geste manuel confirmé :
//   1) ouvrir Regions, 2) activer templateMode, 3) choisir la forme.
async function activateTool(shape) {
  const regions = ui.controls.controls?.regions;
  if (!regions) { notify.warn("Contrôle « Regions » indisponible sur cette scène."); return; }

  // Mémorise la couche courante pour y revenir après le dessin.
  const current = canvas.activeLayer;
  if (current && current !== canvas.regions) returnLayer = current;

  // Mémorise la forme pour nommer la region à la création.
  lastShape = shape;

  // 1) Ouvre le contrôle Regions.
  await ui.controls.activate({ control: "regions", tool: "select" });

  // 2) Active le bascule templateMode s'il ne l'est pas déjà.
  const tm = ui.controls.control?.tools?.templateMode;
  if (tm && !tm.active) {
    tm.active = true;
    try { await tm.onChange?.(null, true); } catch (e) { console.warn("[Template Bar] templateMode onChange:", e); }
  }

  // 3) Sélectionne la forme voulue (le vrai mode de dessin).
  await ui.controls.activate({ control: "regions", tool: shape });
  ui.controls.render();

  // Reflète la sélection sur notre barre.
  bar.querySelectorAll(".tb-btn.tb-active").forEach(b => b.classList.remove("tb-active"));
  bar.querySelector(`.tb-btn[data-shape="${shape}"]`)?.classList.add("tb-active");
}

// Restaure la couche active d'avant le dessin (par défaut : couche des tokens,
// donc l'outil « Sélection »), et retire le surlignage de la barre.
function restoreLayer() {
  const target = returnLayer ?? canvas.tokens;
  returnLayer = null;
  target?.activate?.();
  bar.querySelectorAll(".tb-btn.tb-active").forEach(b => b.classList.remove("tb-active"));
}

// ── Suppression des gabarits (regions « … [NomJoueur] ») ─────────────────────
async function clearMine() {
  const scene = canvas.scene;
  if (!scene) return;

  // Marqueur fiable posé à la création (flag), avec repli sur l'ancien nom « … [Nom] »
  // pour les gabarits dessinés avant l'ajout du flag.
  const myId  = game.user.id;
  const myTag = `[${game.user.name}]`;
  const flagOwner  = (r) => r.flags?.[NS]?.owner;                             // id de l'auteur
  const endsWithTag = (r) => /\[[^\]]+\]\s*$/.test(r.name ?? "");             // repli : nom balisé
  const isTemplate = (r) => flagOwner(r) != null || endsWithTag(r);          // une region-gabarit
  const isMine     = (r) => flagOwner(r) === myId || (r.name ?? "").includes(myTag);

  // MJ : tous les gabarits de tous les joueurs. Joueur : uniquement les siens.
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

// ── Rendu de la barre ────────────────────────────────────────────────────────
const handle = document.createElement("i");
handle.className = "fas fa-grip-vertical tb-handle";
handle.dataset.tooltip = "Glisser pour déplacer la barre";
initDrag(handle);
bar.appendChild(handle);

const label = document.createElement("div");
label.className = "tb-label";
label.textContent = "Gabarits";
bar.appendChild(label);

for (const shape of SHAPES) {
  const btn = document.createElement("div");
  btn.className = "tb-btn";
  btn.dataset.shape = shape.t;
  btn.style.width = btn.style.height = `${CFG.buttonSize}px`;
  btn.dataset.tooltip = `${shape.label} — clic-glisser pour dimensionner`;
  const i = document.createElement("i");
  i.className = `fas ${shape.icon}`;
  btn.appendChild(i);
  btn.addEventListener("click", (ev) => { ev.preventDefault(); activateTool(shape.t); });
  bar.appendChild(btn);
}

// Séparateur + poubelle.
const sep = document.createElement("div");
sep.className = "tb-sep";
bar.appendChild(sep);

const trash = document.createElement("div");
trash.className = "tb-btn tb-trash";
trash.style.width = trash.style.height = `${CFG.buttonSize}px`;
trash.dataset.tooltip = game.user.isGM
  ? "Supprimer tous les gabarits (MJ)"
  : "Supprimer mes gabarits";
const trashIcon = document.createElement("i");
trashIcon.className = "fas fa-trash";
trash.appendChild(trashIcon);
trash.addEventListener("click", (ev) => { ev.preventDefault(); clearMine(); });
bar.appendChild(trash);

const close = document.createElement("div");
close.className = "tb-close";
close.textContent = "✕";
close.dataset.tooltip = "Fermer la barre de gabarits";
close.addEventListener("click", () => window[NS]?.destroy());
bar.appendChild(close);

applyPosition();

// ── Re-contraindre la position au redimensionnement ──────────────────────────
const onResize = () => {
  const r = bar.getBoundingClientRect();
  setPos(r.left, r.top);
};
window.addEventListener("resize", onResize);

// ── Retour à la couche précédente après le dessin d'un gabarit ────────────────
// Le hook createRegion se déclenche pendant le _onCreate du document (dessin +
// propagation). On diffère la bascule de couche au tick suivant pour ne pas
// interrompre ce cycle (sinon gabarit invisible / non propagé).
const hookIds = {};
hookIds.createRegion = Hooks.on("createRegion", (doc, options, userId) => {
  if (userId !== game.user.id) return;
  setTimeout(() => restoreLayer(), 50);
});

// ── Baptême + marquage des gabarits à la création ────────────────────────────
// Avant que la region soit créée, on la renomme selon la forme (« Cercle [Nom] »,
// « Cône [Nom] », …) et on y pose un flag d'appartenance. Le flag rend la
// suppression fiable (indépendante du nom, y compris côté MJ).
hookIds.preCreateRegion = Hooks.on("preCreateRegion", (doc, data, options, userId) => {
  if (userId !== game.user.id) return;
  // Ne cible que les regions dessinées en mode gabarit (pas les vraies regions).
  if (!ui.controls.controls?.regions?.tools?.templateMode?.active) return;

  // En mode gabarit, l'outil actif reste « select » : on se fie à la forme
  // cliquée sur la barre (lastShape), et on n'utilise activeTool que s'il
  // désigne réellement une forme connue.
  const activeTool = ui.controls.control?.activeTool;
  const toolName = SHAPES.some(s => s.t === activeTool) ? activeTool : lastShape;
  const label = SHAPES.find(s => s.t === toolName)?.label ?? "Gabarit";

  // Nom = forme suivie du propriétaire entre crochets, ex. « Cercle [Nom] ».
  doc.updateSource({
    name: `${label} [${game.user.name}]`,
    flags: { [NS]: { owner: game.user.id, ownerName: game.user.name } },
  });
});

// ── API globale + destruction propre ─────────────────────────────────────────
window[NS] = {
  activateTool,
  clearMine,
  destroy() {
    for (const [hook, id] of Object.entries(hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", onResize);
    bar.remove();
    delete window[NS];
    notify.info("Barre de gabarits fermée.");
  },
};

notify.info("Barre de gabarits activée.");
