# Synthèse technique : Bug d'invalidation GPU (Blink) par collision entre l'API View Transitions et le Shadow DOM matériel

## 1. Le Symptôme

Lors d'une transition inter-documents (View Transitions), une page spécifique contenant des éléments `<input type="range">` subit un gel complet de sa rasterization. L'élément conteneur (`#main`) devient invisible (transparent) juste après la destruction des pseudo-éléments de transition.

**Comportement critique :** L'interaction utilisateur (un `.focus()` sur n'importe quel champ) force instantanément le recalcul et l'affichage de la page entière. La perte de focus (`.blur()`) renvoie immédiatement la page à son état invisible.

---

## 2. L'Anatomie du Problème (Pipeline de rendu Blink)

Le problème se situe au niveau de la synchronisation entre le **Thread de mise en page (Layout Thread)** et le **Thread de composition (Compositor Thread / GPU)** du moteur Blink (Chromium).

1. **La nature du Widget Native :** L'élément `input[type="range"]` n'est pas un nœud DOM passif. Il encapsule un _User-Agent Shadow DOM_ complexe (pistes, curseurs) et requiert l'allocation dynamique de calques de composition matériels (_Composited Layers_) dédiés pour assurer une interaction fluide à 60/120 Hz sur le GPU.
2. **Le mécanisme de capture de la Transition :** À l'activation d'une View Transition, le moteur applique temporairement un confinement strict (`contain: paint`) et un flag interne de suppression de peinture (**Paint Suppression**) sur le conteneur (`#main`). L'objectif est de figer l'arbre et de sérialiser ses pixels dans une texture globale pour exécuter le fondu enchaîné.

---

## 3. Le Mécanisme de Rupture (Le Deadlock Graphique)

La panne est provoquée par une désynchronisation de frames (_Race Condition_) lors du chargement de la page :

```
[Page Reveal] -> [Activation du Paint Suppression sur #main] -> [Capture du Snapshot]
                                  │
      Le GPU tente d'allouer les calques matériels du Shadow DOM (Range)
                                  │
                                  ▼
[Fin de la Transition] -> [Échec du Damage Tracking (Suivi des modifications)]
                                  │
       Le GPU conserve et affiche une texture parent vide / gelée

```

- **Défaut d'invalidation (Damage Tracking Failure) :** Si l'allocation mémoire ou le calcul géométrique des calques internes du widget `range` se finalise au micro-instant où le parent `#main` est sous confinement de peinture, le gestionnaire de calques de Blink s'enraye.
- Comme le parent a temporairement désactivé son flux de peinture, la mutation interne du widget n'arrive pas à marquer le calque de `#main` comme "sale" (_dirty_).
- **Le cycle gelé :** À la fin de la transition, les pseudo-éléments sont détruits et le navigateur lève le _Paint Suppression_. Cependant, n'ayant enregistré aucun signal de modification (_damage_) sur cette frame, le compositeur matériel réaffiche son dernier cache de texture valide pour `#main` : un état transparent et vide.
- **L'interruption par le Focus :** L'action de focus sur un élément de formulaire court-circuite le flux d'invalidation standard. Elle envoie une directive impérative `SetNeedsRepaint()` directement depuis le thread UI vers le GPU pour dessiner l'anneau d'interaction. Cela force une rasterization complète du sous-arbre, faisant réapparaître la page. Au _blur_, le compositeur bascule à nouveau sur son cache défaillant.

---

## 4. La Résolution : L'Isolation Déterministe

Le correctif consiste à imposer une étanchéité absolue de l'allocation mémoire des widgets avant même que l'API de transition n'intercepte l'arbre de rendu :

```css
[type='range'] {
  /* @bugfix View Transitions */
  /* @affected Chrome */
  /* @path Isolation du Shadow DOM pour le compositeur matériel Blink/WebKit. */
  /* Garantit que l'allocation mémoire du curseur n'interfère pas avec la capture de la texture du parent (#main) lors d'une transition. */
  isolation: isolate;
  will-change: transform;
  contain: layout paint;
}
```

### Rôle mécanique des directives :

- **`contain: layout paint;`** : Garantit que les limites de calcul de disposition et de peinture du widget sont strictement hermétiques. Le navigateur sait qu'aucune modification interne du `range` ne peut impacter la géométrie externe.
- **`isolation: isolate;`** : Force la création d'un contexte d'empilement (_Stacking Context_) indépendant, isolant l'élément sur l'axe Z.
- **`will-change: transform;`** : Indique explicitement au compositeur de pré-allouer la texture matérielle du widget dès le parsing initial, en amont du rendu.

Grâce à ce layout de données rigide, le navigateur résout l'instanciation des calques du Shadow DOM de manière asynchrone sans jamais interférer avec le calcul de la texture globale du parent lors de la transition. Le pipeline reste fluide et déterministe.
