// @see https://www.freecodecamp.org/news/what-is-postcss/

module.exports = {
  map: { inline: false },
  plugins: [
    // 1. PHASE D'INGESTION : Fournit le dictionnaire de macros à l'AST sans émettre de CSS
    require('@csstools/postcss-global-data')({
      files: ['styles/development/media.css'],
    }),

    // 2. PHASE DE BUNDLING : Résout les @import et structure la cascade native (@layer)
    require('postcss-import'),

    // 3. PHASE DE SUBSTITUTION AOT : Remplace les jetons --from/--to par les valeurs physiques
    require('postcss-custom-media')({
      preserve: false, // false = Élimine les définitions @custom-media mortes du livrable
    }),

    // 4. PHASE DE CALCUL : Traitement des variables de build restantes et réduction mathématique
    require('postcss-advanced-variables'),
    require('postcss-calc'),

    // 5. ENVIROUNEMENT DE PRODUCTION : Optimisations et polyfills de fin de pipeline
    ...(process.env.NODE_ENV === 'production'
      ? [
          require('postcss-preset-env')({
            stage: 4,
            features: {
              'nesting-rules': true, // Assure la compatibilité ascendante du nesting imbriqué
            },
          }),
          require('postcss-minify'), // Compression bare-metal du binaire final
        ]
      : []),
  ],
}
