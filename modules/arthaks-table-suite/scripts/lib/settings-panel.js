/**
 * Panneau de configuration générique (ApplicationV2) pour un sous-ensemble des
 * réglages du module.
 *
 * Plutôt que d'inonder la page de configuration native d'une longue liste plate,
 * chaque barre expose ses réglages via un panneau dédié (bouton « Configurer »
 * enregistré par `game.settings.registerMenu`). Le panneau réutilise les réglages
 * DÉJÀ enregistrés (mêmes `name`, `hint`, `choices`, `onChange`) : il lit/écrit
 * `game.settings`, donc chaque modification déclenche l'`onChange` d'origine et la
 * barre se met à jour en direct. Les réglages ainsi présentés sont enregistrés en
 * `config: false` pour ne plus apparaître dans la liste principale.
 */
import { MODULE_ID } from "../const.js";

export class SettingsPanel extends foundry.applications.api.ApplicationV2 {
  /** Clés de réglages (sans namespace) présentées par ce panneau. Surchargé par sous-classe. */
  static SETTINGS = [];

  static DEFAULT_OPTIONS = {
    classes: ["ats-settings-panel"],
    position: { width: 480, height: "auto" },
    window: { icon: "fa-solid fa-sliders" },
  };

  /**
   * Construit le corps du panneau : un groupe de formulaire par réglage, dans
   * l'ordre déclaré par la sous-classe. Les réglages introuvables sont ignorés.
   * @returns {HTMLElement} Le fragment racine à insérer dans la fenêtre.
   */
  async _renderHTML() {
    const root = document.createElement("div");
    root.className = "ats-settings-body";
    for (const key of this.constructor.SETTINGS) {
      const cfg = game.settings.settings.get(`${MODULE_ID}.${key}`);
      if (cfg) root.appendChild(this._renderField(key, cfg));
    }
    return root;
  }

  /** Un groupe de formulaire natif (libellé + contrôle + note d'aide). */
  _renderField(key, cfg) {
    const group = document.createElement("div");
    group.className = "form-group";

    const label = document.createElement("label");
    label.textContent = cfg.name ?? key;

    const fields = document.createElement("div");
    fields.className = "form-fields";
    fields.appendChild(this._control(key, cfg));

    group.append(label, fields);

    // Réglage à portée « monde » : seul le MJ peut l'écrire. Côté joueur on désactive
    // le contrôle (sinon game.settings.set lève une erreur) et on l'indique.
    const gmOnly = cfg.scope === "world" && !game.user.isGM;
    if (gmOnly) fields.querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = true; });

    if (cfg.hint) {
      const notes = document.createElement("p");
      notes.className = "notes";
      notes.textContent = gmOnly ? `${cfg.hint} (réglage réservé au MJ)` : cfg.hint;
      group.appendChild(notes);
    }
    return group;
  }

  /**
   * Contrôle adapté au type du réglage : select (choix), case à cocher (booléen),
   * champ numérique (nombre) ou champ texte. Chaque contrôle persiste sa valeur via
   * `game.settings.set` (l'`onChange` d'origine applique le changement en direct).
   */
  _control(key, cfg) {
    const value = game.settings.get(MODULE_ID, key);
    const commit = (v) => game.settings.set(MODULE_ID, key, v);

    if (cfg.choices && typeof cfg.choices === "object") {
      const sel = document.createElement("select");
      for (const [val, lbl] of Object.entries(cfg.choices)) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = lbl;
        if (val === value) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => commit(sel.value));
      return sel;
    }

    if (cfg.type === Boolean) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!value;
      cb.addEventListener("change", () => commit(cb.checked));
      return cb;
    }

    if (cfg.type === Number) {
      const num = document.createElement("input");
      num.type = "number";
      num.value = value ?? "";
      if (cfg.range) { num.min = cfg.range.min; num.max = cfg.range.max; num.step = cfg.range.step ?? 1; }
      num.addEventListener("change", () => {
        const raw = num.value.trim();
        // Champ vidé → revenir au défaut : Number("") vaut 0 et écraserait la valeur par 0.
        if (raw === "") { commit(cfg.default); num.value = cfg.default ?? ""; return; }
        const n = Number(raw);
        commit(Number.isFinite(n) ? n : cfg.default);
      });
      return num;
    }

    const txt = document.createElement("input");
    txt.type = "text";
    txt.value = value ?? "";
    txt.addEventListener("change", () => commit(txt.value));
    return txt;
  }

  /** Insère le contenu construit dans la zone de fenêtre. */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }
}

/**
 * Fabrique une sous-classe de `SettingsPanel` prête pour `registerMenu`.
 * @param {string} id     Identifiant unique de l'application (DOM / instance).
 * @param {string} title  Titre de la fenêtre.
 * @param {string} icon   Icône FontAwesome de la fenêtre.
 * @param {string[]} keys Clés de réglages présentées, dans l'ordre d'affichage.
 * @returns {typeof SettingsPanel}
 */
export function makeSettingsPanel(id, title, icon, keys) {
  return class extends SettingsPanel {
    static SETTINGS = keys;
    static DEFAULT_OPTIONS = {
      id,
      classes: ["ats-settings-panel"],
      position: { width: 480, height: "auto" },
      window: { title, icon },
    };
  };
}
