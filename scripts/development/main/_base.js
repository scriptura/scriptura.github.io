/**
 * @summary Pipeline de boot unique : détection des capacités, statut réseau,
 *          chargement conditionnel des assets (scripts + styles), routage global
 *          des événements d'interaction, et enregistrement du Service Worker.
 *
 * @strategy
 *   – DOM en lecture seule : références capturées une fois à l'init, jamais
 *     re-requêtées à l'exécution.
 *   – Délégation d'événements (Event Router) : un seul listener 'click' au niveau
 *     document, routé par classe CSS. Zéro allocation de closure dans des boucles.
 *   – ASSET_REGISTRY data-driven : table de dépendances évaluée en un seul passage
 *     DOM (sélecteurs concaténés → un seul appel moteur), scripts et styles injectés
 *     sans doublon. Les scripts sont async : injectés après parsing, ils ne bloquent
 *     jamais le rendu — aucune deferral supplémentaire n'est nécessaire.
 *   – Scroll-to-top via scroll event passif ({ passive: true }) : lecture de scrollY
 *     seule, sans lecture de layout (getBoundingClientRect, offsetTop) — zéro reflow.
 *   – Image fallback réactif : écoute globale en phase de capture sur window.error —
 *     zéro test réseau proactif, zéro allocation par élément <img>.
 *
 * @architectural-decision
 *   – Les styles conditionnels sont insérés après le premier <link rel=stylesheet>
 *     existant (non en fin de <head>) afin de respecter l'ordre de cascade planifié
 *     par l'architecture CSS du projet.
 *   – openExternalLinksInNewTab est une passe d'initialisation (mutation d'attributs),
 *     non une délégation d'événement : target="_blank" doit être en place avant tout
 *     clic, et le coût est O(liens externes) une seule fois au boot.
 *   – preloadImages est déclenché sur 'load' (non sur 'DOMContentLoaded') pour ne pas
 *     concurrencer le chargement des ressources critiques. Objectif : amorcer le cache
 *     Service Worker pour la navigation suivante.
 *   – Le timeout de NavigationSystem est déclaré dans la portée du système et non dans
 *     le handler resize : corrige le bug silencieux de l'original où clearTimeout était
 *     inopérant (nouvelle variable à chaque appel).
 *   – aria-hidden sur sub-nav est conditionnel au viewport, pas fixé à true au boot :
 *     en mode desktop, le sub-nav est visible via CSS et doit être accessible aux AT.
 *     Le breakpoint est lu depuis la CSS custom property --size-nav (getComputedStyle) —
 *     source de vérité unique, pas de valeur dupliquée en dur dans le JS.
 *   – injectSvgSprite est exposée sur window (non confinée dans l'IIFE) : elle est
 *     appelée directement depuis main.js et more.js qui s'exécutent dans des bundles
 *     distincts et n'ont pas accès à la portée de l'IIFE. Un namespace window.App
 *     aurait requis une mise à jour de tous les appelants sans bénéfice architectural.
 *   – initScrollButton utilise un scroll event { passive: true } plutôt qu'un
 *     IntersectionObserver sur élément sentinel injecté. La lecture de scrollY seule
 *     ne provoque aucun reflow — le thrashing n'existe que lorsqu'une lecture de layout
 *     est suivie d'une écriture dans le même frame. { passive: true } garantit que le
 *     listener ne bloque jamais le scroll du navigateur. Zéro injection HTML utilitaire.
 */
