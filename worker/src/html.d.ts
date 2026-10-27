// Wrangler bundles *.html imports as text (default module rules).
declare module "*.html" {
  const text: string;
  export default text;
}
