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
 *
 * ANCRAGE — grille 2D par bord. Une barre docke sur un BORD (top/bottom/left/right), puis
 * se place selon DEUX axes discrets :
 *   • LE LONG du bord  → ANCRE `start | center | end` ;
 *   • EN PROFONDEUR    → RANGÉE `row` (0 = collée au bord, 1 = empilée par-dessus, …).
 * Dans une même cellule (bord, ancre, rangée), les barres coulent bout à bout par rang
 * d'arrivée (`order`), JAMAIS l'une par-dessus l'autre. Ainsi deux barres « bottom-center »
 * peuvent s'empiler verticalement en restant toutes deux centrées (rangées 0 et 1). Voir
 * `layoutAll` / `_layoutEdge`.
 */
import { MODULE_ID } from "../const.js";
import { t } from "./common.js";

export class FloatingBar {
  /**
   * Registre de toutes les barres vivantes (toutes sous-classes confondues). Sert à la
   * disposition globale : chaque bord est rempli en tenant compte de toutes les barres qui
   * s'y ancrent (voir layoutAll).
   */
  static instances = new Set();

  /** Garde de ré-entrance de layoutAll (évite la récursion de la cascade). */
  static _reflowing = false;

  /** Compteur de rangs d'arrivée (ordonne les barres d'un même bord/ancre). Voir nextSeq. */
  static _seqCounter = 0;

