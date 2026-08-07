/**
 * @module DisclosureSystem
 * @version 1.0.0
 * @author Olivier C
 * * --- RAISON D'ÊTRE & VISION ARCHITECTURALE ---
 * Ce moteur traite les Onglets (.tabs) et les Accordéons (.accordion) comme une seule
 * entité logique : le "Système de Divulgation". L'objectif est de réduire la dette
 * technique en unifiant la gestion des états, de l'accessibilité et de la persistance.
 * * --- ARBITRAGES TECHNIQUES ---
 * * 1. TRANSFORMATION JIT (Just-In-Time) :
 * - Arbitrage : Utiliser <details>/<summary> comme source de données pure (HTML-first)
 * et les transmuter en composants ARIA complexes au runtime.
 * - Pourquoi : Garantit un contenu accessible et indexable même sans JS, tout en
 * offrant une expérience utilisateur riche (animations, persistence) avec JS.
 * * 2. STATE ENGINE AGNOSTIQUE :
 * - Arbitrage : Le gestionnaire d'état s'attache à la structure (native ou générée)
 * via des contrats d'attributs stricts (role, aria-controls, aria-expanded).
 * - Pourquoi : Découple la logique de l'implémentation DOM. Le moteur ne "connaît" pas
 * les éléments, il ne connaît que leurs relations contractuelles et leurs états.
 * * 3. HYBRIDATION 'UNTIL-FOUND' vs 'LEGACY' :
 * - Arbitrage : Emploi de hidden="until-found" pour les navigateurs modernes.
 * - Pourquoi : Permet au navigateur de "révéler" automatiquement le contenu lors
 * d'une recherche (CTRL+F), ce que display: none interdit. Le script bascule
 * sur aria-hidden="true" uniquement comme fallback pour conserver le masquage CSS.
 * * 4. SÉPARATION DES PRÉOCCUPATIONS (Logic vs Motion) :
 * - Arbitrage : Le JavaScript se limite exclusivement à la gestion et à la distribution
 * des états. Il délègue l'intégralité de la cinétique (animations, transitions) au CSS.
 * - Pourquoi : Optimise les performances (accélération matérielle) et permet de modifier
 * l'aspect visuel sans jamais toucher au code source du moteur.
 * * 5. PERSISTENCE CONTEXTUELLE :
 * - Arbitrage : Stockage par 'slug' (chemin URL) dans le localStorage.
 * - Pourquoi : Permet à l'utilisateur de retrouver son interface exactement comme
 * il l'a laissée lors d'un retour arrière ou d'un rafraîchissement.
 * * 6. DÉTERMINISME DES IDENTITÉS :
 * - Arbitrage : IDs générés de manière prédictive (t-0-1, a-0-2).
 * - Pourquoi : Assure un mapping stable entre les triggers et les panels sans
 * dépendre du contenu textuel, facilitant la prévisibilité du pipeline de rendu.
 * * 7. PIPELINE D'ANIMATION EN DEUX TEMPS (accordéon uniquement) :
 * - Arbitrage : L'ouverture et la fermeture d'un panel suivent des séquences de mutation
 * DOM strictement ordonnées, séparées autour de la mesure du scrollHeight.
 * - Ouverture : syncState révèle le panel (retire hidden/aria-hidden) AVANT d'appeler
 * animatePanel, afin que scrollHeight soit non-nul et calculable.
 * - Fermeture : animatePanel capture scrollHeight AVANT toute mutation d'attribut,
 * commit cette valeur en inline, puis délègue le masquage à un requestAnimationFrame.
 * Au cycle suivant, l'inline est retiré et aria-hidden posé atomiquement : le CSS
 * dispose d'un point de départ connu pour calculer la transition vers 0.
 * - Pourquoi : Garantit une transition CSS pilotée par des valeurs réelles de layout,
 * sans aucune hauteur fixe codée en dur, et sans figement post-animation.
 * * 8. SÉQUENÇAGE aria-hidden → until-found À LA FERMETURE :
 * - Arbitrage : hidden="until-found" n'est jamais le déclencheur de la transition CSS
 * de fermeture. C'est aria-hidden="true" qui pilote la transition (via le sélecteur
 * CSS [aria-hidden="true"] { max-height: 0 }). hidden="until-found" est posé
 * uniquement dans le callback transitionend, après que l'animation soit terminée.
 * - Pourquoi : hidden="until-found" active un masquage natif navigateur
 * (content-visibility) qui est instantané et écrase toute transition en cours.
 * L'utiliser comme déclencheur couperait l'animation. Le poser post-transitionend
 * préserve à la fois l'animation et la recherche CTRL+F.
 * * 9. MODE SINGLETAB (accordéon exclusif) :
 * - Arbitrage : L'attribut natif HTML name sur les éléments <details> est la source
 * de vérité pour déclarer un accordéon en mode exclusif (un seul panel ouvert à la
 * fois). La transformation JIT détecte cet attribut et injecte data-singletab sur
 * le container, qui devient l'attribut canonique consommé par syncState.
 * - Pourquoi : name sur <details> est le standard HTML natif pour grouper des
 * accordéons exclusifs (spécifié et implémenté en premier par Chrome). Le réutiliser
 * évite d'inventer une convention propriétaire. data-singletab sur le container est
 * l'attribut observable dans le DOM transformé, utilisable en CSS et en tests.
 * * 10. RÉSILIENCE DU STOCKAGE :
 * - Arbitrage : Toutes les opérations localStorage sont encapsulées dans try/catch.
 * En cas d'échec (navigation privée iOS, quota dépassé, politique de sécurité),
 * le moteur se dégrade silencieusement : getStoredState retourne un état vide en
 * mémoire volatile, saveStoredState échoue sans exception. L'interface reste
 * entièrement fonctionnelle, sans persistance pour la durée de la session.
 * - Pourquoi : Sur iOS en navigation privée, localStorage.setItem lève une exception
 * de quota dépassé. Sans protection, le script crashe et casse toute l'interface.
 * * 11. NAVIGATION CLAVIER DES ONGLETS (ARIA 1.1) :
 * - Arbitrage : La navigation intra-tablist est déléguée aux touches fléchées
 * (ArrowLeft, ArrowRight, Home, End), conformément à la spec ARIA 1.1.
 * La touche Tab gère uniquement le focus entre zones (tablist → panel → suite).
 * L'écouteur est posé sur le tablist (délégation), pas sur chaque tab.
 * - Pourquoi : Un role="tab" sans navigation par flèches est une non-conformité
 * ARIA détectée par les audits d'accessibilité automatisés (axe, Lighthouse).
 * La délégation sur le tablist est plus performante qu'un écouteur par tab et
 * reste correcte si des tabs sont ajoutés dynamiquement.
 * * 12. DÉCISION DIFFÉRÉE — MutationObserver (SPA / Ajax) :
 * - Contexte : Le moteur initialise une seule fois au chargement de la page.
 * Toute injection de nouveaux .tabs ou .accordion via Ajax ou un routeur SPA
 * produit des composants non transformés et non liés.
 * - Stratégie envisagée : Un MutationObserver sur document.body détectant les
 * ajouts de nœuds portant .tabs ou .accordion, déclenchant transform() + binding
 * uniquement sur les nouveaux containers (idempotence à garantir via un attribut
 * sentinelle, ex. data-disclosure-ready).
 * - Pourquoi différé : Cette logique est transversale à plusieurs composants et
 * doit être conçue comme une couche d'orchestration globale, partagée avec
 * d'autres scripts, plutôt que greffée localement ici.
 */

