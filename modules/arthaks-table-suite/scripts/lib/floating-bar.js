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

  /** Positionne la barre en coordonnées absolues, contrainte dans la fenêtre. */
  setPos(left, top) {
    const bw = this.el.offsetWidth  || 200;
    const bh = this.el.offsetHeight || 40;
    left = Math.clamp(left, 4, window.innerWidth  - bw - 4);
    top  = Math.clamp(top,  4, window.innerHeight - bh - 4);
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

  /** Re-place la barre après un changement de taille/fenêtre. Défaut : re-contraindre la position courante. */
  reflow() {
    const r = this.el.getBoundingClientRect();
    this.setPos(r.left, r.top);
  }

  /** Rend `handle` déplaçable : glisser repositionne la barre, relâcher mémorise. */
  initDrag(handle) {
    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const r = this.el.getBoundingClientRect();
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
    this.el?.remove();
    this.constructor.instance = null;
  }
}
