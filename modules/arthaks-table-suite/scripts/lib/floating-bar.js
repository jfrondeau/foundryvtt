/**
 * Classe de base des barres flottantes de la suite (gabarits, combat, token).
 *
 * Factorise tout le comportement commun : mémorisation de position et d'état
 * minimisé par utilisateur, contrainte dans la fenêtre, glisser-déposer via une
 * poignée, réaction au redimensionnement et nettoyage des hooks.
 *
 * Les sous-classes exposent l'élément racine via `this.el`. Chaque barre reçoit une
 * `key` distincte (« template », « combat », « token ») afin que les clés
 * localStorage de position/minimisation ne se chevauchent PAS entre barres — les
 * anciennes barres, quand elles étaient des modules séparés, avaient chacune leur
 * propre MODULE_ID ; ici elles partagent le même, d'où le sous-espace par `key`.
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

  clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  /** Positionne la barre en coordonnées absolues, contrainte dans la fenêtre. */
  setPos(left, top) {
    const bw = this.el.offsetWidth  || 200;
    const bh = this.el.offsetHeight || 40;
    left = this.clamp(left, 4, window.innerWidth  - bw - 4);
    top  = this.clamp(top,  4, window.innerHeight - bh - 4);
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

  /** Position par défaut : dernière position mémorisée, sinon au-dessus de la hotbar. */
  applyPosition() {
    const saved = this.readPos();
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      return this.setPos(saved.left, saved.top);
    }
    const hb = document.getElementById("hotbar");
    const r  = hb?.getBoundingClientRect();
    const bw = this.el.offsetWidth, bh = this.el.offsetHeight;
    if (r && r.width) this.setPos(r.left + r.width / 2 - bw / 2, r.top - bh - 8);
    else this.setPos((window.innerWidth - bw) / 2, window.innerHeight - bh - 90);
  }

  onResize() {
    if (!this.el) return;
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

  /** Désenregistre les hooks, retire l'écouteur de resize, supprime l'élément. */
  destroy() {
    for (const [hook, id] of Object.entries(this.hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", this.onResize);
    this.el?.remove();
    this.constructor.instance = null;
  }
}
