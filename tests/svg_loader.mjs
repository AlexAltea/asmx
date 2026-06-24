// ESM resolve hook so Node can import modules that `import x from "*.svg"`
// (esbuild inlines those at build time; under node we stub them to "").
export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".svg"))
        return { url: "data:text/javascript,export%20default%20%22%22", shortCircuit: true };
    return nextResolve(specifier, context);
}
