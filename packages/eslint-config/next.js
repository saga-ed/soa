import js from '@eslint/js'
import { FlatCompat } from '@eslint/eslintrc'

const compat = new FlatCompat({
    baseDirectory: import.meta.dirname,
})

/**
 * A custom ESLint configuration for libraries that use Next.js.
 * Updated to match Next.js recommendations with @eslint/eslintrc compatibility.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const nextJsConfig = [{
    ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "dist/**"]
}, js.configs.recommended, ...compat.extends('next/core-web-vitals', 'next/typescript')]
