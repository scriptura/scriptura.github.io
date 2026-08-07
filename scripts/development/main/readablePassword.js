/**
 * @summary Ajoute un bouton de bascule show/hide sur chaque champ password
 * ciblé par `.input > [type=password]`.
 *
 * @strategy
 * - AOT : collecte des cibles à l'initialisation via `querySelectorAll`.
 *   Aucune requête DOM au runtime.
 * - État porté par `input.type` (source de vérité unique). Pas de variable
 *   d'état externe, pas de désynchronisation possible.
 * - Remplacement SVG via `?.remove()` avant chaque `injectSvgSprite` :
 *   idempotent, aucune dépendance à l'état précédent du bouton.
 *
 * @architectural-decision
 * - Sélecteur `>` (enfant direct) et non ` ` (descendant) : le composant
 *   `.input` enveloppe directement l'`<input>`. Un sélecteur descendant
 *   permettrait des faux positifs si `.input` contient des structures
 *   imbriquées. Ce choix est un contrat avec le HTML généré.
 * - `injectSvgSprite` supposée disponible globalement. Guard `typeof` en
 *   protection défensive — ne résout pas la dépendance implicite.
 * - Labels "See password" / "Hide password" en dur : à externaliser dans un
 *   `data-attribute` ou un système i18n si le projet est multilingue.
 * - Pas de `DOMContentLoaded` : suppose exécution différée (`defer`) ou
 *   position en fin de `<body>`.
 */

function initReadablePassword() {
	const inputs = document.querySelectorAll(".input > [type=password]");
	if (!inputs.length) return;

	for (const input of inputs) {
		input.parentElement.classList.add("input-password");

		const button = document.createElement("button");
		button.type = "button";

		const labelShow = "See password";
		const labelHide = "Hide password";

		button.title = labelShow;
		button.setAttribute("aria-label", labelShow);

		input.after(button);

		if (typeof injectSvgSprite === "function") injectSvgSprite(button, "eye");

		button.addEventListener("click", () => {
			const isPassword = input.type === "password";
			input.type = isPassword ? "text" : "password";

			const label = isPassword ? labelHide : labelShow;
			const icon = isPassword ? "eye-blocked" : "eye";

			button.title = label;
			button.setAttribute("aria-label", label);

			button.querySelector("svg")?.remove();
			if (typeof injectSvgSprite === "function") injectSvgSprite(button, icon);
		});
	}
}

initReadablePassword();
