import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  prettier,
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    // 与后端对齐：any 统一降为 warn，确需使用须注释说明（规范 S07）
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // 测试文件允许单文件定义多个内联组件（vue/one-component-per-file 仅约束业务组件）
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: { 'vue/one-component-per-file': 'off' },
  },
];
