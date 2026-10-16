declare module 'postcss-less' {
  import type { Root } from 'postcss';
  const syntax: { parse: (css: string) => Root };
  export default syntax;
}
