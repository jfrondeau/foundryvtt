/**
 * Classe de base des barres flottantes de la suite (gabarits, combat, token).
 *
 * Factorise tout le comportement commun : mémorisation de position et d'état
 * minimisé par utilisateur, contrainte dans la fenêtre, glisser-déposer via une
 * poignée, réaction au redimensionnement et nettoyage des hooks.
 *
 * Les sous-classes fournissent l'élément racine `this.el`, `collapsedClass` et
 * `updateCollapseIcon(on)`. Chaque barre reçoit une `key` distincte (« template »,
 * « combat », « token ») : comme toutes partagent le même MODULE_ID, c'est elle qui
 * évite la collision des clés localStorage de position/minimisation entre barres.
 */
import { MODULE_ID } from "../const.js";

export class FloatingBar {
  /**
   * @param {string} key - Identifiant court de la barre (namespace localStorage).
   */
  constructor(key) {
    this.key = key;
    this.el = null;          // élément racine (aliasé this.bar / this.root dans les sous-classes)
    this.hookIds = {};
    this.onResize = this.onResize.bind(this);
  }

  get posKey() { return `${MODULE_ID}.${this.key}.pos.${game.user.id}`; }
  get collapsedKey() { return `${MODULE_ID}.${this.key}.collapsed.${game.user.id}`; }

  /**
   * Positionne la barre en coordonnées absolues, contrainte dans la fenêtre.
   * `edge` = inset minimal autorisé par rapport au bord (défaut 4px pour les
   * barres libres, afin de garder la poignée saisissable). L'ancrage passe sa
   * propre marge (0 = collée au bord).
   */
  setPos(left, top, edge = 4) {
    const bw = this.el.offsetWidth  || 200;
    const bh = this.el.offsetHeight || 40;
    left = Math.clamp(left, edge, window.innerWidth  - bw - edge);
    top  = Math.clamp(top,  edge, window.innerHeight - bh - edge);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top  = `${Math.round(top)}px`;
    this.el.style.right = this.el.style.bottom = "auto";
    this.el.style.transform = "none";
  }

  savePos() {
    const r = this.el.getBoundingClientRect();
    localStorage.setItem(this.posKey, JSON.stringify({ left: r.left, top: r.top }));
  }

  readPos() {
    try { return JSON.parse(localStorage.getItem(this.posKey)); } catch { return null; }
  }

