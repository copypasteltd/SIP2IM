export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('../dist/') && specifier.endsWith('.js')) return nextResolve(specifier.replace('../dist/', '../src/').replace(/\.js$/, '.ts'), context);
  if (context.parentURL?.includes('/src/') && specifier.endsWith('.js')) {
    return nextResolve(specifier.slice(0, -3) + '.ts', context);
  }
  return nextResolve(specifier, context);
}
