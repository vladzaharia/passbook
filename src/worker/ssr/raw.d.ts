declare module '*?raw' {
  const text: string;
  export default text;
}

/** Stylesheets reached through shared components; the Worker build ignores them. */
declare module '*.css' {}