  /** Position : dernière position mémorisée, sinon la position par défaut de la barre. */
  applyPosition() {
    const saved = this.readPos();
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      return this.setPos(saved.left, saved.top);
    }
    const { left, top } = this.defaultPosition();
    this.setPos(left, top);
  }

  /** Position par défaut si rien n'est mémorisé : centrée au-dessus de la hotbar. Surchargeable. */
  defaultPosition() {
    const hb = document.getElementById("hotbar");
    const r  = hb?.getBoundingClientRect();
    const bw = this.el.offsetWidth, bh = this.el.offsetHeight;
    if (r && r.width) return { left: r.left + r.width / 2 - bw / 2, top: r.top - bh - 8 };
    return { left: (window.innerWidth - bw) / 2, top: window.innerHeight - bh - 90 };
  }

  onResize() {
    if (!this.el) return;
    this.reflow();
  }

  /**
   * Re-place la barre après un changement de taille/fenêtre ou de minimisation.
   * Si la barre est ancrée à un bord, on la ré-ancre ; sinon on re-contraint la
   * position courante dans la fenêtre.
   */
  reflow() {
    if (this.dockSettingKey && this.getDock() !== "free") return this.applyDock();
    const r = this.el.getBoundingClientRect();
    this.setPos(r.left, r.top);
  }

  /**
   * Rend `handle` déplaçable. Pendant le glisser, la proximité d'un bord fait
   * apparaître une zone de dépôt ; au relâcher, on ancre la barre à ce bord
   * (`setDock`) ou, si on lâche au centre, on repasse en mode libre (position
   * mémorisée). Le handle reste toujours visible, y compris quand la barre est ancrée.
   */
  initDrag(handle) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const r = this.el.getBoundingClientRect();
      const offX = ev.clientX - r.left;
      const offY = ev.clientY - r.top;
      handle.setPointerCapture(ev.pointerId);
      let candidate = null;
      const onMove = (e) => {
        this.setPos(e.clientX - offX, e.clientY - offY);
        candidate = this.dockSettingKey ? this.dockCandidateAt(e.clientX, e.clientY) : null;
        this.showDropzone(candidate);
      };
      const onUp = () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this.hideDropzone();
        if (candidate) {
          this.setDock(candidate);
        } else {
          // Lâchée au centre : mode libre, position courante mémorisée.
          this.savePos();
          if (this.dockSettingKey) this.setDock("free");
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  // ── Ancrage aux bords (docking) ──────────────────────────────────────────────
  // Les sous-classes ancrables fournissent `dockSettingKey` (clé du réglage String,
  // valeurs « free » | « <edge>-<align> ») et éventuellement `defaultDock`. Les
  // barres non ancrables laissent `dockSettingKey` à null et gardent le mode libre.
  get dockSettingKey() { return null; }
  get defaultDock() { return "free"; }

  /** Ancrage courant lu depuis le réglage. */
  getDock() {
    if (!this.dockSettingKey) return "free";
    return game.settings.get(MODULE_ID, this.dockSettingKey) || this.defaultDock;
  }

  /**
   * Persiste l'ancrage dans le réglage (le menu de config et le glisser partagent
   * ainsi la même source de vérité). L'`onChange` du réglage rappelle `applyDock`.
   */
  async setDock(value) {
    const key = this.dockSettingKey;
    if (!key) return;
    if (game.settings.get(MODULE_ID, key) === value) return this.applyDock();
    await game.settings.set(MODULE_ID, key, value);
  }

  /**
   * Applique l'ancrage courant : bascule les classes d'orientation partagées et
   * positionne la barre sur le bord voulu (ou la laisse libre).
   *  - « free »            → position mémorisée (applyPosition).
   *  - « <edge>-<align> »  → collée au bord `edge`, alignée selon `align`.
   * Orientation : gauche/droite → `fb-vertical` ; haut/bas → `fb-horizontal`.
   */
  applyDock() {
    if (!this.el || this.el.style.display === "none") return;
    const dock = this.getDock();
    const docked = dock !== "free";
    const vertical = dock.startsWith("left") || dock.startsWith("right");
    this.el.classList.toggle("fb-docked", docked);
    this.el.classList.toggle("fb-vertical", vertical);
    this.el.classList.toggle("fb-horizontal", docked && !vertical);

    if (!docked) return this.applyPosition();

    // Marge à l'écran configurable (0 = collée au bord).
    const rawMargin = game.settings.get(MODULE_ID, "dockMargin");
    const m = Number.isFinite(rawMargin) ? rawMargin : 8;
    const bw = this.el.offsetWidth, bh = this.el.offsetHeight;
    const W = window.innerWidth, H = window.innerHeight;
    const [edge, align] = dock.split("-");
    let left, top;

    if (edge === "top" || edge === "bottom") {
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
    // Passe la marge d'ancrage comme borne de clamp : m = 0 → collée au bord.
    this.setPos(left, top, m);
  }

  /**
   * Bord candidat sous le pointeur pendant un glisser, sinon null. On considère
   * un bord « accroché » à moins de `EDGE` px ; l'alignement est déduit du tiers
   * d'écran survolé. Renvoie « <edge>-<align> ».
   */
  dockCandidateAt(x, y) {
    const EDGE = 40;
    const W = window.innerWidth, H = window.innerHeight;
    const third = (v, size) => (v < size / 3 ? 0 : v > (size * 2) / 3 ? 2 : 1);
    if (x <= EDGE)      return `left-${["top", "center", "bottom"][third(y, H)]}`;
    if (x >= W - EDGE)  return `right-${["top", "center", "bottom"][third(y, H)]}`;
    if (y <= EDGE)      return `top-${["left", "center", "right"][third(x, W)]}`;
    if (y >= H - EDGE)  return `bottom-${["left", "center", "right"][third(x, W)]}`;
    return null;
  }

  /** Affiche la bande de dépôt le long du bord candidat (le « layout ondrag »). */
  showDropzone(candidate) {
    if (!candidate) return this.hideDropzone();
    const zone = (this._dropzone ??= this._makeDropzone());
    const [edge] = candidate.split("-");
    const BAND = 60;
    Object.assign(zone.style, { left: "", top: "", right: "", bottom: "", width: "", height: "" });
    if (edge === "left" || edge === "right") {
      zone.style.top = "0"; zone.style.height = "100%"; zone.style.width = `${BAND}px`; zone.style[edge] = "0";
    } else {
      zone.style.left = "0"; zone.style.width = "100%"; zone.style.height = `${BAND}px`; zone.style[edge] = "0";
    }
    zone.style.display = "block";
  }

  hideDropzone() { if (this._dropzone) this._dropzone.style.display = "none"; }

  _makeDropzone() {
    const d = document.createElement("div");
    d.className = "fb-dropzone";
    document.body.appendChild(d);
    return d;
  }

  /** Crée la poignée de déplacement (icône grip), déjà rendue déplaçable via initDrag. */
  makeHandle(className, tooltip = "Glisser pour déplacer la barre") {
    const handle = document.createElement("i");
    handle.className = `fas fa-grip-vertical ${className}`;
    handle.dataset.tooltip = tooltip;
    this.initDrag(handle);
    return handle;
  }

  // ── Minimiser (état persisté par utilisateur) ───────────────────────────────
  // Les sous-classes fournissent `collapsedClass` (nom de la classe CSS) et
  // `updateCollapseIcon(on)` (met à jour l'icône/tooltip de leur bouton toggle).
  isCollapsed() { return this.el.classList.contains(this.collapsedClass); }

  toggleCollapsed() { this.setCollapsed(!this.isCollapsed()); }

  setCollapsed(on) {
    this.el.classList.toggle(this.collapsedClass, on);
    localStorage.setItem(this.collapsedKey, on ? "1" : "0");
    this.updateCollapseIcon(on);
    this.reflow(); // la largeur a changé : re-contraindre / ré-ancrer.
  }

  /** Désenregistre les hooks, retire l'écouteur de resize, supprime l'élément. */
  destroy() {
    for (const [hook, id] of Object.entries(this.hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", this.onResize);
    this._dropzone?.remove();
    this.el?.remove();
    this.constructor.instance = null;
  }
}
