/** Vite's `?raw` suffix: the file's text, inlined at build time. */
declare module '*?raw' {
  const content: string
  export default content
}
