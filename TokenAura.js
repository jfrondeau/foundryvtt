/**
 * Token Aura Region Macro — Foundry VTT v14+
 *
 * Sélectionner UN token, exécuter la macro, entrer un rayon (en unités de grille).
 * Fonctionnalités :
 *  - Crée une Region d'ÉMANATION attachée au token via createTokenEmanation :
 *    elle suit et tourne avec le token nativement (aucun hook requis).
 *  - Rayon exprimé dans les unités de la scène (ft par défaut).
 *  - Valeur par défaut = dernière valeur saisie (persistée via localStorage).
 *  - Highlight = « Covered Grid Spaces » (map sur la grille au lieu d'un cercle).
 *  - Display Measurements = affiché.
 *  - Bouton « Supprimer » pour retirer l'aura du token sans saisir de valeur.
 *  - Relancer avec le même token remplace son aura.
 *
 * ⚠️ Requiert Foundry v14+ (Scene Regions V2 : émanations, attachement,
 *    highlightMode, displayMeasurements).
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — modifier ici uniquement
// ═══════════════════════════════════════════════════════════════════════════════
const CFG = {
  namespace:   "tokenAura",   // scope des flags (repérage région ↔ token)
  defaultFeet: 10,            // valeur proposée au tout premier lancement

  // ── Apparence de la région ─────────────────────────────────────────────────
  color:               "#33bbff",  // teinte de la bordure/remplissage
  coveredGridHighlight: true,      // highlight = cases couvertes (au lieu du cercle)
  displayMeasurements:  true,      // afficher la mesure du rayon

  // ── Notifications UI ───────────────────────────────────────────────────────
  showNotifications: true,
};
// ═══════════════════════════════════════════════════════════════════════════════

const NS = CFG.namespace;
const STORE_KEY = `${NS}.lastFeet`;   // clé localStorage pour la dernière valeur

// ── Helpers notifications ────────────────────────────────────────────────────
const notify = {
  info:  (msg) => { console.log(`[Token Aura] ${msg}`);   if (CFG.showNotifications) ui.notifications.info(msg);  },
  warn:  (msg) => { console.warn(`[Token Aura] ${msg}`);  if (CFG.showNotifications) ui.notifications.warn(msg);  },
  error: (msg) => { console.error(`[Token Aura] ${msg}`); if (CFG.showNotifications) ui.notifications.error(msg); },
};

// ── Gardes ───────────────────────────────────────────────────────────────────
if (!game.user.isGM) {
  return notify.warn("Seul le MJ peut créer/modifier des régions de scène.");
}
if (typeof CONFIG.Region?.documentClass?.createTokenEmanation !== "function") {
  return notify.error("Requiert Foundry v14+ (createTokenEmanation introuvable).");
}

const selected = canvas.tokens.controlled;
if (selected.length !== 1) {
  return notify.warn("Sélectionner exactement UN token.");
}
const token = selected[0];
const scene = token.scene ?? canvas.scene;
const unitLabel = scene.grid.units || "ft";

// ── Valeur par défaut = dernière saisie (persistée via localStorage) ─────────
const lastFeet = Number(localStorage.getItem(STORE_KEY)) || CFG.defaultFeet;

// ── Dialog ───────────────────────────────────────────────────────────────────
new Dialog({
  title: `Aura — ${token.name}`,
  content: `
    <style>
      .aur { display:flex; flex-direction:column; gap:10px; padding:6px 0 }
      .aur-row { display:flex; align-items:center; gap:8px }
      .aur-row label { min-width:80px; font-weight:bold }
      #aur-feet {
        flex:1; text-align:center; font-size:1.4em; font-weight:bold;
        border:2px solid #7a7a7a; border-radius:4px; padding:4px 8px;
      }
      #aur-feet:focus { border-color:#33bbff; outline:none }
      .aur-hint { font-size:11px; color:#888; text-align:center }
    </style>
    <div class="aur">
      <div class="aur-row">
        <label>Rayon (${unitLabel})</label>
        <input id="aur-feet" type="number" min="0" step="1" value="${lastFeet}" autofocus />
      </div>
      <div class="aur-hint">L'aura est attachée au token et le suit.</div>
    </div>`,
  buttons: {
    apply:  { icon: '<i class="fas fa-circle-notch"></i>', label: "Appliquer", callback: html => applyAura(html) },
    remove: { icon: '<i class="fas fa-trash"></i>',        label: "Supprimer", callback: () => removeAura() },
    cancel: { icon: '<i class="fas fa-times"></i>',        label: "Annuler" },
  },
  default: "apply",
  render: html => {
    const input = html.find("#aur-feet")[0];
    if (!input) return;
    setTimeout(() => { input.focus(); input.select(); }, 50);
    input.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      applyAura(html);
      html.closest(".dialog").find(".close").trigger("click");
    });
  },
}, { width: 340 }).render(true);

// ── Suppression de l'aura liée au token ──────────────────────────────────────

async function removeAura() {
  const existing = scene.regions.filter(r => r.flags?.[NS]?.tokenId === token.id);
  if (!existing.length) {
    return notify.info(`Aucune aura à retirer sur "${token.name}".`);
  }
  await scene.deleteEmbeddedDocuments("Region", existing.map(r => r.id));
  notify.info(`Aura retirée de "${token.name}".`);
}

// ── Application ──────────────────────────────────────────────────────────────

async function applyAura(html) {
  const raw  = html.find("#aur-feet").val().trim();
  const feet = Number(raw);

  // 0 ou vide → supprime l'aura sans toucher à la dernière valeur mémorisée.
  if (raw === "" || feet === 0) {
    return removeAura();
  }
  if (isNaN(feet) || feet < 0) {
    return notify.error(`Rayon invalide — entrer un nombre ≥ 0 (0 supprime l'aura).`);
  }

  // Remplace : on retire d'abord toute aura déjà liée à ce token.
  const existing = scene.regions.filter(r => r.flags?.[NS]?.tokenId === token.id);
  if (existing.length) {
    await scene.deleteEmbeddedDocuments("Region", existing.map(r => r.id));
  }

  localStorage.setItem(STORE_KEY, feet);

  // Données de la région (hors elevation/shapes, gérées par l'émanation).
  const regionData = {
    name:                `Aura — ${token.name}`,
    color:               CFG.color,
    visibility:          CONST.REGION_VISIBILITY?.ALWAYS ?? 2,
    displayMeasurements: CFG.displayMeasurements,
    flags:               { [NS]: { tokenId: token.id } },
  };

  const highlightMode = CFG.coveredGridHighlight ? resolveCoveredGridMode() : undefined;
  if (highlightMode !== undefined) {
    regionData.highlightMode = highlightMode;
  } else if (CFG.coveredGridHighlight) {
    notify.warn("Mode highlight « Covered Grid Spaces » introuvable — highlight par défaut utilisé.");
  }

  // createTokenEmanation : crée la région circulaire et l'attache au token.
  const region = await CONFIG.Region.documentClass.createTokenEmanation(
    token.document,
    feet,
    regionData,
  );

  if (region) {
    notify.info(`Aura de ${feet} ${unitLabel} créée sur "${token.name}" (attachée).`);
  } else {
    notify.error("La création de l'aura a été empêchée.");
  }
}

// ── Résolution dynamique de la valeur highlightMode « cases couvertes » ──────
// L'enum n'étant pas garanti stable, on le déduit des choix du champ de schéma.

function resolveCoveredGridMode() {
  // 1) Constante directe si exposée.
  for (const key of ["REGION_HIGHLIGHT_MODES", "REGION_HIGHLIGHT_MODE"]) {
    const v = CONST?.[key]?.COVERED_GRID_SPACES;
    if (v != null) return v;
  }
  // 2) Déduction depuis les choix autorisés du champ highlightMode.
  try {
    const field = CONFIG.Region.documentClass.schema.fields.highlightMode;
    let choices = field?.choices;
    if (typeof choices === "function") choices = choices();
    if (choices) {
      const values = Array.isArray(choices) ? choices : Object.keys(choices);
      const hit = values.find(v => /cover|grid/i.test(String(v)));
      if (hit != null) return hit;
    }
  } catch (_) { /* on retombe sur undefined */ }
  return undefined;
}