const disclosureSystem = () => {
	const slug = window.location.pathname;
	const STATE_KEY = "uiState";
	const SUPPORTS_UNTIL_FOUND = "onbeforematch" in window;

	// --- DAL (Data Access Layer) ---
	const getStoredState = () => {
		try {
			const stored = localStorage.getItem(STATE_KEY);
			const parsed = stored ? JSON.parse(stored) : { uiState: {} };
			if (!parsed.uiState[slug]) parsed.uiState[slug] = {};
			return parsed;
		} catch {
			// localStorage indisponible (navigation privée iOS, quota dépassé, etc.)
			// Dégradation silencieuse : état en mémoire volatile, pas de persistance.
			return { uiState: { [slug]: {} } };
		}
	};

	const saveStoredState = (state) => {
		try {
			localStorage.setItem(STATE_KEY, JSON.stringify(state));
		} catch {
			// Échec silencieux — la session reste fonctionnelle, sans persistance.
		}
	};

	// --- Animation Engine (The Painter) ---
	const animatePanel = (panel, isOpening) => {
		// Accordéons uniquement — les tab-panels ne transitent pas par ici
		if (!panel.classList.contains("accordion-panel")) return;

		if (isOpening) {
			// Panel déjà révélé par syncState → scrollHeight lisible
			panel.style.maxHeight = "0px";
			panel.offsetHeight; // Force reflow — commit le point de départ
			panel.style.maxHeight = `${panel.scrollHeight}px`;

			const onEnd = () => {
				// removeAttribute libère le panel (flexible au resize / injection de contenu)
				panel.removeAttribute("style");
				panel.removeEventListener("transitionend", onEnd);
			};
			panel.addEventListener("transitionend", onEnd);
		} else {
			// Panel encore visible → scrollHeight > 0, commit le point de départ
			panel.style.maxHeight = `${panel.scrollHeight}px`;

			// rAF : retire l'inline ET pose aria-hidden atomiquement.
			// aria-hidden='true' pilote la transition CSS (max-height: 0 via [aria-hidden='true']).
			// hidden='until-found' ne peut pas être le déclencheur : son masquage natif navigateur
			// est instantané et couperait la transition avant qu'elle ne s'exécute.
			requestAnimationFrame(() => {
				panel.removeAttribute("style");
				panel.setAttribute("aria-hidden", "true");
			});

			// Après la transition : upgrade vers until-found si supporté (active CTRL+F).
			// C'est ici seulement que le masquage natif navigateur peut être posé sans dommage.
			const onEnd = () => {
				if (SUPPORTS_UNTIL_FOUND) {
					panel.removeAttribute("aria-hidden");
					panel.hidden = "until-found";
				}
				panel.removeEventListener("transitionend", onEnd);
			};
			panel.addEventListener("transitionend", onEnd);
		}
	};

	// --- Phase 1 : Transformation (JIT Layout) ---
	const transform = (container, cIdx) => {
		const isTabs = container.classList.contains("tabs");
		const rawEntities = container.querySelectorAll(":scope > details");
		if (rawEntities.length === 0) return;

		let tabList = null;
		if (isTabs) {
			tabList = document.createElement("div");
			tabList.setAttribute("role", "tablist");
			tabList.className = "tab-list";
		}

		// Signal source : name sur les summaries → injection de data-singletab sur le container.
		// Attribut canonique observable dans le DOM transformé (CSS, devtools, tests).
		const hasNamedSummary = Array.from(rawEntities).some((d) =>
			d.hasAttribute("name"),
		);
		if (hasNamedSummary && !isTabs)
			container.setAttribute("data-singletab", "");

		rawEntities.forEach((details, eIdx) => {
			const summary = details.querySelector(":scope > summary");
			const content = details.querySelector(":scope > :not(summary)");
			const entityId = `${isTabs ? "t" : "a"}-${cIdx}-${eIdx}`;

			const btn = document.createElement("button");
			btn.id = `btn-${entityId}`;
			btn.type = "button";
			btn.className = isTabs ? "tab-summary" : "accordion-summary";
			btn.setAttribute("role", isTabs ? "tab" : "button");
			btn.setAttribute("aria-controls", `pnl-${entityId}`);
			btn.innerHTML = summary.innerHTML;

			content.id = `pnl-${entityId}`;
			content.classList.add(isTabs ? "tab-panel" : "accordion-panel");
			content.setAttribute("role", isTabs ? "tabpanel" : "region");
			content.setAttribute("aria-labelledby", btn.id);

			if (isTabs) {
				tabList.appendChild(btn);
				container.appendChild(content);
			} else {
				const wrapper = document.createElement("div");
				wrapper.className = "accordion-details";
				wrapper.appendChild(btn);
				wrapper.appendChild(content);
				container.appendChild(wrapper);
			}
			details.remove();
		});

		if (isTabs) container.prepend(tabList);
	};

	// --- Phase 2 : State Engine ---
	const syncState = (targetTrigger, container, useAnimation = true) => {
		const isTabs = container.classList.contains("tabs");
		const isExclusive = isTabs || container.hasAttribute("data-singletab");

		const triggers = container.querySelectorAll(
			isTabs ? ':scope > .tab-list > [role="tab"]' : ".accordion-summary",
		);
		const fullState = getStoredState();

		const willBeOpen = isTabs
			? true
			: targetTrigger.getAttribute("aria-expanded") !== "true";

		triggers.forEach((trigger) => {
			const panel = document.getElementById(
				trigger.getAttribute("aria-controls"),
			);
			const currentlyOpen = trigger.getAttribute("aria-expanded") === "true";
			const shouldOpen =
				trigger === targetTrigger
					? willBeOpen
					: isExclusive
						? false
						: currentlyOpen;
			const isChanging = shouldOpen !== currentlyOpen;

			// FERMETURE animée (accordion) : capturer scrollHeight avant toute mutation.
			// animatePanel devient owner du masquage (posé dans le rAF au cycle suivant).
			if (isChanging && !shouldOpen && useAnimation) animatePanel(panel, false);

			// Mutation des attributs trigger
			trigger.setAttribute("aria-expanded", shouldOpen);
			if (isTabs) {
				trigger.setAttribute("aria-selected", shouldOpen);
				trigger.disabled = shouldOpen;
			}

			if (shouldOpen) {
				// Révélation synchrone — scrollHeight devient lisible pour animatePanel
				panel.removeAttribute("hidden");
				panel.removeAttribute("aria-hidden");
				fullState.uiState[slug][trigger.id] = "open";

				// OUVERTURE animée : panel révélé, scrollHeight > 0
				if (isChanging && useAnimation) animatePanel(panel, true);
			} else {
				// Masquage immédiat dans deux cas :
				// - tabs : animatePanel est inopérant (pas un accordion-panel)
				// - useAnimation=false : beforematch, restauration init
				// Cas accordion animé : masquage délégué au rAF dans animatePanel(false)
				if (!useAnimation || isTabs) {
					if (SUPPORTS_UNTIL_FOUND) panel.hidden = "until-found";
					else panel.setAttribute("aria-hidden", "true");
				}
				fullState.uiState[slug][trigger.id] = "close";
			}
		});

		saveStoredState(fullState);
	};

	// --- Navigation clavier (tabs uniquement) ---
	// Spec ARIA 1.1 : les role="tab" sont navigables par flèches au sein du tablist.
	// Tab/Shift+Tab gère le focus entre zones — les flèches gèrent le focus intra-tablist.
	const bindTabKeyboard = (container) => {
		const tabList = container.querySelector(":scope > .tab-list");
		if (!tabList) return;

		tabList.addEventListener("keydown", (e) => {
			const tabs = [
				...tabList.querySelectorAll('[role="tab"]:not([disabled])'),
			];
			const current = document.activeElement;
			const idx = tabs.indexOf(current);
			if (idx === -1) return;

			let next = null;
			if (e.key === "ArrowRight") next = tabs[(idx + 1) % tabs.length];
			else if (e.key === "ArrowLeft")
				next = tabs[(idx - 1 + tabs.length) % tabs.length];
			else if (e.key === "Home") next = tabs[0];
			else if (e.key === "End") next = tabs[tabs.length - 1];
			else return;

			e.preventDefault();
			next.focus();
			syncState(next, container, false);
		});
	};

	// --- Initialisation ---
	const init = () => {
		const containers = document.querySelectorAll(".tabs, .accordion");
		const pageState = getStoredState().uiState[slug];

		containers.forEach((container, cIdx) => {
			transform(container, cIdx);

			const isTabs = container.classList.contains("tabs");
			const triggers = container.querySelectorAll(
				isTabs ? ':scope > .tab-list > [role="tab"]' : ".accordion-summary",
			);
			const panels = container.querySelectorAll(
				isTabs ? ":scope > .tab-panel" : ".accordion-panel",
			);

			if (isTabs) bindTabKeyboard(container);

			triggers.forEach((trigger) => {
				trigger.addEventListener("click", () =>
					syncState(trigger, container, true),
				);

				// Restauration de l'état (sans animation pour le premier rendu)
				if (pageState[trigger.id] === "open") {
					syncState(trigger, container, false);
				} else if (
					isTabs &&
					!Object.values(pageState).includes("open") &&
					trigger === triggers[0]
				) {
					syncState(trigger, container, false);
				} else {
					const pnl = document.getElementById(
						trigger.getAttribute("aria-controls"),
					);
					if (SUPPORTS_UNTIL_FOUND) pnl.hidden = "until-found";
					else pnl.setAttribute("aria-hidden", "true");
				}
			});

			if (SUPPORTS_UNTIL_FOUND) {
				panels.forEach((panel) => {
					panel.addEventListener("beforematch", () => {
						const trigger = document.getElementById(
							panel.getAttribute("aria-labelledby"),
						);
						// Recherche CTRL+F : ouverture instantanée, pas de transition de hauteur
						if (trigger) syncState(trigger, container, false);
					});
				});
			}
		});
	};

	init();
};

if (document.readyState === "loading")
	document.addEventListener("DOMContentLoaded", disclosureSystem);
else disclosureSystem();
