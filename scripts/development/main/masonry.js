/**
 * @summary Moteur de grille Masonry optimisé pour le rendu haute performance.
 * @strategy
 * - Batch Processing : Séparation stricte des lectures (mesures) et des écritures (styles) pour éviter le Layout Thrashing.
 * - Precision-First Layout : Utilisation de getBoundingClientRect() pour une précision au sous-pixel, évitant les arrondis cumulatifs de clientHeight.
 * - Reactive Scheduling : Utilisation de ResizeObserver pour remplacer les écouteurs "resize" et "scroll" globaux, plus gourmands en CPU.
 * @architectural-decision
 * - Système de traitement par lots.
 * - Centralisation du calcul de la "ligne de référence" (Row Unit) pour minimiser les accès au ComputedStyle.
 * - L'arbitrage du "Row Unit" à 1px garantit une granularité maximale pour le data-layout.
 * @note Ce module est conçu pour être supprimé sans effet de bord dès que `display: grid-lanes`
 * sera activé par défaut dans les navigateurs cibles.
 */

{
	const CONFIG = {
		SELECTOR: ".masonry",
		ROW_UNIT: 1, // Unité de base pour la précision du span
		RESIZE_DEBOUNCE: 150,
	};

	/**
	 * Pipeline de redistribution (DOD Batch)
	 */
	const updateGrid = (container) => {
		const items = Array.from(container.children);
		if (!items.length) return;

		// 1. Invariant Acquisition (Lecture unique des propriétés de la grille)
		const style = window.getComputedStyle(container);
		const rowGap = parseInt(style.getPropertyValue("grid-row-gap")) || 0;

		// Switch temporaire pour mesurer le contenu réel (AOT Measurement)
		container.style.alignItems = "start";

		// 2. Data Gathering (Batch Read)
		// On mesure tout en une seule passe pour éviter de casser le flux de rendu
		const measurements = items.map((item) => ({
			entity: item,
			height: item.getBoundingClientRect().height,
		}));

		// 3. Command Buffer (Batch Write)
		// On applique toutes les modifications de style en une seule passe
		measurements.forEach(({ entity, height }) => {
			const rowSpan = Math.ceil((height + rowGap) / (CONFIG.ROW_UNIT + rowGap));
			entity.style.gridRowEnd = `span ${rowSpan}`;
		});

		// Restauration du layout
		container.style.alignItems = "stretch";
	};

	/**
	 * System Initialization
	 */
	const init = () => {
		const grids = document.querySelectorAll(CONFIG.SELECTOR);
		if (!grids.length) return;

		// Utilisation d'un ResizeObserver : remplace resize, scroll et le bug du lazy loading
		// car il détecte le changement de taille réel des éléments (ex: quand l'image arrive)
		const observer = new ResizeObserver((entries) => {
			entries.forEach((entry) => {
				// Debounce léger pour éviter la surcharge lors de redimensionnements fluides
				clearTimeout(entry.target._masonryTimer);
				entry.target._masonryTimer = setTimeout(() => {
					updateGrid(entry.target);
				}, CONFIG.RESIZE_DEBOUNCE);
			});
		});

		grids.forEach((grid) => {
			// Premier calcul synchrone
			updateGrid(grid);

			// Observation des mutations de taille du conteneur et des enfants critiques
			observer.observe(grid);

			// Observation spécifique des images pour corriger le conflit avec loading='lazy'
			grid.querySelectorAll("img").forEach((img) => {
				img.addEventListener("load", () => updateGrid(grid), { once: true });
			});
		});

		// Intégration avec les autres systèmes (Accordéons, etc.)
		document.addEventListener("transitionend", (e) => {
			const parentGrid = e.target.closest(CONFIG.SELECTOR);
			if (parentGrid) updateGrid(parentGrid);
		});
	};

	// Bootstrap
	if (document.readyState === "complete") {
		init();
	} else {
		window.addEventListener("load", init); // Le 'load' garantit que les images sont dimensionnées
	}
}