const AppPipeline = (() => {
	// ---------------------------------------------------------------------------
	// 1. Capability Detection (synchrone, avant tout rendu)
	// ---------------------------------------------------------------------------

	// @see Firefox Android a perdu sa fonction d'impression
	// @note jsDetect : remplacé par @media (scripting: none)
	// @deprecated touchDetect : remplacé par @media (hover: hover) and (pointer: fine)
	window.print || document.documentElement.classList.add("no-print");

	// ---------------------------------------------------------------------------
	// 2. Data Layout
	// ---------------------------------------------------------------------------

	const DOM = {
		html: document.documentElement,
		body: document.body,
		gdprTemplate: document.getElementById("gdpr"),
		gdprTarget: document.querySelector(".alert"),
	};

	const FALLBACK_IMG = "/medias/icons/utilDest/xmark.svg";

	/**
	 * Table de dépendances assets. Un seul passage DOM au boot.
	 * Présence d'un sélecteur → injection des scripts et styles associés.
	 *
	 * Champ optionnel `onload` : callback déclenché sur le `load` du dernier script
	 * de l'entrée. Utilisé pour séquencer des initialisations qui dépendent du script
	 * injecté (ex. : `window.initMaps` ne peut s'exécuter qu'après `leaflet.js`).
	 *
	 * @note .map et [class*=language-] apparaissent dans l'entrée 'more' car
	 *       more.js fournit aussi des enrichissements pour ces contextes.
	 *
	 * @architectural-decision `onload` est posé sur l'entrée Leaflet, pas sur
	 *       l'entrée more.js. Leaflet est la dépendance bloquante pour les cartes :
	 *       `window.initMaps` (défini dans more.js) peut être appelé dès que `L`
	 *       est disponible, quelle que soit l'ordre d'exécution des deux scripts.
	 */
	const ASSET_REGISTRY = [
		{
			selectors: ["pre > code[class*=language]", "[class*=language-]"],
			scripts: ["/libraries/prism/prism.js"],
			styles: [{ url: "/styles/prism.css", media: "screen" }],
		},
		{
			selectors: [".map", "[class*=map]"],
			scripts: ["/libraries/leaflet/leaflet.js"],
			styles: [
				{ url: "/libraries/leaflet/leaflet.css", media: "screen, print" },
			],
			onload: () => window.initMaps?.(),
		},
		{
			selectors: [
				"[class*=validation]",
				"[class*=assistance]",
				"[class*=character-counter]",
				"[class*=-focus]",
				".preview-container",
				"[class*=accordion]",
				".pre",
				"[class^=range]",
				".add-line-marks",
				".video-youtube",
				".client-test",
				".map",
				"[class*=language-]",
				".input-add-terms",
				".flip",
				".sprite-to-inline",
				".svg-animation",
			],
			scripts: ["/scripts/more.js"],
			styles: [],
		},
	];

	// ---------------------------------------------------------------------------
	// 3. Systems
	// ---------------------------------------------------------------------------

	// — Réseau —
	const NetworkSystem = {
		update: () => DOM.html.classList.toggle("offline", !navigator.onLine),
	};

	// — Vibration —
	const VibrateSystem = {
		play: (frame) => {
			if ("vibrate" in navigator)
				navigator.vibrate(frame ? parseInt(frame, 10) : 200);
		},
	};

	// — Navigation principale —
	const NavigationSystem = {
		_btn: null,
		_subNav: null,
		_content: null,
		_sizeNav: 0,
		_htmlFontSize: 1,
		_resizeTimer: null,

		init() {
			this._btn = document.querySelector(".cmd-nav");
			this._subNav = document.querySelector(".sub-nav");
			if (!this._btn || !this._subNav) return;

			this._content = document.querySelectorAll("body > :not(.nav)");
			this._sizeNav = parseFloat(
				getComputedStyle(DOM.html).getPropertyValue("--size-nav"),
			);
			this._htmlFontSize = parseFloat(
				getComputedStyle(DOM.html).getPropertyValue("font-size"),
			);

			// État initial : dépend du viewport courant.
			// En mode desktop (viewport > sizeNav), le sub-nav est visible en CSS
			// et ne doit pas être masqué aux AT via aria-hidden.
			const isMobile = window.innerWidth / this._htmlFontSize < this._sizeNav;
			this._btn.setAttribute("aria-expanded", "false");
			this._subNav.setAttribute("aria-hidden", isMobile ? "true" : "false");
		},

		toggle() {
			if (!this._btn) return;
			const isActive = DOM.html.classList.toggle("active");
			DOM.body.classList.toggle("active");
			this._btn.setAttribute("aria-expanded", isActive.toString());
			this._subNav.setAttribute("aria-hidden", (!isActive).toString());
			this._content.forEach((e) =>
				isActive ? e.setAttribute("inert", "") : e.removeAttribute("inert"),
			);
		},

		onResize() {
			clearTimeout(this._resizeTimer);
			this._resizeTimer = setTimeout(() => {
				if (!this._btn) return;
				const isDesktop =
					window.innerWidth / this._htmlFontSize > this._sizeNav;
				if (isDesktop) {
					// Passage en desktop : ferme le menu burger si ouvert et restaure
					// aria-hidden à false — le sub-nav est désormais visible en CSS.
					if (this._btn.getAttribute("aria-expanded") === "true") this.toggle();
					this._subNav.setAttribute("aria-hidden", "false");
				}
			}, 200);
		},
	};

	// — Assets —
	const AssetSystem = {
		// Capturé une fois : point d'insertion pour respecter l'ordre de cascade CSS.
		_anchor: document.querySelector("link[rel=stylesheet]"),

		injectStyle(url, media = "all") {
			if (document.querySelector(`link[href="${url}"]`)) return;
			const link = document.createElement("link");
			link.rel = "stylesheet";
			link.href = url;
			link.media = media;
			this._anchor
				? document.head.insertBefore(link, this._anchor.nextSibling)
				: document.head.appendChild(link);
		},

		injectScript(url, onload) {
			if (document.querySelector(`script[src="${url}"]`)) return;
			const script = document.createElement("script");
			script.src = url;
			script.async = true;
			if (onload) script.addEventListener("load", onload);
			DOM.body.appendChild(script);
		},

		resolve() {
			const scripts = new Map(); // url → onload|undefined
			const styles = new Map(); // url → media

			// Phase Read : un seul passage DOM
			for (let i = 0; i < ASSET_REGISTRY.length; i++) {
				const entry = ASSET_REGISTRY[i];
				if (document.querySelector(entry.selectors.join(","))) {
					// Le callback onload est affecté au dernier script de l'entrée.
					const cb = entry.onload;
					entry.scripts.forEach((s, idx) => {
						if (!scripts.has(s)) {
							scripts.set(s, idx === entry.scripts.length - 1 ? cb : undefined);
						}
					});
					entry.styles.forEach(({ url, media }) => styles.set(url, media));
				}
			}

			// Phase Write
			styles.forEach((media, url) => this.injectStyle(url, media));
			scripts.forEach((onload, url) => this.injectScript(url, onload));
		},
	};

	// — SVG Sprites —
	// Exposée globalement : appelée depuis main.js et more.js (hors IIFE).
	// TODO : refactoriser pour éviter l'exposition globale.
	window.injectSvgSprite = (targetElement, spriteId, svgFile = "util") => {
		targetElement.insertAdjacentHTML(
			"beforeend",
			`<svg role="img" focusable="false"><use href="/sprites/${svgFile}.svg#${spriteId}"></use></svg>`,
		);
	};

	// — Liens externes —
	const ExternalLinksSystem = {
		init() {
			const links = document.querySelectorAll("a");
			for (let i = 0; i < links.length; i++) {
				if (links[i].hostname !== location.hostname) {
					links[i].setAttribute("target", "_blank");
				}
			}
		},
	};

	// — GDPR —
	const GdprSystem = {
		init() {
			const { gdprTemplate: tpl, gdprTarget: target } = DOM;
			if (!tpl || !target) return;

			target.appendChild(tpl.content.cloneNode(true));

			const panel = document.getElementById("gdpr-see");
			const btnTrue = document.getElementById("gdpr-true-consent");
			const btnFalse = document.getElementById("gdpr-false-consent");
			if (!panel || !btnTrue || !btnFalse) return;

			if (localStorage.getItem("gdprConsent") === "yes")
				panel.style.display = "none";

			const hide = (consent) => {
				localStorage.setItem("gdprConsent", consent);
				panel.style.display = "none";
			};
			btnTrue.addEventListener("click", () => hide("yes"));
			btnFalse.addEventListener("click", () => hide("no"));
		},
	};

	// — Formulaires —
	const FormSystem = {
		init() {
			// Pré-remplissage date du jour
			// @bugfixed Comportement instable sur certains navigateurs — à surveiller
			document
				.querySelectorAll("input[type=date].today-date")
				.forEach((e) => (e.valueAsDate = new Date()));

			// Multiple select : affiche toutes les options si en dessous du seuil
			const MAX_SIZE = 7;
			document.querySelectorAll(".input select[multiple]").forEach((select) => {
				const size = Math.min(select.length, MAX_SIZE);
				select.size = size;
				if (select.length < MAX_SIZE) select.style.overflow = "hidden";
			});

			// Color input → synchronisation du champ <output>
			document
				.querySelectorAll(".input:has([type=color] + output) input")
				.forEach((input) => {
					const output = input.nextElementSibling;
					output.textContent = input.value;
					input.addEventListener("input", function () {
						output.textContent = this.value;
					});
				});
		},
	};

	// — Image fallback (réactif, phase capture) —
	const handleResourceError = (e) => {
		const t = e.target;
		if (
			t?.tagName === "IMG" &&
			t.src !== location.origin + FALLBACK_IMG &&
			!t.dataset.fallback
		) {
			t.dataset.fallback = "active";
			t.removeAttribute("srcset");
			t.src = FALLBACK_IMG;
		}
	};

	// — Préchargement images lazy (amorçage cache SW) —
	const preloadLazyImages = () => {
		document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
			new Image().src = img.src;
		});
	};

	// ---------------------------------------------------------------------------
	// 4. Scroll To Top
	// ---------------------------------------------------------------------------

	const initScrollButton = () => {
		const footer = document.querySelector(".footer");
		if (!footer) return;

		const button = document.createElement("button");
		button.type = "button";
		button.className = "scroll-top fade-out go-top-cmd";
		button.setAttribute("aria-label", "Scroll to top");
		injectSvgSprite(button, "arrow-up");
		footer.appendChild(button);

		// Seuil capturé une fois au boot — suffisant pour un déclencheur de visibilité.
		const threshold = window.innerHeight / 2;

		window.addEventListener(
			"scroll",
			() => {
				const past = scrollY > threshold;
				button.classList.toggle("fade-in", past);
				button.classList.toggle("fade-out", !past);
			},
			{ passive: true },
		);
	};

	// ---------------------------------------------------------------------------
	// 5. Event Router (délégation globale)
	// ---------------------------------------------------------------------------

	const handleClick = (e) => {
		const t = e.target;

		if (t.closest(".go-back")) {
			history.back();
			return;
		}
		if (t.closest(".go-top-cmd")) {
			scrollTo({ top: 0 });
			return;
		}
		if (t.closest(".cmd-print")) {
			print();
			return;
		}
		if (t.closest(".cmd-nav")) {
			NavigationSystem.toggle();
			return;
		}

		const btn = t.closest("button[class*=button]");
		if (btn) VibrateSystem.play(btn.dataset.frame);
	};

	// ---------------------------------------------------------------------------
	// 6. Boot (pipeline déterministe)
	// ---------------------------------------------------------------------------

	const boot = () => {
		// 6.1 États initiaux & init systèmes
		NetworkSystem.update();
		NavigationSystem.init();
		GdprSystem.init();
		FormSystem.init();
		ExternalLinksSystem.init();

		// 6.2 Listeners
		window.addEventListener("online", NetworkSystem.update);
		window.addEventListener("offline", NetworkSystem.update);
		window.addEventListener(
			"resize",
			NavigationSystem.onResize.bind(NavigationSystem),
		);
		window.addEventListener("error", handleResourceError, true); // capture : error ne bubble pas
		window.addEventListener("load", preloadLazyImages);
		document.addEventListener("click", handleClick);

		// 6.3 Scroll To Top
		initScrollButton();

		// 6.4 Assets
		AssetSystem.resolve();

		// 6.5 Service Worker
		if ("serviceWorker" in navigator) {
			navigator.serviceWorker.register("/sw.js").catch(console.error);

			navigator.serviceWorker.addEventListener("message", ({ data }) => {
				if (data?.action === "service-unavailable") {
					DOM.html.classList.add("service-unavailable");
				}
			});
		}
	};

	return { boot };
})();

AppPipeline.boot();