  /**
   * Alloue un rang d'arrivée STRICTEMENT croissant et unique (base = horloge, pour rester
   * au-dessus des rangs déjà persistés d'une session précédente). Un rang plus grand =
   * arrivé plus tard = placé après les barres déjà présentes sur le même bord/ancre.
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
    this.toggleEl = null;    // bouton de repli (posé par makeCollapseToggle), lu par updateCollapseIcon
    this.mirrorEl = null;    // clone miroir 180° (mode table) ; null si absent
    this.hookIds = {};
    this._destroyed = false;  // vrai après destroy() : garde les rappels différés (debounce/setTimeout)
    this._mirrorSyncScheduled = false;
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
    const maxLeft = Math.max(edge, FloatingBar.usableRight() - bw - edge);
    const maxTop  = Math.max(edge, window.innerHeight - bh - edge);
    left = Math.clamp(left, edge, maxLeft);
    top  = Math.clamp(top,  edge, maxTop);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top  = `${Math.round(top)}px`;
    this.el.style.right = this.el.style.bottom = "auto";
    this.el.style.transform = "none";
  }

  /** Bord droit utilisable (délègue à la statique, cf. FloatingBar.usableRight). */
  usableRight() { return FloatingBar.usableRight(); }

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
   * La disposition d'une barre dépendant des autres (empilement le long du bord), on
   * relance la passe globale.
   */
  reflow() {
    // Le plafond de taille (constrainSize) est ré-appliqué globalement par layoutAll.
    FloatingBar.layoutAll();
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
   * apparaître une zone de dépôt avec le sous-repère de l'ancre visée ; au relâcher, on
   * ancre la barre à ce bord (bord + ancre discrète start|center|end + rang d'arrivée
   * `order`) ou, si on lâche au centre, on repasse en mode libre (position mémorisée).
   * Le handle reste toujours visible, y compris quand la barre est ancrée.
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
      let align = null;      // ancre visée (start | center | end)
      let row = null;        // rangée visée (profondeur perpendiculaire au bord)
      let engaged = null;    // bord « collant » engagé (hystérésis anti-bascule au coin)
      const onMove = (e) => {
        this.setPos(e.clientX - offX, e.clientY - offY); // suit le pointeur
        candidate = null;
        align = null;
        row = null;
        if (this.dockSettingKey) {
          const nearEdge = this.dockCandidateAt(e.clientX, e.clientY); // bord d'écran sous le pointeur
          if (engaged && nearEdge !== null) {
            // Bord COLLANT : une fois engagé, on ne change plus de bord au coin.
            candidate = engaged;
          } else if (nearEdge !== null) {
            candidate = engaged = nearEdge;
          } else {
            candidate = engaged = null; // revenu au centre → libre
          }
          if (candidate) {
            align = this._alignAt(candidate, e.clientX, e.clientY);
            // Rangée déduite de la PROFONDEUR du pointeur : collé au bord → rejoint la rangée
            // existante (flux le long du bord) ; plus loin → nouvelle rangée empilée.
            row = this._rowAt(candidate, align, e.clientX, e.clientY);
          }
        }
        this.showDropzone(candidate, align, row);
      };
      const onUp = () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this.hideDropzone();
        if (candidate) {
          // Cellule (ancre × rangée) + rang d'arrivée : la disposition range les barres dans la
          // grille du bord, le long de l'ancre et empilées par rangée, sans jamais les superposer.
          this.writeDockState({ align: align ?? "center", row: row ?? 0, order: FloatingBar.nextSeq() });
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
  //     Sans clé d'orientation, l'orientation est DÉDUITE du bord (gauche/droite → vertical).
  // La POSITION dans le bord est une CELLULE discrète : ancre (start | center | end) LE LONG
  // du bord × rangée (`row`, entier ≥ 0) EN PROFONDEUR + un rang d'arrivée (`order`) au sein de
  // la cellule, mémorisés en localStorage (posés au glisser). Les barres sans `dockSettingKey`
  // restent toujours libres.
  get dockSettingKey() { return null; }
  get orientSettingKey() { return null; }
  get defaultEdge() { return "free"; }
  get defaultOrientation() { return "h"; }

  /**
   * La barre utilise-t-elle la coque commune `.fb-bar` (une seule boîte : fond/bordure/ombre
   * partagés) ? Vrai par défaut. Le suivi de combat la surcharge à false : sa coque est
   * multi-panneaux et transparente (chaque panneau porte son propre fond).
   */
  get sharedShell() { return true; }

  /** Clé localStorage de l'état d'ancrage { align, order } (par utilisateur). */
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

  /** Ancre courante le long du bord : start | center | end (défaut center). */
  getAlign() {
    const a = this.readDockState().align;
    return (a === "start" || a === "center" || a === "end") ? a : "center";
  }
  /** Rangée (profondeur perpendiculaire au bord) : 0 = collée au bord, 1 = empilée par-dessus, … */
  getRow() { const r = this.readDockState().row; return Number.isInteger(r) && r >= 0 ? r : 0; }
  /** Rang d'arrivée : ordonne les barres d'une même cellule (bord, ancre, rangée). Plus petit = d'abord. */
  getOrder() { const o = this.readDockState().order; return Number.isFinite(o) ? o : 0; }
  _ensureOrder() { if (!Number.isFinite(this.readDockState().order)) this.writeDockState({ order: FloatingBar.nextSeq() }); }

  /** Bord opposé (réflexion par le centre de l'écran) — mode miroir. */
  static oppEdge(e) { return { top: "bottom", bottom: "top", left: "right", right: "left" }[e] ?? e; }
  /** Ancre opposée (réflexion par le centre) — mode miroir. */
  static oppAlign(a) { return { start: "end", end: "start", center: "center" }[a] ?? "center"; }

  /**
   * Mode table : duplique chaque barre en une copie 180° au coin opposé. Réglage MONDE, mais
   * le miroir ne concerne QUE l'écran de table (le joueur désigné « tvUser ») — ce sont les
   * joueurs assis en face qui regardent cet écran partagé ; les autres clients n'en montrent pas.
   */
  static tableMode() {
    try {
      if (game.settings.get(MODULE_ID, "tableMode") !== true) return false;
      return !game.user.isGM && game.user.id === game.settings.get(MODULE_ID, "tvUser");
    } catch { return false; }
  }

  /** Marge d'ancrage à l'écran (réglage « dockMargin », défaut 8px). */
  static margin() { const raw = game.settings.get(MODULE_ID, "dockMargin"); return Number.isFinite(raw) ? raw : 8; }
  dockMargin() { return FloatingBar.margin(); }

  /**
   * Bord droit utilisable : la sidebar de Foundry (chat, combat…) est exclue pour que les
   * barres ne la recouvrent jamais. Quand elle est visible et ancrée dans la moitié droite
   * de l'écran, le bord utile s'arrête à son bord gauche ; sinon toute la largeur de la
   * fenêtre. Suit son ouverture/fermeture (voir attachViewportHandlers).
   */
  static usableRight() {
    const W = window.innerWidth;
    const r = document.getElementById("sidebar")?.getBoundingClientRect();
    if (r && r.width > 0 && r.left > W / 2) return r.left;
    return W;
  }

  /** Persiste le bord (source de vérité partagée avec le panneau). onChange → layoutAll. */
  async setEdge(edge) {
    const key = this.dockSettingKey;
    if (!key) return;
    // Même bord (ex. re-lâchée le long du même bord, seule l'ancre change) : on relance quand
    // même la disposition, car l'onChange du réglage ne se déclenchera pas.
    if (game.settings.get(MODULE_ID, key) === edge) return FloatingBar.layoutAll();
    await game.settings.set(MODULE_ID, key, edge);
  }

  /** Persiste l'orientation (si la barre en a une explicite). onChange → layoutAll. */
  async setOrientation(o) {
    const key = this.orientSettingKey;
    if (!key) return;
    if (game.settings.get(MODULE_ID, key) === o) return FloatingBar.layoutAll();
    await game.settings.set(MODULE_ID, key, o);
  }

  /** Bouton ↻ : bascule horizontale / verticale (ne change PAS l'ordre d'empilement). */
  toggleOrientation() { this.setOrientation(this.getOrientation() === "h" ? "v" : "h"); }

  /** Orientation VISUELLE effective : « v » selon l'orientation choisie, INDÉPENDAMMENT de l'ancrage. */
  isVertical() { return this.getOrientation() === "v"; }

  /**
   * Classe d'icône du bouton replier/déployer, selon l'orientation VISUELLE de la barre et
   * l'état replié. La flèche indique le sens du contenu : barre horizontale → gauche/droite,
   * barre verticale → haut/bas. Dépliée, elle pointe « vers l'intérieur » (replier vers la
   * poignée) ; repliée, « vers l'extérieur » (déployer le contenu).
   */
  collapseChevronClass() {
    const collapsed = this.isCollapsed();
    const dir = this.isVertical()
      ? (collapsed ? "down" : "up")
      : (collapsed ? "right" : "left");
    return `fas fa-chevron-${dir}`;
  }

  /** Applique les classes d'orientation/ancrage sur l'élément racine. */
  _applyDockClasses() {
    const edge = this.getEdge(), docked = edge !== "free";
    // Orientation DÉCOUPLÉE de l'ancrage : une barre est verticale dès que son orientation
    // vaut « v » (bouton ↻), qu'elle soit ancrée ou libre.
    const vertical = this.getOrientation() === "v";
    this.el.classList.toggle("fb-docked", docked);
    this.el.classList.toggle("fb-vertical", vertical);
    this.el.classList.toggle("fb-horizontal", !vertical);
    // L'orientation vient (peut-être) de changer : réaligner la flèche du toggle sur elle.
    this.updateCollapseIcon?.(this.isCollapsed());
  }

  /**
   * Applique l'ancrage de CETTE barre. Comme la disposition d'une barre dépend des autres
   * (empilement le long du bord), on relance la passe globale. Conservé pour la compat. avec
   * les onChange de réglages et les appels des sous-classes.
   */
  applyDock() { FloatingBar.layoutAll(); }

  /**
   * PASSE GLOBALE de disposition. Règle unique : chaque barre docke sur un bord et coule le
   * long de ce bord selon son ancre (start|center|end), en séquence d'arrivée (`order`), sans
   * jamais se superposer. Les barres libres reprennent leur position mémorisée. En mode table,
   * chaque barre visible reçoit une copie 180° au point symétrique.
   */
  static layoutAll() {
    if (FloatingBar._reflowing) return;
    FloatingBar._reflowing = true;
    try {
      const all = [...FloatingBar.instances].filter((b) => b.el);
      const visible = all.filter((b) => b.el.style.display !== "none");
      const table = FloatingBar.tableMode();

      // 1) Plafond de taille + classes d'ancrage sur les barres visibles. La réconciliation des
      //    miroirs porte sur TOUTES les barres : une barre masquée (display:none) doit démonter
      //    son miroir (sinon il reste orphelin au coin opposé).
      for (const b of visible) { b.constrainSize(); b._applyDockClasses(); }
      for (const b of all) b._syncMirrorMount(table);

      // 2) barres libres : position mémorisée.
      for (const b of visible) if (!b.isDocked()) b.applyPosition();

      // 3) barres ancrées : disposition le long des bords.
      const placements = [];
      for (const b of visible) {
        if (!b.isDocked()) continue;
        b._ensureOrder();
        placements.push({ bar: b, edge: b.getEdge(), align: b.getAlign(), row: b.getRow(), order: b.getOrder() });
      }
      FloatingBar._positionEdges(placements);

      // 3b) Position finale posée : chaque barre peut recaler ses sous-éléments dont le
      //     placement dépend de la géométrie (ex. panneau cible flottant du combat), sinon
      //     ils gardent des coordonnées calculées pour l'ancienne position/orientation.
      for (const b of visible) b.afterLayout?.();

      // 4) miroirs : réflexion exacte de la position finale du primaire (ancré ET libre).
      if (table) for (const b of visible) if (b.mirrorEl) b._layoutMirror();
    } finally {
      FloatingBar._reflowing = false;
    }
  }

  /** Alias historique (destroy, sous-classes) : relance la passe globale. */
  static reflowDocked() { FloatingBar.layoutAll(); }

  /**
   * Positionne les placements ancrés. Les bords horizontaux (top/bottom) sont posés d'abord,
   * pleine largeur (ils possèdent les coins) ; les bords verticaux (left/right) cèdent au coin
   * en rétrécissant leur étendue de la bande horizontale (épaisseur TOTALE des rangées empilées),
   * pour ne jamais recouvrir une barre de coin.
   */
  static _positionEdges(placements) {
    const H = window.innerHeight, m = FloatingBar.margin();
    const byEdge = { top: [], bottom: [], left: [], right: [] };
    for (const p of placements) (byEdge[p.edge] ??= []).push(p);

    let topBand = 0, botBand = 0;
    for (const edge of ["top", "bottom"]) {
      const list = byEdge[edge];
      if (!list.length) continue;
      const band = FloatingBar._layoutEdge(list, edge, 0, FloatingBar.usableRight(), m);
      if (edge === "top") topBand = band; else botBand = band;
    }

    for (const edge of ["left", "right"]) {
      const list = byEdge[edge];
      if (!list.length) continue;
      FloatingBar._layoutEdge(list, edge, topBand, H - botBand, m);
    }
  }

  /**
   * Coordonnée de référence du bord = côté PROCHE de la rangée 0 (là d'où la profondeur `d`
   * s'accumule). En bas, la référence remonte au-dessus de la hotbar quand la barre la survole,
   * pour ne jamais la recouvrir. `[from, to]` = étendue de la barre le long du bord (test hotbar) ;
   * passer un point (from = to) suffit pendant le glisser.
   */
  static _edgeRef(edge, from, to = from) {
    const W = FloatingBar.usableRight(), H = window.innerHeight, m = FloatingBar.margin();
    if (edge === "top" || edge === "left") return m;
    if (edge === "right") return W - m;
    const hb = document.getElementById("hotbar")?.getBoundingClientRect();
    if (hb && hb.width && from < hb.right && to > hb.left) return hb.top;
    return H - m; // bord bas, hors hotbar
  }

  /**
   * Dispose les barres d'UN bord sur sa grille 2D. D'abord regroupées par RANGÉE (empilement
   * perpendiculaire : rangée 0 collée au bord, chaque rangée suivante décalée vers l'intérieur de
   * l'épaisseur max de la précédente) ; puis, dans chaque rangée, coulées LE LONG du bord par
   * lots d'ancre (start|center|end) et rang d'arrivée. Retourne l'épaisseur totale occupée
   * (cession de coin des bords verticaux).
   */
  static _layoutEdge(list, edge, p0, p1, gap) {
    const horiz = edge === "top" || edge === "bottom";
    const along = (p) => (horiz ? p.bar.el.offsetWidth : p.bar.el.offsetHeight);
    const thick = (p) => (horiz ? p.bar.el.offsetHeight : p.bar.el.offsetWidth);

    const rows = new Map();
    for (const p of list) { if (!rows.has(p.row)) rows.set(p.row, []); rows.get(p.row).push(p); }
    const rowKeys = [...rows.keys()].sort((a, b) => a - b);

    // Décalage cumulé de chaque rangée depuis le bord + épaisseur totale de la pile.
    const depth = new Map();
    let acc = 0, band = 0;
    for (const r of rowKeys) {
      depth.set(r, acc);
      const t = Math.max(0, ...rows.get(r).map(thick));
      band = Math.max(band, acc + t);
      acc += t + gap;
    }

    for (const r of rowKeys) {
      const d = depth.get(r);
      FloatingBar._flowAlong(rows.get(r), p0, p1, gap, along, (p, parCoord) => {
        const bw = p.bar.el.offsetWidth, bh = p.bar.el.offsetHeight;
        if (horiz) {
          const ref = FloatingBar._edgeRef(edge, parCoord, parCoord + bw);
          const y = edge === "top" ? ref + d : ref - d - bh;
          p.bar.setPos(parCoord, y, gap);
        } else {
          const ref = FloatingBar._edgeRef(edge, parCoord);
          const x = edge === "left" ? ref + d : ref - d - bw;
          p.bar.setPos(x, parCoord, gap);
        }
      });
    }
    return band + 2 * gap;
  }

  /**
   * Flux LE LONG du bord d'une seule rangée : ses 3 lots d'ancre sur l'étendue [p0, p1] —
   * `start` coule depuis p0, `end` recule depuis p1, `center` centré en bloc — chaque lot trié
   * par rang d'arrivée. `size(p)` = taille de la barre le long du bord ; `place(p, parCoord)`
   * reçoit la coordonnée parallèle du coin avant de chaque barre.
   */
  static _flowAlong(list, p0, p1, gap, size, place) {
    const groups = { start: [], center: [], end: [] };
    for (const p of list) (groups[p.align] ?? groups.center).push(p);
    for (const k of ["start", "center", "end"]) groups[k].sort((a, b) => a.order - b.order);

    let cur = p0;
    for (const p of groups.start) { place(p, cur); cur += size(p) + gap; }

    cur = p1;
    for (const p of groups.end) { cur -= size(p); place(p, cur); cur -= gap; }

    const total = groups.center.reduce((s, p) => s + size(p), 0) + gap * Math.max(0, groups.center.length - 1);
    cur = (p0 + p1) / 2 - total / 2;
    for (const p of groups.center) { place(p, cur); cur += size(p) + gap; }
  }

  // ── Mode table : copie miroir 180° au point symétrique ───────────────────────
  // La copie est un clone vivant du primaire, resynchronisé par MutationObserver et placé au
  // point symétrique de l'écran (rotation 180° via la classe CSS .fb-mirror). Les clics sur la
  // copie sont réémis sur le nœud homologue du primaire (qui porte la logique).

  /** Crée/détruit le miroir selon le mode table et la visibilité de la barre. */
  _syncMirrorMount(table) {
    const want = table && this.el && this.el.style.display !== "none";
    if (want && !this.mirrorEl) this._ensureMirror();
    else if (!want && this.mirrorEl) this._destroyMirror();
  }

  /** Instancie le miroir : clone de la barre, synchronisé en direct et interactif. */
  _ensureMirror() {
    const m = this.el.cloneNode(true);
    m.classList.add("fb-mirror");
    // NE PAS retirer l'id : tout le CSS des barres est scopé par id (#spell-template-bar,
    // #combat-overlay, #selected-token-actions). Le miroir DOIT garder l'id pour hériter de la
    // même mise en page ; sans lui il s'effondre en bloc non stylé. Aucun code ne résout ces
    // barres par getElementById (références directes this.el/this.bar), l'id dupliqué est inerte.
    document.body.appendChild(m);
    this.mirrorEl = m;
    this._mirrorEvent = (ev) => this._forwardMirrorEvent(ev);
    m.addEventListener("click", this._mirrorEvent);
    m.addEventListener("contextmenu", this._mirrorEvent); // clic droit (réglages / fiche) aussi relayé.
    // Toute mutation du primaire (rendus fréquents de combat/token) se reflète, mais on coalesce
    // les rafales en une seule resynchro par frame (évite la tempête de reflow sur l'écran de table).
    this._mirrorMO = new MutationObserver(() => this._scheduleMirrorSync());
    this._mirrorMO.observe(this.el, { childList: true, subtree: true, attributes: true });
    this._syncMirror();
    return m;
  }

  /** Programme une resynchro du miroir au prochain frame (coalesce les rafales de mutations). */
  _scheduleMirrorSync() {
    if (this._mirrorSyncScheduled) return;
    this._mirrorSyncScheduled = true;
    requestAnimationFrame(() => {
      this._mirrorSyncScheduled = false;
      this._syncMirror();
    });
  }

  /** Recopie contenu + classes + styles du primaire vers le miroir, puis le repositionne. */
  _syncMirror() {
    if (!this.mirrorEl) return;
    this.mirrorEl.className = `${this.el.className} fb-mirror`;
    this.mirrorEl.setAttribute("style", this.el.getAttribute("style") || "");
    this.mirrorEl.innerHTML = this.el.innerHTML;
    this._copyMirrorFormState(); // value/checked/selected ne sont PAS sérialisés par innerHTML.
    this._layoutMirror();
  }

  /** Recopie l'état vivant des contrôles (value / checked) du primaire vers le miroir. */
  _copyMirrorFormState() {
    const src = this.el.querySelectorAll("input, select, textarea");
    const dst = this.mirrorEl.querySelectorAll("input, select, textarea");
    const n = Math.min(src.length, dst.length);
    for (let i = 0; i < n; i++) {
      dst[i].value = src[i].value;
      if ("checked" in src[i]) dst[i].checked = src[i].checked;
    }
  }

  /** Place le miroir au point symétrique de la position écran du primaire (rotation via CSS). */
  _layoutMirror() {
    if (!this.mirrorEl) return;
    const W = window.innerWidth, H = window.innerHeight;
    const r = this.el.getBoundingClientRect();
    this.mirrorEl.style.left = `${Math.round(W - r.right)}px`;
    this.mirrorEl.style.top = `${Math.round(H - r.bottom)}px`;
    this.mirrorEl.style.right = this.mirrorEl.style.bottom = "auto";
    this.mirrorEl.style.transform = ""; // laisse la classe .fb-mirror appliquer rotate(180deg)
  }

  /** Réémet un clic du miroir sur le nœud homologue du primaire (le primaire porte la logique). */
  _forwardMirrorEvent(ev) {
    const path = this._indexPath(ev.target, this.mirrorEl);
    if (!path) return;
    const node = this._nodeAtPath(this.el, path);
    if (!node) return;
    ev.preventDefault();
    ev.stopPropagation();
    // Rejoue le MÊME type d'événement sur le nœud homologue du primaire (qui porte la logique).
    if (ev.type === "contextmenu") node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    else node.click?.();
  }
  /** Chemin d'index (suite de positions d'enfant) de `node` sous `root`, ou null. */
  _indexPath(node, root) {
    const path = [];
    while (node && node !== root) {
      const parent = node.parentNode;
      if (!parent) return null;
      path.unshift([...parent.childNodes].indexOf(node));
      node = parent;
    }
    return node === root ? path : null;
  }
  /** Nœud atteint en suivant `path` (chemin d'index) depuis `root`, ou null. */
  _nodeAtPath(root, path) {
    let n = root;
    for (const i of path) { n = n?.childNodes[i]; if (!n) return null; }
    return n;
  }

  /** Démonte le miroir (observer, écouteur, élément). */
  _destroyMirror() {
    this._mirrorMO?.disconnect();
    this._mirrorMO = null;
    this._mirrorSyncScheduled = false;
    if (this.mirrorEl) {
      this.mirrorEl.removeEventListener("click", this._mirrorEvent);
      this.mirrorEl.removeEventListener("contextmenu", this._mirrorEvent);
      this.mirrorEl.remove();
      this.mirrorEl = null;
    }
  }

  /**
   * Bord candidat sous le pointeur pendant un glisser, sinon null. On retient le bord le PLUS
   * PROCHE du pointeur, docké s'il est dans la bande d'engagement de ce bord. Cette bande vaut
   * EDGE px + l'épaisseur de la pile DÉJÀ ancrée au bord : on peut ainsi déposer AU-DESSUS d'une
   * pile existante (rangée suivante) même loin du bord. L'orientation ne dépend PAS du bord
   * (bouton ↻) ; ancre et rangée sont posées séparément au relâcher.
   */
  dockCandidateAt(x, y) {
    const EDGE = 60;
    const W = window.innerWidth, H = window.innerHeight;
    const d = { left: x, right: W - x, top: y, bottom: H - y };
    const [edge, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
    return dist <= EDGE + this._edgeStackDepth(edge) ? edge : null;
  }

  /** Ancre discrète (start|center|end) selon la position du pointeur le long du bord. */
  _alignAt(edge, x, y) {
    const horiz = edge === "top" || edge === "bottom";
    const span = horiz ? FloatingBar.usableRight() : window.innerHeight;
    const frac = (horiz ? x : y) / span;
    return frac < 1 / 3 ? "start" : frac < 2 / 3 ? "center" : "end";
  }

  /**
   * Rangées DÉJÀ occupées à ce bord par les AUTRES barres ancrées → Map(rangée → épaisseur max
   * de la rangée, mesurée perpendiculairement au bord). Filtrée par `align` si fourni (une même
   * ancre partage une pile) ; sinon toutes ancres confondues (pour la bande d'engagement).
   */
  _occupiedRows(edge, align = null) {
    const horiz = edge === "top" || edge === "bottom";
    const rows = new Map();
    for (const b of FloatingBar.instances) {
      if (b === this || !b.el || b.el.style.display === "none") continue;
      if (!b.isDocked() || b.getEdge() !== edge) continue;
      if (align !== null && b.getAlign() !== align) continue;
      const r = b.getRow();
      const t = horiz ? b.el.offsetHeight : b.el.offsetWidth;
      rows.set(r, Math.max(rows.get(r) ?? 0, t));
    }
    return rows;
  }

  /** Épaisseur totale de la pile ancrée à ce bord (toutes ancres) — approfondit la bande d'engagement. */
  _edgeStackDepth(edge) {
    if (!this.dockSettingKey) return 0;
    const m = FloatingBar.margin();
    let depth = 0;
    for (const t of this._occupiedRows(edge).values()) depth += t + m;
    return depth;
  }

  /** Profondeur (côté proche) de la rangée `row` à (bord, ancre), d'après les rangées déjà occupées. */
  _rowDepthFor(edge, align, row) {
    const rows = this._occupiedRows(edge, align);
    const m = FloatingBar.margin();
    let acc = 0;
    for (let r = 0; r < row; r++) acc += (rows.get(r) ?? 0) + m;
    return acc;
  }

  /**
   * Rangée visée selon la PROFONDEUR du pointeur par rapport au bord : si la profondeur tombe dans
   * la bande d'une rangée déjà occupée → on la REJOINT (flux le long du bord, côte à côte) ; si
   * elle dépasse la pile → NOUVELLE rangée empilée par-dessus.
   */
  _rowAt(edge, align, x, y) {
    const m = FloatingBar.margin();
    const ref = FloatingBar._edgeRef(edge, x);
    const depth = edge === "top" ? y - ref
                : edge === "bottom" ? ref - y
                : edge === "left" ? x - ref
                : ref - x;
    const rows = this._occupiedRows(edge, align);
    const keys = [...rows.keys()].sort((a, b) => a - b);
    let acc = 0;
    for (const r of keys) {
      const far = acc + rows.get(r);
      if (depth <= far + m / 2) return r; // dans (ou juste avant) cette rangée → la rejoindre
      acc = far + m;
    }
    return keys.length ? keys[keys.length - 1] + 1 : 0; // au-delà de la pile → nouvelle rangée
  }

  /**
   * Affiche la zone de dépôt = la CELLULE (ancre × rangée) visée : un tiers le long du bord, à la
   * profondeur de la rangée cible, épaisse comme cette barre. La bande englobante (fine) rappelle
   * le bord entier. C'est le « layout ondrag », qui reflète l'emplacement final.
   */
  showDropzone(edge, align = "center", row = 0) {
    if (!edge) return this.hideDropzone();
    const zone = (this._dropzone ??= this._makeDropzone());
    const horiz = edge === "top" || edge === "bottom";
    const m = FloatingBar.margin();
    const near = this._rowDepthFor(edge, align, row);
    const thick = (horiz ? this.el.offsetHeight : this.el.offsetWidth) || 44;

    // Bande-repère du bord entier, assez profonde pour contenir la rangée cible.
    const BAND = near + thick + 2 * m;
    Object.assign(zone.style, { left: "", top: "", right: "", bottom: "", width: "", height: "", display: "block" });
    if (horiz) { zone.style.left = "0"; zone.style.width = "100%"; zone.style.height = `${BAND}px`; zone.style[edge] = "0"; }
    else { zone.style.top = "0"; zone.style.height = "100%"; zone.style.width = `${BAND}px`; zone.style[edge] = "0"; }

    // Cellule visée : tiers le long du bord (ancre) × profondeur de la rangée.
    const slot = (zone._slot ??= zone.appendChild(document.createElement("div")));
    slot.className = "fb-dropzone-slot";
    const at = align === "start" ? "0%" : align === "end" ? "66.6667%" : "33.3333%";
    Object.assign(slot.style, { left: "", top: "", right: "", bottom: "", width: "", height: "" });
    slot.style[edge] = `${near}px`;
    if (horiz) { slot.style.left = at; slot.style.width = "33.3333%"; slot.style.height = `${thick}px`; }
    else { slot.style.top = at; slot.style.height = "33.3333%"; slot.style.width = `${thick}px`; }
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
  makeHandle(className, tooltip = t("ATS.bar.handleTooltip")) {
    const handle = document.createElement("i");
    handle.className = `fas fa-grip-vertical fb-handle ${className}`;
    handle.dataset.tooltip = tooltip;
    this.initDrag(handle);
    handle.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.openSettings();
    });
    return handle;
  }

  /**
   * Pastille d'identité (icône carrée), TOUJOURS visible : elle tient lieu de titre de barre
   * (plus de libellé texte, pour un rendu « barre d'outils » compact). Le titre de la barre est
   * porté en tooltip (survol). À insérer entre la poignée et le contenu/toggle.
   * @param {string} iconClass  Classe FontAwesome de l'icône.
   * @param {string} [prefix]    Préfixe CSS de la barre (ajoute `${prefix}-badge`).
   * @param {string} [title]     Titre affiché au survol (tooltip). Omis si vide.
   */
  makeBadge(iconClass, prefix = "", title = "") {
    const i = document.createElement("i");
    i.className = `fas ${iconClass} fb-badge${prefix ? ` ${prefix}-badge` : ""}`;
    if (title) i.dataset.tooltip = title;
    return i;
  }

  /**
   * Bouton ↻ de rotation : bascule l'orientation horizontale / verticale de la barre.
   * TOUJOURS visible (l'orientation est indépendante de l'ancrage), sauf barre repliée
   * (cf. CSS). À n'ajouter que par les barres ayant une `orientSettingKey`.
   */
  makeRotateButton(className) {
    const btn = document.createElement("i");
    btn.className = `fas fa-rotate fb-rotate ${className}`;
    btn.dataset.tooltip = t("ATS.bar.rotateTooltip");
    // pointerdown stoppé pour ne pas amorcer un glisser depuis une poignée voisine.
    btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    btn.addEventListener("click", (ev) => { ev.preventDefault(); this.toggleOrientation(); });
    return btn;
  }

  /**
   * En-tête commun à toutes les barres : UNE ligne (`fb-header`) regroupant, dans un ordre
   * GARANTI par la classe de base, la poignée (⋮⋮) → le bouton ↻ (orientation) → la pastille
   * d'identité (icône carrée, titre en tooltip) → les éléments propres à la barre (`extra`) →
   * le bouton de repli. Cette ligne se place EN TÊTE du conteneur, AVANT le contenu de la barre :
   * le repli est donc toujours sur la même ligne que la poignée, avant le contenu. En orientation
   * verticale, l'en-tête reste une ligne horizontale au-dessus du contenu (le conteneur, lui, passe
   * en colonne). `prefix` ajoute les classes historiques par barre pour la compat CSS.
   * @param {string} prefix        Préfixe CSS de la barre (« ab », « tb », « co », « rb », « sc »).
   * @param {object} opts
   * @param {string} opts.icon     Classe FontAwesome de la pastille d'identité.
   * @param {string} [opts.title]  Titre de la barre, affiché au survol de l'icône (tooltip).
   * @param {Node[]} [opts.extra]  Nœuds propres à la barre, insérés avant le bouton de repli.
   * @returns {HTMLElement}
   */
  makeHeader(prefix, { icon, title, extra = [] } = {}) {
    // Coque commune (fond/bordure/ombre partagés) posée ici pour que TOUTE barre en hérite
    // sans la redéclarer — sauf opt-out (`sharedShell` = false, ex. suivi de combat multi-panneaux).
    if (this.el && this.sharedShell) this.el.classList.add("fb-bar");

    const header = document.createElement("div");
    header.className = `fb-header ${prefix}-header`;
    header.appendChild(this.makeHandle(`${prefix}-handle`));
    header.appendChild(this.makeRotateButton(`${prefix}-rotate`));
    header.appendChild(this.makeBadge(icon, prefix, title));
    for (const node of extra) if (node) header.appendChild(node);
    header.appendChild(this.makeCollapseToggle(prefix));
    return header;
  }

  /**
   * Bouton de repli commun (⟨/⟩), en pied de chrome. L'icône (sens selon l'orientation) et le
   * tooltip sont posés par updateCollapseIcon. Mémorise le bouton dans `this.toggleEl` pour que
   * la classe de base sache le retrouver — les sous-classes n'ont plus à redéfinir l'icône.
   * @param {string} prefix  Préfixe CSS de la barre.
   * @returns {HTMLElement}
   */
  makeCollapseToggle(prefix) {
    const toggle = document.createElement("div");
    toggle.className = `fb-toggle ${prefix}-toggle`;
    toggle.appendChild(document.createElement("i"));
    toggle.addEventListener("click", () => this.toggleCollapsed());
    this.toggleEl = toggle;
    return toggle;
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
  // Les sous-classes ne fournissent plus que `collapsedClass` (nom de la classe CSS propre) ;
  // l'icône/tooltip du bouton de repli est gérée ici de façon commune via `this.toggleEl`.
  isCollapsed() { return this.el.classList.contains(this.collapsedClass); }

  toggleCollapsed() { this.setCollapsed(!this.isCollapsed()); }

  setCollapsed(on) {
    this.el.classList.toggle(this.collapsedClass, on);
    this.el.classList.toggle("fb-collapsed", on); // classe partagée : styles de repli communs
    localStorage.setItem(this.collapsedKey, on ? "1" : "0");
    this.updateCollapseIcon(on);
    this.reflow(); // la largeur a changé : re-contraindre / ré-ancrer.
  }

  /**
   * Met à jour l'icône (chevron selon l'orientation) et le tooltip du bouton de repli. Commun à
   * toutes les barres via `this.toggleEl` (posé par makeCollapseToggle) — plus de surcharge par
   * barre. Sans effet tant que le bouton n'est pas construit (rendu initial).
   * @param {boolean} [on]  État replié ; déduit de la classe si omis.
   */
  updateCollapseIcon(on = this.isCollapsed()) {
    const icon = this.toggleEl?.querySelector("i");
    if (icon) icon.className = this.collapseChevronClass();
    if (this.toggleEl) this.toggleEl.dataset.tooltip = on ? t("ATS.bar.expand") : t("ATS.bar.collapse");
  }

  /**
   * Applique l'état replié MÉMORISÉ (localStorage) lors du (re)rendu : pose les classes de repli
   * (propre à la barre + partagée) et l'icône. À appeler en fin de render, après le bouton de
   * repli et AVANT applyDock (pour que la disposition tienne compte de la taille repliée).
   */
  applyCollapsedState() {
    const on = localStorage.getItem(this.collapsedKey) === "1";
    this.el.classList.toggle(this.collapsedClass, on);
    this.el.classList.toggle("fb-collapsed", on);
    this.updateCollapseIcon(on);
  }

  /** Désenregistre les hooks, retire l'écouteur de resize, supprime l'élément. */
  destroy() {
    this._destroyed = true; // neutralise les rappels différés déjà en file (debounce / setTimeout).
    for (const [hook, id] of Object.entries(this.hookIds)) Hooks.off(hook, id);
    window.removeEventListener("resize", this.onResize);
    this._sidebarRO?.disconnect();
    this._destroyMirror();
    this._dropzone?.remove();
    this.el?.remove();
    this.constructor.instance = null;
    FloatingBar.instances.delete(this);
    FloatingBar.layoutAll(); // les barres restantes se re-disposent sans celle-ci.
  }
}
