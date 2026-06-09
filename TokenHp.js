/**
 * HP Modifier Macro — Foundry VTT v11/v12/v14
 * 
 * Sélectionner un ou plusieurs tokens sur le canvas, exécuter cette macro,
 * entrer un nombre (négatif = dégâts, positif = soin), valider avec Enter ou le bouton.
 * Si le HP tombe < 1, le statut "Dead" (crâne) est automatiquement appliqué en overlay.
 * Si le HP remonte >= 1 (soin), le statut est retiré.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG_HP = {
  hpPath:    "system.attributes.hp.value",
  hpMaxPath: "system.attributes.hp.max",

  // Simple Worldbuilding System :
  // hpPath: "system.health.value",
  // hpMaxPath: "system.health.max",

  clampToMax:  true,
  clampToZero: true,

  applyDeadStatus: true,
  deadStatusId:    "dead",

  // Notifications UI (coin bas-gauche)
  // true  = afficher les notifications info / warn / error
  // false = silencieux (les erreurs bloquantes restent dans la console)
  showNotifications: true,

  // Interprétation d'un nombre sans signe (ex: "10")
  // true  = un nombre sans signe est un SOIN  (+10)  [défaut]
  // false = un nombre sans signe est un DÉGÂT (-10), forcer +10 pour soigner
  unsignedIsHeal: true,
};
// ─────────────────────────────────────────────────────────────────────────────

// Wrappers notifications — respectent CONFIG_HP.showNotifications
const notify = {
  info:  (msg) => { console.log(`[HP Modifier] ℹ️  ${msg}`);  if (CONFIG_HP.showNotifications) ui.notifications.info(msg);  },
  warn:  (msg) => { console.warn(`[HP Modifier] ⚠️  ${msg}`); if (CONFIG_HP.showNotifications) ui.notifications.warn(msg);  },
  error: (msg) => { console.error(`[HP Modifier] ❌ ${msg}`); if (CONFIG_HP.showNotifications) ui.notifications.error(msg); },
};

// ─────────────────────────────────────────────────────────────────────────────

const selectedTokens = canvas.tokens.controlled;

if (selectedTokens.length === 0) {
  return notify.warn("Aucun token sélectionné. Sélectionnez au moins un token.");
}

const tokenNames = selectedTokens.map(t => t.name).join(", ");
const plural = selectedTokens.length > 1 ? `${selectedTokens.length} tokens` : selectedTokens[0].name;

// ─── DIALOG ──────────────────────────────────────────────────────────────────
new Dialog({
  title: `Modifier HP — ${plural}`,
  content: `
    <style>
      .hp-mod-wrapper {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 6px 0;
      }
      .hp-mod-tokens {
        font-size: 11px;
        color: #888;
        font-style: italic;
        border-left: 3px solid #7a7a7a;
        padding-left: 8px;
      }
      .hp-mod-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hp-mod-row label {
        min-width: 60px;
        font-weight: bold;
      }
      #hp-delta {
        flex: 1;
        text-align: center;
        font-size: 1.4em;
        font-weight: bold;
        border: 2px solid #7a7a7a;
        border-radius: 4px;
        padding: 4px 8px;
      }
      #hp-delta:focus { border-color: #ff6400; outline: none; }
      .hp-mod-hint { font-size: 11px; color: #999; text-align: center; }
      .hp-mod-hint span { color: #c44; font-weight: bold; }
    </style>
    <div class="hp-mod-wrapper">
      <div class="hp-mod-tokens">Cibles : <strong>${tokenNames}</strong></div>
      <div class="hp-mod-row">
        <label>Δ HP</label>
        <input id="hp-delta" type="text" inputmode="numeric" placeholder="ex: -10 ou +10" autofocus />
      </div>
      <div class="hp-mod-hint">
        <span>Négatif</span> = dégâts &nbsp;|&nbsp; <span style="color:#4a4">Positif</span> = soin
        ${CONFIG_HP.unsignedIsHeal
          ? `<br><em style="color:#777">Sans signe → soin (ex: 10 = +10)</em>`
          : `<br><em style="color:#777">Sans signe → dégâts (ex: 10 = -10, taper +10 pour soigner)</em>`
        }
      </div>
    </div>
  `,
  buttons: {
    apply: {
      icon: '<i class="fas fa-heart-broken"></i>',
      label: "Appliquer",
      callback: (html) => applyHpChange(html)
    },
    cancel: {
      icon: '<i class="fas fa-times"></i>',
      label: "Annuler"
    }
  },
  default: "apply",
  render: (html) => {
    const input = html.find("#hp-delta")[0];
    if (input) {
      setTimeout(() => input.focus(), 50);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applyHpChange(html);
          html.closest(".dialog").find(".close").trigger("click");
        }
      });
    }
  }
}, { width: 300 }).render(true);

// ─── HELPERS STATUT DEAD ─────────────────────────────────────────────────────

function hasStatus(token, statusId) {
  if (token.document.statuses?.has(statusId)) return true;
  return token.actor?.effects?.some(e => e.statuses?.has(statusId) || e.flags?.core?.statusId === statusId) ?? false;
}

async function setDeadStatus(token, active) {
  const statusId = CONFIG_HP.deadStatusId;
  const effectData = CONFIG.statusEffects.find(e => e.id === statusId)
    ?? { id: statusId, name: "Dead", img: "icons/svg/skull.svg" };

  if (typeof token.document.toggleActiveEffect === "function") {
    await token.document.toggleActiveEffect(effectData, { active, overlay: active });
    return;
  }

  if (typeof token.actor?.toggleStatusEffect === "function") {
    await token.actor.toggleStatusEffect(statusId, { active, overlay: active });
    return;
  }

  const actor = token.actor;
  if (!actor) return;

  const existingEffect = actor.effects.find(
    e => e.statuses?.has(statusId) || e.flags?.core?.statusId === statusId
  );

  if (active && !existingEffect) {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: effectData.name ?? "Dead",
      img:  effectData.img  ?? "icons/svg/skull.svg",
      statuses: [statusId],
      flags: { core: { statusId, overlay: true } },
    }]);
  } else if (!active && existingEffect) {
    await existingEffect.delete();
  }
}

// ─── LOGIQUE D'APPLICATION ───────────────────────────────────────────────────
async function applyHpChange(html) {
  const rawValue = html.find("#hp-delta").val().trim();

  if (rawValue === "" || isNaN(Number(rawValue))) {
    return notify.error("Valeur invalide. Entrez un nombre entier.");
  }

  // Détecter si l'utilisateur a saisi un signe explicite
  const hasExplicitSign = rawValue.startsWith("+") || rawValue.startsWith("-");
  const absValue = parseInt(rawValue, 10); // parseInt gère +10 et -10 correctement

  // Appliquer la convention de signe selon la config
  let delta;
  if (hasExplicitSign) {
    // Signe explicite → toujours respecté tel quel
    delta = absValue;
  } else {
    // Pas de signe → interpréter selon unsignedIsHeal
    delta = CONFIG_HP.unsignedIsHeal ? Math.abs(absValue) : -Math.abs(absValue);
  }
  if (delta === 0) {
    return notify.info("Delta de 0 — aucun changement appliqué.");
  }

  const log  = [];
  const dead = [];

  for (const token of selectedTokens) {
    const actor = token.actor;
    if (!actor) {
      notify.warn(`Token "${token.name}" sans acteur, ignoré.`);
      continue;
    }

    const currentHP = foundry.utils.getProperty(actor, CONFIG_HP.hpPath);
    const maxHP     = foundry.utils.getProperty(actor, CONFIG_HP.hpMaxPath);

    if (currentHP == null) {
      notify.warn(`HP introuvable sur "${token.name}" (chemin: ${CONFIG_HP.hpPath})`);
      continue;
    }

    let newHP = currentHP + delta;
    if (CONFIG_HP.clampToZero) newHP = Math.max(0, newHP);
    if (CONFIG_HP.clampToMax && maxHP != null) newHP = Math.min(maxHP, newHP);

    await actor.update({ [CONFIG_HP.hpPath]: newHP });

    const sign = delta > 0 ? "+" : "";
    log.push(`${token.name}: ${currentHP} → ${newHP} (${sign}${delta})`);

    // ── Statut DEAD ──────────────────────────────────────────────────────────
    if (CONFIG_HP.applyDeadStatus) {
      const isDead         = newHP < 1;
      const wasAlreadyDead = hasStatus(token, CONFIG_HP.deadStatusId);

      if (isDead && !wasAlreadyDead) {
        await setDeadStatus(token, true);
        dead.push(token.name);
      } else if (!isDead && wasAlreadyDead) {
        await setDeadStatus(token, false);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
  }

  if (log.length === 0) return;

  const action = delta < 0 ? "💀 Dégâts" : "💚 Soin";
  notify.info(`${action} [${delta > 0 ? "+" : ""}${delta}] : ${log.join(" | ")}`);

  if (dead.length > 0) {
    notify.warn(`☠️ Tombe à 0 HP — statut Mort appliqué : ${dead.join(", ")}`);
  }

  console.log("[HP Modifier]", log.join("\n"));
}