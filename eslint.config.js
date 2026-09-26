import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'docs/.vitepress/cache/**',
      'docs/.vitepress/dist/**',
      'prototype/**',
      'scripts/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // C-Style Zero-Allocation rules enforced strictly on the core storage & VM engine
    files: [
      'src/engine/vm.ts',
      'src/engine/page.ts',
      'src/engine/buffer_pool.ts',
      'src/storage/crc32.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        // 1. Ban Array higher-order methods in hot paths (.map, .filter, .forEach, .reduce, etc.)
        {
          selector:
            'CallExpression[callee.property.name=/^(map|filter|forEach|reduce|flatMap|some|every)$/]',
          message:
            'Avoid Array prototype methods in the engine hot path. Use C-style indexed for-loops (for (let i = 0; i < len; i++)) to prevent function allocations.',
        },
        // 2. Ban for..of and for..in (these allocate iterator objects and symbol lookups)
        {
          selector: 'ForOfStatement, ForInStatement',
          message:
            'for..of and for..in allocate iterator objects. Use standard indexed loops (for (let i = 0; i < len; i++)).',
        },
        // 3. Ban closures and arrow functions inside loops
        {
          selector:
            ':matches(ForStatement, WhileStatement, DoWhileStatement) :matches(ArrowFunctionExpression, FunctionExpression)',
          message:
            'Do not define closures or functions inside loops. Keep helper functions at module level.',
        },
        // 4. Ban dynamic delete operations (de-optimizes V8 hidden classes)
        {
          selector: 'UnaryExpression[operator="delete"]',
          message:
            'Avoid delete operations as they mutate object shapes and cause V8 de-optimizations.',
        },
      ],
    },
  },
);
