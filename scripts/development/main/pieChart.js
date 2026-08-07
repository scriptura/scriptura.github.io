/**
 * @summary Web Component SVG de graphique en camembert (simple/donut), animé,
 *          avec labels positionnés et interaction hover par section.
 * @see https://grafikart.fr/tutoriels/graph-pie-camembert-1965
 *
 * @strategy
 *   – `total` extrait comme invariant AOT après parsing des données : jamais
 *     recalculé dans la boucle d'animation (supprime un Array.reduce par frame).
 *   – Paths et lines pré-alloués dans le constructeur : zéro allocation pendant
 *     le rendu. La boucle draw() ne fait que des setAttribute (mutations pures).
 *   – La constante `patch` (epsilon géométrique) compense la limite de précision
 *     des flottants sur les arcs SVG à 360° : un path couvrant exactement 100%
 *     du cercle produit un arc dégénéré (start === end) que le moteur SVG ignore.
 *
 * @architectural-decision
 *   – Custom Elements conservés : connectedCallback est le hook natif correct
 *     pour déclencher l'animation à l'entrée dans le DOM. L'alternative
 *     (IntersectionObserver + init manuel) produit le même résultat avec plus
 *     de code et sans bénéfice de performance à cette échelle d'instanciation.
 *   – Shadow DOM conservé : l'encapsulation CSS est légitime — les styles du
 *     graphe ne doivent ni fuiter dans la page ni être affectés par elle.
 *     La customisation externe passe par des CSS variables
 *     (ex. --pie-chart-color-label) sans nécessiter de percer l'encapsulation.
 *   – Couleurs des segments non exposées en CSS variables : elles sont déclarées
 *     via l'attribut HTML `colors` (séparateur `;`), ce qui suffit pour le cas
 *     d'usage actuel et évite une API CSS plus complexe.
 */

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/**
 * Parse une chaîne HTML/SVG et retourne le premier nœud enfant.
 * @param {string} str
 * @returns {Node}
 */
const strToDom = (str) =>
	document.createRange().createContextualFragment(str).firstChild;

/**
 * Courbe d'accélération exponentielle décroissante.
 * @param {number} x - Progression [0, 1]
 * @returns {number}
 */
const easeOutExpo = (x) => (x === 1 ? 1 : 1 - 2 ** (-10 * x));

// ---------------------------------------------------------------------------
// Point
// ---------------------------------------------------------------------------

/**
 * Représente un point 2D dans l'espace SVG normalisé [-1, 1].
 * @property {number} x
 * @property {number} y
 */
class Point {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}

	toSvgPath() {
		return `${this.x} ${this.y}`;
	}

	static fromAngle(angle) {
		return new Point(Math.cos(angle), Math.sin(angle));
	}
}

// ---------------------------------------------------------------------------
// PieChart
// ---------------------------------------------------------------------------

/**
 * @property {number[]}        data   - Valeurs brutes des sections
 * @property {number}          total  - Somme des valeurs (invariant AOT)
 * @property {SVGPathElement[]} paths  - Sections SVG pré-allouées
 * @property {SVGLineElement[]} lines  - Séparateurs SVG pré-alloués
 * @property {HTMLDivElement[]} labels - Labels positionnés
 */
class PieChart extends HTMLElement {
	constructor() {
		super();
		const shadow = this.attachShadow({ mode: "open" });

		// — Lecture des attributs (AOT, avant tout rendu) —
		const labels = this.getAttribute("labels")?.split(";") ?? [];
		const donut = this.getAttribute("donut") ?? "0.7";
		const gap = this.getAttribute("gap") ?? "0.04";
		const colors = this.getAttribute("colors")?.split(";") ?? [
			"hsl(9,100%,64%)",
			"hsl(29,100%,64%)",
			"hsl(49,100%,64%)",
			"hsl(69,100%,64%)",
			"hsl(89,100%,64%)",
			"hsl(109,100%,64%)",
			"hsl(129,100%,64%)",
			"hsl(149,100%,64%)",
			"hsl(169,100%,64%)",
			"hsl(189,100%,64%)",
		];

		this.data = this.getAttribute("data").split(";").map(parseFloat);
		// Invariant AOT : calculé une fois, jamais recalculé dans la boucle draw()
		this.total = this.data.reduce((acc, v) => acc + v, 0);

		// — Structure SVG —
		const svg = strToDom(`<svg viewBox="-1 -1 2 2">
      <g mask="url(#graphMask)"></g>
      <mask id="graphMask">
        <rect fill="white" x="-1" y="-1" width="2" height="2"/>
        <circle r="${donut}" fill="black"/>
      </mask>
    </svg>`);

		const pathGroup = svg.querySelector("g");
		const maskGroup = svg.querySelector("mask");

		// — Pré-allocation des paths (sections) —
		this.paths = this.data.map((_, k) => {
			const path = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			path.setAttribute("fill", colors[k % colors.length].trim());
			path.addEventListener("mouseover", () => this.handlePathHover(k));
			path.addEventListener("mouseout", () => this.handlePathOut(k));
			pathGroup.appendChild(path);
			return path;
		});

		// — Pré-allocation des lignes (séparateurs) —
		this.lines = this.data.map(() => {
			const line = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"line",
			);
			line.setAttribute("stroke", "#000");
			line.setAttribute("stroke-width", gap);
			line.setAttribute("x1", "0");
			line.setAttribute("y1", "0");
			maskGroup.appendChild(line);
			return line;
		});

