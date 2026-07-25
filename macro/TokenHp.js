/**
 * HP Modifier Macro — Foundry VTT v11/v12/v14
 *
 * Sélectionner un ou plusieurs tokens, exécuter la macro, entrer un delta HP.
 * Fonctionnalités :
 *  - Soin / dégâts sur tous les tokens sélectionnés
 *  - Statut "Dead" auto si HP < 1, retiré si HP remonte
 *  - Tint progressif blanc → rouge à partir du seuil bloodied
 *  - Rotation du token à la mort, annulée au soin
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — modifier ici uniquement
// ═══════════════════════════════════════════════════════════════════════════════
const CFG = {
  // ── Chemins HP (selon le système de jeu) ───────────────────────────────────
  hpPath:    "system.attributes.hp.value",  // dnd5e, pf2e, la plupart des systèmes
  hpMaxPath: "system.attributes.hp.max",
  // Simple Worldbuilding : "system.health.value" / "system.health.max"

  // ── Comportement HP ────────────────────────────────────────────────────────
  clampToZero: true,   // HP ne descend pas sous 0
  clampToMax:  true,   // HP ne monte pas au-dessus du max

  // ── Saisie sans signe explicite (ex: "10") ─────────────────────────────────
  // false = dégâts  → "10" enlève 10 HP, "+10" en ajoute  [défaut]
  // true  = soin    → "10" ajoute 10 HP, "-10" en enlève
  unsignedIsHeal: false,

  // ── Statut mort ────────────────────────────────────────────────────────────
  applyDeadStatus: true,
  deadStatusId:    "dead",

  // ── Tint rouge progressif dès le seuil bloodied ────────────────────────────
  bloodiedTint:      true,
  bloodiedThreshold: 0.5,        // 0.5 = 50 % HP restants
  tintColorFull:     "#ffffff",  // aucun tint (HP plein)
  tintColorDead:     "#ff0000",  // rouge vif (0 HP)

  // ── Rotation à la mort ─────────────────────────────────────────────────────
  rotateOnDeath: true,
  deathRotation: 90,   // degrés ; annulé (-90) si le token est soigné

  // ── Notifications UI ───────────────────────────────────────────────────────
  // false = silencieux (tout reste dans la console)
  showNotifications: true,
};
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helpers notifications ────────────────────────────────────────────────────
const notify = {
  info:  (msg) => { console.log(`[HP Modifier] ${msg}`);   if (CFG.showNotifications) ui.notifications.info(msg);  },
  warn:  (msg) => { console.warn(`[HP Modifier] ${msg}`);  if (CFG.showNotifications) ui.notifications.warn(msg);  },
  error: (msg) => { console.error(`[HP Modifier] ${msg}`); if (CFG.showNotifications) ui.notifications.error(msg); },
};

// ── Garde : tokens sélectionnés ──────────────────────────────────────────────
const selectedTokens = canvas.tokens.controlled;
if (selectedTokens.length === 0) {
  return notify.warn("Aucun token sélectionné.");
}

// ── Dialog ───────────────────────────────────────────────────────────────────
const targetLabel = selectedTokens.length > 1
  ? `${selectedTokens.length} tokens`
  : selectedTokens[0].name;

const hintText = CFG.unsignedIsHeal
  ? `Sans signe → soin &nbsp;(10 = +10)`
  : `Sans signe → dégâts (10 = −10, taper +10 pour soigner)`;

new Dialog({
  title: `Modifier HP — ${targetLabel}`,
  content: `
    <style>
      .hpm { display:flex; flex-direction:column; gap:10px; padding:6px 0 }
      .hpm-targets { font-size:11px; color:#888; font-style:italic; border-left:3px solid #666; padding-left:8px }
      .hpm-row { display:flex; align-items:center; gap:8px }
      .hpm-row label { min-width:55px; font-weight:bold }
      #hpm-delta {
        flex:1; text-align:center; font-size:1.4em; font-weight:bold;
        border:2px solid #7a7a7a; border-radius:4px; padding:4px 8px;
      }
      #hpm-delta:focus { border-color:#ff6400; outline:none }
      .hpm-hint { font-size:11px; color:#888; text-align:center }
      .hpm-hint b { color:#c44 }
    </style>
    <div class="hpm">
      <div class="hpm-targets">Cibles : <strong>${selectedTokens.map(t => t.name).join(", ")}</strong></div>
      <div class="hpm-row">
        <label>Δ HP</label>
        <input id="hpm-delta" type="text" inputmode="numeric" placeholder="ex: 8 ou +8 ou -8" autofocus />
      </div>
      <div class="hpm-hint"><b>−</b> dégâts &nbsp;|&nbsp; <b style="color:#4a4">+</b> soin &nbsp;·&nbsp; ${hintText}</div>
    </div>`,
  buttons: {
    apply:  { icon: '<i class="fas fa-heart-broken"></i>', label: "Appliquer", callback: html => applyHpChange(html) },
    cancel: { icon: '<i class="fas fa-times"></i>',        label: "Annuler" },
  },
  default: "apply",
  render: html => {
    const input = html.find("#hpm-delta")[0];
    if (!input) return;
    setTimeout(() => input.focus(), 50);
    input.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      applyHpChange(html);
      html.closest(".dialog").find(".close").trigger("click");
    });
  },
}, { width: 320 }).render(true);

// ── Statut Dead ──────────────────────────────────────────────────────────────

function hasDeadStatus(token) {
  if (token.document.statuses?.has(CFG.deadStatusId)) return true;
  return token.actor?.effects?.some(
    e => e.statuses?.has(CFG.deadStatusId) || e.flags?.core?.statusId === CFG.deadStatusId
  ) ?? false;
}

async function setDeadStatus(token, active) {
  const effectData = CONFIG.statusEffects.find(e => e.id === CFG.deadStatusId)
    ?? { id: CFG.deadStatusId, name: "Dead", img: "icons/svg/skull.svg" };

  // v12 / v14
  if (typeof token.document.toggleActiveEffect === "function") {
    await token.document.toggleActiveEffect(effectData, { active, overlay: active });
    return;
  }
  // v11
  if (typeof token.actor?.toggleStatusEffect === "function") {
    await token.actor.toggleStatusEffect(CFG.deadStatusId, { active, overlay: active });
    return;
  }
  // Fallback universel
  const actor = token.actor;
  if (!actor) return;
  const existing = actor.effects.find(
    e => e.statuses?.has(CFG.deadStatusId) || e.flags?.core?.statusId === CFG.deadStatusId
  );
  if (active && !existing) {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: effectData.name ?? "Dead",
      img:  effectData.img  ?? "icons/svg/skull.svg",
      statuses: [CFG.deadStatusId],
      flags: { core: { statusId: CFG.deadStatusId, overlay: true } },
    }]);
  } else if (!active && existing) {
    await existing.delete();
  }
}

// ── Tint & Rotation ──────────────────────────────────────────────────────────

function lerpColor(a, b, t) {
  const p = s => [parseInt(s.slice(1,3),16), parseInt(s.slice(3,5),16), parseInt(s.slice(5,7),16)];
  const [ar,ag,ab] = p(a), [br,bg,bb] = p(b);
  const h = n => Math.round(n).toString(16).padStart(2,"0");
  return `#${h(ar+(br-ar)*t)}${h(ag+(bg-ag)*t)}${h(ab+(bb-ab)*t)}`;
}

async function updateTokenVisuals(token, newHP, maxHP) {
  const updates = {};

  if (CFG.bloodiedTint && maxHP > 0) {
    const ratio = newHP / maxHP;
    updates["texture.tint"] = ratio >= CFG.bloodiedThreshold
      ? CFG.tintColorFull
      : lerpColor(CFG.tintColorFull, CFG.tintColorDead, 1 - ratio / CFG.bloodiedThreshold);
  }

  if (CFG.rotateOnDeath) {
    if (newHP < 1) {
      updates.rotation = CFG.deathRotation;
    } else if (token.document.rotation === CFG.deathRotation) {
      updates.rotation = token.document.rotation - CFG.deathRotation;
    }
  }

  if (Object.keys(updates).length) await token.document.update(updates);
}

// ── Application principale ───────────────────────────────────────────────────

async function applyHpChange(html) {
  const raw = html.find("#hpm-delta").val().trim();

  if (!raw || isNaN(Number(raw))) {
    return notify.error("Valeur invalide — entrez un nombre entier (ex: 8, -8, +8).");
  }

  const hasSign = raw.startsWith("+") || raw.startsWith("-");
  const parsed  = parseInt(raw, 10);
  const delta   = hasSign ? parsed : (CFG.unsignedIsHeal ? Math.abs(parsed) : -Math.abs(parsed));

  if (delta === 0) return notify.info("Delta 0 — aucun changement.");

  const log  = [];
  const dead = [];

  for (const token of selectedTokens) {
    const actor = token.actor;
    if (!actor) { notify.warn(`"${token.name}" sans acteur, ignoré.`); continue; }

    const currentHP = foundry.utils.getProperty(actor, CFG.hpPath);
    const maxHP     = foundry.utils.getProperty(actor, CFG.hpMaxPath);

    if (currentHP == null) {
      notify.warn(`HP introuvable sur "${token.name}" (${CFG.hpPath})`);
      continue;
    }

    let newHP = currentHP + delta;
    if (CFG.clampToZero) newHP = Math.max(0, newHP);
    if (CFG.clampToMax && maxHP != null) newHP = Math.min(maxHP, newHP);

    await actor.update({ [CFG.hpPath]: newHP });
    await updateTokenVisuals(token, newHP, maxHP ?? 0);

    log.push(`${token.name}: ${currentHP} → ${newHP} (${delta > 0 ? "+" : ""}${delta})`);

    if (CFG.applyDeadStatus) {
      const dying  = newHP < 1;
      const wasDead = hasDeadStatus(token);
      if (dying && !wasDead)  { await setDeadStatus(token, true);  dead.push(token.name); }
      else if (!dying && wasDead) await setDeadStatus(token, false);
    }
  }

  if (!log.length) return;

  notify.info(`${delta < 0 ? "💀 Dégâts" : "💚 Soin"} [${delta > 0 ? "+" : ""}${delta}] : ${log.join(" | ")}`);
  if (dead.length) notify.warn(`☠️ Mort : ${dead.join(", ")}`);
  console.log("[HP Modifier]\n" + log.join("\n"));
}