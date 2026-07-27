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
   * Registre de toutes les barres vivantes (toutes sous-classes confondues). Sert à
   * l'empilement : une barre ancrée à un bord se décale au-delà des autres barres
   * ancrées au même bord/alignement (voir stackOffset / reflowDocked).
   */
  static instances = new Set();

  /** Garde de ré-entrance de reflowDocked (évite la récursion de la cascade). */
  static _reflowing = false;

  /** Compteur de rangs d'arrivée (empilement). Voir nextSeq. */
  static _seqCounter = 0;

  /**
   * Alloue un rang d'arrivée STRICTEMENT croissant et unique (base = horloge, pour
   * rester au-dessus des seq déjà persistés d'une session précédente). Un seq plus
   * grand = arrivé plus tard = s'empile au-dessus des barres déjà présentes sur le bord.
   */
  static nextSeq() {
    FloatingBar._seqCounter = Math.max(FloatingBar._seqCounter + 1, Date.now());
    return FloatingBar._seqCounter;
  }

  /**
   * @param {string} key - Identifiant court de la barre (namespace localStorage).
   */
  constructor(key) {
    this.key = key;
    this.el = null;          // élément racine (aliasé this.bar / this.root dans les sous-classes)
    this.hookIds = {};
    this.onResize = this.onResize.bind(this);
    FloatingBar.instances.add(this);
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
    // Le coin haut-gauche (la poignée) reste toujours visible : si la barre est plus
    // large/haute que l'espace utile, on privilégie le bord gauche/haut plutôt que de
    // la pousser hors écran (Math.max borne le max à `edge` quand min > max).
    const maxLeft = Math.max(edge, this.usableRight() - bw - edge);
    const maxTop  = Math.max(edge, window.innerHeight - bh - edge);
    left = Math.clamp(left, edge, maxLeft);
    top  = Math.clamp(top,  edge, maxTop);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top  = `${Math.round(top)}px`;
    this.el.style.right = this.el.style.bottom = "auto";
    this.el.style.transform = "none";
  }

  /**
   * Bord droit utilisable : la sidebar de Foundry (chat, combat…) est exclue pour
   * que les barres ne la recouvrent jamais. Quand la sidebar est visible et ancrée
   * dans la moitié droite de l'écran, le bord utile s'arrête à son bord gauche ;
   * sinon on prend toute la largeur de la fenêtre. Suit son ouverture/fermeture
   * (voir attachViewportHandlers).
   */
  usableRight() {
    const W = window.innerWidth;
    const r = document.getElementById("sidebar")?.getBoundingClientRect();
    if (r && r.width > 0 && r.left > W / 2) return r.left;
    return W;
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
   * Branche la barre sur les changements de mise en page : redimensionnement de la
   * fenêtre + ouverture/fermeture de la sidebar (chat…). On observe directement la
   * largeur de `#sidebar` via ResizeObserver plutôt qu'un hook Foundry précis : ça
   * suit toute la transition et reste robuste entre versions. À appeler depuis
   * l'init de chaque sous-classe ; `destroy()` nettoie l'écouteur et l'observateur.
   */
  attachViewportHandlers() {
    window.addEventListener("resize", this.onResize);
    const sb = document.getElementById("sidebar");
    if (sb && "ResizeObserver" in window) {
      this._sidebarRO = new ResizeObserver(() => this.onResize());
      this._sidebarRO.observe(sb);
    }
  }

  /**
   * Re-place la barre après un changement de taille/fenêtre ou de minimisation.
   * Si la barre est ancrée à un bord, on la ré-ancre ; sinon on re-contraint la
   * position courante dans la fenêtre.
   */
  reflow() {
    this.constrainSize();
    if (this.dockSettingKey && this.isDocked()) return this.applyDock();
    const r = this.el.getBoundingClientRect();
    this.setPos(r.left, r.top);
  }

  /**
   * Point d'extension : plafonne la taille de la barre à l'espace utile pour qu'elle
   * ne dépasse jamais (sa zone de contenu défile alors au lieu de s'allonger). No-op
   * par défaut ; surchargé par les barres susceptibles de déborder (token). Appelé
   * avant tout (re)positionnement, quand les dimensions viennent d'être recalculées.
   */
  constrainSize() {}

  /**
   * Rend `handle` déplaçable. Pendant le glisser, la proximité d'un bord fait
   * apparaître une zone de dépôt ; au relâcher, on ancre la barre à ce bord (bord +
   * position continue le long du bord + rang d'arrivée `seq`, pour l'empilement
   * magnétique) ou, si on lâche au centre, on repasse en mode libre (position
   * mémorisée). Le handle reste toujours visible, y compris quand la barre est ancrée.
   */
  initDrag(handle) {
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return; // seul le bouton gauche déplace (le droit ouvre les réglages)
      ev.preventDefault();
      const r = this.el.getBoundingClientRect();
      const offX = ev.clientX - r.left;
      const offY = ev.clientY - r.top;
      handle.setPointerCapture(ev.pointerId);
      let candidate = null;  // bord visé
      let magnet = null;     // barre voisine visée (empilement magnétique)
      let engaged = null;    // bord « collant » engagé (hystérésis anti-bascule au coin)
      const onMove = (e) => {
        this.setPos(e.clientX - offX, e.clientY - offY); // suit le pointeur
        magnet = null;
        candidate = null;
        if (this.dockSettingKey) {
          const nearEdge = this.dockCandidateAt(e.clientX, e.clientY); // bord d'écran sous le pointeur
          const near = this._nearestDockedBar();                       // barre ancrée proche
          const dockable = nearEdge !== null || near !== null;
          if (engaged && dockable) {
            // Bord COLLANT : une fois engagé, on NE change JAMAIS de bord en cours de glisser
            // (ni par la hauteur au coin, ni par une barre voisine sur un autre bord).
            candidate = engaged;
          } else if (dockable) {
            // (Ré)engagement depuis le centre : bord d'écran sous le pointeur, sinon celui
            // de la barre proche.
            candidate = engaged = nearEdge ?? near.getEdge();
          } else {
            candidate = engaged = null; // revenu au centre → libre
          }
          // Aimant de POSITION : n'adopter la position d'une barre que si elle est sur le
          // bord ENGAGÉ (empilement sur le même bord). Jamais de changement de bord ici.
          magnet = (candidate && near && near.getEdge() === candidate) ? near : null;
          if (candidate && !magnet) {
            const r = this.el.getBoundingClientRect();
            const s = this.snapParallel(candidate, r.left, r.top);
            if (s.left !== r.left || s.top !== r.top) this.setPos(s.left, s.top);
          }
        }
        this.showDropzone(candidate);
      };
      const onUp = () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this.hideDropzone();
        if (candidate) {
          // Position parallèle CONTINUE = fraction du coin avant de la barre. Si on rejoint
          // une barre aimantée, on ADOPTE sa position parallèle → chevauchement → empilement
          // automatique juste à côté. `seq` = maintenant → nouvelle venue (s'empile au-delà).
          const horizontalEdge = candidate === "top" || candidate === "bottom";
          const span = horizontalEdge ? this.usableRight() : window.innerHeight;
          const ref = magnet ? magnet.el.getBoundingClientRect() : this.el.getBoundingClientRect();
          const start = horizontalEdge ? ref.left : ref.top;
          this.writeDockState({ pos: Math.clamp(start / span, 0, 1), seq: FloatingBar.nextSeq() });
          this.setEdge(candidate);
        } else {
          // Lâchée au centre : mode libre, position courante mémorisée.
          this.savePos();
          if (this.dockSettingKey) this.setEdge("free");
        }
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  // ── Ancrage aux bords (docking) ──────────────────────────────────────────────
  // Deux dimensions INDÉPENDANTES, persistées côté client (réglages du module) :
  //   • BORD  (`dockSettingKey`)              : « free » | top | bottom | left | right.
  //   • ORIENTATION (`orientSettingKey`, opt.) : « h » | « v », bascule via le bouton ↻.
  //     Sans clé d'orientation (ex. combat), l'orientation est DÉDUITE du bord
  //     (gauche/droite → vertical, haut/bas → horizontal) — comportement hérité.
  // La position CONTINUE le long du bord (fraction) et l'ordre d'arrivée (`seq`, pour
  // la priorité d'empilement) sont mémorisés en localStorage (posés au glisser). Les
  // barres sans `dockSettingKey` restent toujours libres.
  get dockSettingKey() { return null; }
  get orientSettingKey() { return null; }
  get defaultEdge() { return "free"; }
  get defaultOrientation() { return "h"; }

  /** Clé localStorage de l'état d'ancrage continu { pos, seq } (par utilisateur). */
  get dockStateKey() { return `${MODULE_ID}.${this.key}.dock.${game.user.id}`; }

  /** Normalise une valeur de bord, en absorbant les valeurs héritées (« bottom-center »…). */
  _normalizeEdge(v) {
    if (!v || v === "free") return "free";
    const edge = String(v).split("-")[0];
    return ["top", "bottom", "left", "right"].includes(edge) ? edge : "free";
  }

  /** Bord courant : « free » | top | bottom | left | right. */
  getEdge() {
    if (!this.dockSettingKey) return "free";
    return this._normalizeEdge(game.settings.get(MODULE_ID, this.dockSettingKey) || this.defaultEdge);
  }

  /** Orientation courante « h »/« v » : explicite si `orientSettingKey`, sinon déduite du bord. */
  getOrientation() {
    if (this.orientSettingKey) {
      const o = game.settings.get(MODULE_ID, this.orientSettingKey);
      if (o === "h" || o === "v") return o;
    }
    const edge = this.getEdge();
    return (edge === "left" || edge === "right") ? "v" : "h";
  }

  isDocked() { return this.getEdge() !== "free"; }

  readDockState() { try { return JSON.parse(localStorage.getItem(this.dockStateKey)) ?? {}; } catch { return {}; } }
  writeDockState(patch) { localStorage.setItem(this.dockStateKey, JSON.stringify({ ...this.readDockState(), ...patch })); }
  /**
   * Coordonnée (px) du coin AVANT de la barre le long de l'axe parallèle au bord.
   * Position CONTINUE mémorisée en fraction `pos` ; à défaut, centrée. On ancre ce coin
   * (celui de la poignée), pas le centre : ainsi la poignée ne bouge pas quand la barre
   * change de taille (repli). `parSpan`/`parSize` = étendue de l'axe parallèle et de la barre.
   */
  dockParStart(parSpan, parSize) {
    const p = this.readDockState().pos;
    return Number.isFinite(p) ? p * parSpan : (parSpan - parSize) / 2;
  }
  /** Rang d'arrivée : plus petit = arrivé avant = garde sa place (priorité d'empilement). */
  dockSeq() { const s = this.readDockState().seq; return Number.isFinite(s) ? s : 0; }

  /** Persiste le bord (source de vérité partagée avec le panneau). onChange → applyDock. */
  async setEdge(edge) {
    const key = this.dockSettingKey;
    if (!key) return;
    // Même bord (ex. re-lâchée le long du même bord, seule la position change) : on
    // ré-empile quand même, car l'onChange du réglage ne se déclenchera pas.
    if (game.settings.get(MODULE_ID, key) === edge) return FloatingBar.reflowDocked();
    await game.settings.set(MODULE_ID, key, edge);
  }

  /** Persiste l'orientation (si la barre en a une explicite). onChange → applyDock. */
  async setOrientation(o) {
    const key = this.orientSettingKey;
    if (!key) return;
    if (game.settings.get(MODULE_ID, key) === o) return this.applyDock();
    await game.settings.set(MODULE_ID, key, o);
  }

  /** Bouton ↻ : bascule horizontale / verticale (ne change PAS l'ordre d'empilement). */
  toggleOrientation() { this.setOrientation(this.getOrientation() === "h" ? "v" : "h"); }

  /**
   * Applique l'ancrage courant : classes d'orientation + position.
   *  - « free » → position libre mémorisée (applyPosition).
   *  - bord     → collée au bord ; position CONTINUE le long du bord (coin avant `pos`).
   *               L'empilement n'agit QUE lorsque des barres se CHEVAUCHENT : soit
   *               perpendiculairement au bord (`_perpStackOffset`), soit le long du bord
   *               (`_resolveParallel`). Lâchée à un endroit libre → elle y reste.
   * Orientation (docké) : `fb-vertical` si « v », sinon `fb-horizontal`.
   */
  applyDock() {
    if (!this.el || this.el.style.display === "none") return;
    this.constrainSize();
    const edge = this.getEdge();
    const docked = edge !== "free";
    const vertical = docked && this.getOrientation() === "v";
    this.el.classList.toggle("fb-docked", docked);
    this.el.classList.toggle("fb-vertical", vertical);
    this.el.classList.toggle("fb-horizontal", docked && !vertical);

    if (!docked) {
      this.applyPosition();
      return FloatingBar.reflowDocked();
    }
    if (!Number.isFinite(this.readDockState().seq)) this.writeDockState({ seq: FloatingBar.nextSeq() });

    const m = this.dockMargin();
    const bw = this.el.offsetWidth, bh = this.el.offsetHeight;
    const W = this.usableRight(), H = window.innerHeight;
    const horizontalEdge = edge === "top" || edge === "bottom";
    const thick = this.getOrientation() === "v" ? "x" : "y"; // axe d'épaisseur (empilement)
    const perpAxis = horizontalEdge ? "y" : "x";             // axe perpendiculaire au bord
    const parSpan = horizontalEdge ? W : H;
    const parSize = horizontalEdge ? bw : bh;

    // Position PARALLÈLE : continue (coin avant). Si l'empilement se fait LE LONG du bord
    // (épaisseur = axe parallèle, ex. 2 barres horizontales à gauche), on résout les
    // collisions ; sinon la valeur continue est conservée telle quelle.
    let parStart = this.dockParStart(parSpan, parSize);
    if (thick !== perpAxis) parStart = this._resolveParallel(edge, parStart, parSize);

    // Position PERPENDICULAIRE : collée au bord (hotbar au bas). Si l'empilement se fait
    // PERPENDICULAIREMENT au bord (épaisseur = perpendiculaire, ex. 2 barres en bas), on
    // décale vers l'intérieur des barres antérieures qui la chevauchent.
    let perpCoord;
    if (horizontalEdge) {
      perpCoord = edge === "top" ? m : H - bh - m;
      if (edge === "bottom") {
        const hb = document.getElementById("hotbar")?.getBoundingClientRect();
        if (hb && hb.width && parStart < hb.right && (parStart + bw) > hb.left) perpCoord = hb.top - bh - m;
      }
    } else {
      perpCoord = edge === "left" ? m : W - bw - m;
    }
    if (thick === perpAxis) {
      const off = this._perpStackOffset(edge, parStart, parSize);
      perpCoord += (edge === "bottom" || edge === "right") ? -off : +off;
    }

    const left = horizontalEdge ? parStart : perpCoord;
    const top = horizontalEdge ? perpCoord : parStart;
    this.setPos(left, top, m); // clamp final dans la fenêtre (m = 0 → collée au bord)
    FloatingBar.reflowDocked();
  }

  /** Marge d'ancrage à l'écran (réglage « dockMargin », défaut 8px). */
  dockMargin() {
    const raw = game.settings.get(MODULE_ID, "dockMargin");
    return Number.isFinite(raw) ? raw : 8;
  }

  /**
   * Empilement PERPENDICULAIRE au bord : somme des tailles (+ marge) des barres du même
   * bord/orientation arrivées AVANT (`seq` plus petit) qui CHEVAUCHENT cette barre sur
   * l'axe parallèle (elles se superposeraient). Décale la barre vers l'intérieur. Sticky :
   * recalculé à chaque reflow, donc la barre suit si la voisine change de taille.
   */
  _perpStackOffset(edge, parStart, parSize) {
    const horizontalEdge = edge === "top" || edge === "bottom";
    const mySeq = this.dockSeq(), myEnd = parStart + parSize, m = this.dockMargin();
    let offset = 0;
    for (const other of FloatingBar.instances) {
      if (other === this || !other.el || other.el.style.display === "none") continue;
      if (!other.dockSettingKey || other.getEdge() !== edge) continue;
      if (other.getOrientation() !== this.getOrientation()) continue;
      if (other.dockSeq() >= mySeq) continue;
      const o = other.el.getBoundingClientRect();
      const [os, oe] = horizontalEdge ? [o.left, o.right] : [o.top, o.bottom]; // étendue parallèle
      if (!(parStart < oe && os < myEnd)) continue; // pas de chevauchement parallèle → pas d'empilement
      offset += (horizontalEdge ? o.height : o.width) + m;
    }
    return offset;
  }

  /**
   * Résout les collisions LE LONG du bord (épaisseur = axe parallèle, ex. 2 barres
   * horizontales sur le bord gauche) : part de la position continue voulue et repousse la
   * barre juste après chaque barre antérieure (`seq` plus petit) qu'elle chevauche. Lâchée
   * à un endroit libre → garde sa position ; posée sur une autre → se colle dessous. Sticky.
   */
  _resolveParallel(edge, desiredStart, size) {
    const horizontalEdge = edge === "top" || edge === "bottom";
    const mySeq = this.dockSeq(), m = this.dockMargin();
    const par = (o) => (horizontalEdge ? [o.left, o.right] : [o.top, o.bottom]);
    const earlier = [...FloatingBar.instances]
      .filter((b) => b !== this && b.el && b.el.style.display !== "none" &&
                     b.dockSettingKey && b.getEdge() === edge &&
                     b.getOrientation() === this.getOrientation() && b.dockSeq() < mySeq)
      .map((b) => par(b.el.getBoundingClientRect()))
      .sort((a, b) => a[0] - b[0]);
    let start = desiredStart;
    for (const [os, oe] of earlier) {
      if (start < oe + m && start + size > os - m) start = oe + m; // chevauche → juste dessous
    }
    return start;
  }

  /**
   * Ré-ancre toutes les barres ancrées et visibles (recalcule l'empilement). Appelée
   * après tout changement de géométrie (ancrage, taille, minimisation, resize, ou
   * masquage d'une barre). La garde `_reflowing` neutralise la récursion : chaque
   * applyDock rappelle reflowDocked, mais seule la première passe fait le tour.
   */
  static reflowDocked() {
    if (FloatingBar._reflowing) return;
    FloatingBar._reflowing = true;
    try {
      const docked = [...FloatingBar.instances].filter(
        (b) => b.el && b.el.style.display !== "none" && b.dockSettingKey && b.getEdge() !== "free",
      );
      // Rang d'arrivée pour toutes (les ancrages via le panneau n'en posent pas), PUIS
      // disposition dans l'ORDRE d'arrivée : les antérieures placées d'abord, les suivantes
      // se résolvent contre leur position déjà calculée (empilement / collision).
      for (const bar of docked) {
        if (!Number.isFinite(bar.readDockState().seq)) bar.writeDockState({ seq: FloatingBar.nextSeq() });
      }
      docked.sort((a, b) => a.dockSeq() - b.dockSeq());
      for (const bar of docked) bar.applyDock();
    } finally {
      FloatingBar._reflowing = false;
    }
  }

  /**
   * Bord candidat sous le pointeur pendant un glisser, sinon null. On retient le bord
   * le PLUS PROCHE du pointeur (à moins de EDGE px) : au coin, c'est donc le bord dont
   * on est réellement le plus près. L'orientation ne dépend PLUS du bord (bouton ↻) ;
   * la position le long du bord est continue (posée séparément au relâcher).
   */
  dockCandidateAt(x, y) {
    const EDGE = 40;
    const W = window.innerWidth, H = window.innerHeight;
    const d = { left: x, right: W - x, top: y, bottom: H - y };
    const [edge, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
    return dist <= EDGE ? edge : null;
  }

  /**
   * Barre ancrée la plus proche de la barre traînée (ou null) : chevauchement sur l'axe
   * parallèle à son bord, écart perpendiculaire < MAGNET px. Sert à l'empilement
   * magnétique — s'approcher d'une barre ancrée fait venir s'empiler dessus, même loin
   * du bord d'écran (on adopte ensuite son bord ET sa position parallèle → chevauchement).
   */
  _nearestDockedBar() {
    const MAGNET = 44;
    const r = this.el.getBoundingClientRect();
    let best = null, bestDist = Infinity;
    for (const other of FloatingBar.instances) {
      if (other === this || !other.el || other.el.style.display === "none") continue;
      if (!other.dockSettingKey || other.getEdge() === "free") continue;
      const o = other.el.getBoundingClientRect();
      // Distance entre rectangles (0 s'ils se chevauchent) : proximité par n'importe quel côté.
      const dx = Math.max(o.left - r.right, r.left - o.right, 0);
      const dy = Math.max(o.top - r.bottom, r.top - o.bottom, 0);
      const dist = Math.hypot(dx, dy);
      if (dist < MAGNET && dist < bestDist) { best = other; bestDist = dist; }
    }
    return best;
  }

  /**
   * Aimant léger vers le CENTRE de l'écran le long du bord (seul point dur à viser à main
   * levée) ; sinon position CONTINUE (on reste où on lâche). Ne touche qu'à l'axe parallèle
   * au bord ; renvoie { left, top }.
   */
  snapParallel(edge, left, top) {
    const SNAP = 32;
    const bw = this.el.offsetWidth, bh = this.el.offsetHeight;
    if (edge === "top" || edge === "bottom") {
      const c = (this.usableRight() - bw) / 2;
      if (Math.abs(left - c) < SNAP) left = c;
    } else {
      const c = (window.innerHeight - bh) / 2;
      if (Math.abs(top - c) < SNAP) top = c;
    }
    return { left, top };
  }

  /** Affiche la bande de dépôt le long du bord candidat (le « layout ondrag »). */
  showDropzone(edge) {
    if (!edge) return this.hideDropzone();
    const zone = (this._dropzone ??= this._makeDropzone());
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

  /**
   * Crée la poignée de déplacement (icône grip) : glisser (bouton gauche) pour
   * déplacer/ancrer, clic DROIT pour ouvrir les réglages de la barre. Ce clic droit
   * est le seul accès aux réglages quand le HUD joueur est masqué (les panneaux par
   * barre y sont ouverts programmatiquement, contournant le menu natif restreint).
   */
  makeHandle(className, tooltip = "Glisser pour déplacer · clic droit : réglages") {
    const handle = document.createElement("i");
    handle.className = `fas fa-grip-vertical ${className}`;
    handle.dataset.tooltip = tooltip;
    this.initDrag(handle);
    handle.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.openSettings();
    });
    return handle;
  }

  /**
   * Bouton ↻ de rotation : bascule l'orientation horizontale / verticale de la barre.
   * N'a de sens (et n'est visible, cf. CSS `.fb-docked .fb-rotate`) que lorsque la barre
   * est ancrée à un bord. À n'ajouter que par les barres ayant une `orientSettingKey`.
   */
  makeRotateButton(className) {
    const btn = document.createElement("i");
    btn.className = `fas fa-rotate fb-rotate ${className}`;
    btn.dataset.tooltip = "Pivoter la barre (horizontale / verticale)";
    // pointerdown stoppé pour ne pas amorcer un glisser depuis une poignée voisine.
    btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    btn.addEventListener("click", (ev) => { ev.preventDefault(); this.toggleOrientation(); });
    return btn;
  }

  /**
   * Ouvre le panneau de réglages de cette barre (défini par la sous-classe via la
   * statique `SettingsPanel`, assignée à l'enregistrement des réglages). Réutilise
   * une instance déjà ouverte plutôt que d'en empiler une nouvelle.
   */
  openSettings() {
    const Panel = this.constructor.SettingsPanel;
    if (!Panel) return;
    const id = Panel.DEFAULT_OPTIONS?.id;
    const existing = id ? foundry.applications?.instances?.get?.(id) : null;
    if (existing) { existing.render(true); existing.bringToFront?.(); return; }
    new Panel().render(true);
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
    this._sidebarRO?.disconnect();
    this._dropzone?.remove();
    this.el?.remove();
    this.constructor.instance = null;
    FloatingBar.instances.delete(this);
    FloatingBar.reflowDocked(); // les barres restantes se ré-empilent sans celle-ci.
  }
}