		// — Labels —
		this.labels = labels.map((label, id) => {
			const div = document.createElement("div");
			div.id = `label${id}`;
			div.textContent = label;
			div.setAttribute("tabindex", "0");
			shadow.appendChild(div);
			return div;
		});

		// — Styles encapsulés —
		const style = document.createElement("style");
		style.textContent = `
:host {
  display: block;
  position: relative;
}
svg {
  width: 100%;
  height: 100%;
}
path {
  cursor: pointer;
  transition: filter .3s;
}
path:hover,
path.active {
  filter: invert(1);
}
div {
  position: absolute;
  top: 0;
  left: 0;
  padding: .2em .5em;
  white-space: nowrap;
  transform: translate(-50%, -50%);
  background-color: var(--pie-chart-color-label, #222);
  opacity: 0;
  transition: opacity .3s;
  pointer-events: none;
}
div:focus,
div:active,
div.active {
  opacity: 1;
  outline: none;
}
`;
		shadow.appendChild(style);
		shadow.appendChild(svg);
	}

	connectedCallback() {
		const start = Date.now();
		const duration = 1000;

		const tick = () => {
			const t = (Date.now() - start) / duration;
			if (t < 1) {
				this.draw(easeOutExpo(t));
				requestAnimationFrame(tick);
			} else {
				this.draw(1);
			}
		};
		requestAnimationFrame(tick);
	}

	/**
	 * Dessine toutes les sections du graphique à un état de progression donné.
	 * @param {number} progress - [0, 1]
	 */
	draw(progress = 1) {
		// Epsilon géométrique : un arc à exactement 360° produit un chemin dégénéré
		// (point de départ === point d'arrivée) que le moteur SVG ignore visuellement.
		const PATCH = 0.0000001;
		let angle = Math.PI / -2;
		let start = new Point(0, -1);

		for (let k = 0; k < this.data.length; k++) {
			this.lines[k].setAttribute("x2", start.x);
			this.lines[k].setAttribute("y2", start.y);

			const ratio = (this.data[k] / this.total) * progress;

			if (progress === 1) {
				this.positionLabel(this.labels[k], angle + ratio * Math.PI);
			}

			angle += ratio * 2 * Math.PI - PATCH;
			const end = Point.fromAngle(angle);
			const largeFlag = ratio > 0.5 ? "1" : "0";

			this.paths[k].setAttribute(
				"d",
				`M 0 0 L ${start.toSvgPath()} A 1 1 0 ${largeFlag} 1 ${end.toSvgPath()} L 0 0`,
			);
			start = end;
		}
	}

	/**
	 * Active visuellement la section k et émet un événement personnalisé.
	 * @param {number} k
	 */
	handlePathHover(k) {
		this.dispatchEvent(new CustomEvent("sectionhover", { detail: k }));
		this.labels[k]?.classList.add("active");
	}

	/**
	 * Désactive visuellement la section k.
	 * @param {number} k
	 */
	handlePathOut(k) {
		this.labels[k]?.classList.remove("active");
	}

	/**
	 * Positionne un label sur le rayon médian de sa section.
	 * @param {HTMLDivElement|undefined} label
	 * @param {number|undefined} angle - En radians
	 */
	positionLabel(label, angle) {
		if (!label || angle == null) return;
		const point = Point.fromAngle(angle);
		label.style.setProperty("top", `${(point.y * 0.5 + 0.5) * 100}%`);
		label.style.setProperty("left", `${(point.x * 0.5 + 0.5) * 100}%`);
	}
}

customElements.define("pie-chart", PieChart);
